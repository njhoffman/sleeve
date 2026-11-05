import { expect } from 'chai';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

// The real window under Xvfb, since the 1 px is Chromium's and only shows there. Needs the shell installed.
const shell = path.resolve(import.meta.dirname, '../../shell');
const electron = path.join(shell, 'node_modules/.bin/electron');
const run = promisify(execFile);
const installed = async (tool: string) => run('which', [tool]).then(() => true, () => false);

// Starts the shell on a 1280x720 screen, and prints the mapped window's size, then its size a moment later, then its size after a resize from outside
const SCRIPT = `
  "$ELECTRON" "$SHELL_ROOT" --no-sandbox --disable-gpu --managed --geometry "$GEOMETRY" --title sleeve-size-test --url http://127.0.0.1:9/ >/dev/null 2>&1 &
  shell=$!
  trap 'kill $shell 2>/dev/null' EXIT
  size() { xwininfo -name sleeve-size-test | awk '/Width:/ { w = $2 } /Height:/ { h = $2 } END { print w "x" h }'; }
  for attempt in $(seq 150); do
    xwininfo -name sleeve-size-test 2>/dev/null | grep -q IsViewable && break
    sleep 0.1
  done
  size
  sleep 1
  size
  xdotool search --name sleeve-size-test windowsize --sync 640 360
  sleep 0.3
  size
`;

async function sizes(geometry: string): Promise<string[]> {
  const { stdout } = await run('xvfb-run', ['-a', '-s', '-screen 0 1280x720x24', 'sh', '-c', SCRIPT], {
    env: { ...process.env, ELECTRON: electron, SHELL_ROOT: shell, GEOMETRY: geometry },
    timeout: 30_000
  });
  return stdout.trim().split('\n');
}

describe('the shell\'s window size', function () {
  this.timeout(40_000);

  before(async function () {
    const tools = await Promise.all(['xvfb-run', 'xwininfo', 'xdotool'].map(installed));
    if (!existsSync(electron) || tools.includes(false)) this.skip();
  });

  it('is exact at the size of the monitor, and takes a resize from outside', async () => {
    expect(await sizes('1280x720+0+0')).to.deep.equal(['1280x720', '1280x720', '640x360']);
  });

  it('is exact when smaller than the monitor', async () => {
    expect((await sizes('858x720+422+0')).slice(0, 2)).to.deep.equal(['858x720', '858x720']);
  });
});
