import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { deflateSync } from 'node:zlib';
import pkg from '../../package.json' with { type: 'json' };
import { SHELL_ROOT, sandboxBlocked } from '../cli/shell.ts';
import { SleeveDaemon } from '../daemon/server.ts';
import { NowPlaying } from '../now/session.ts';
import { monotonic } from '../players/clock.ts';
import { PlayerHub } from '../players/hub.ts';
import { Listeners, type Playback, type Player } from '../players/types.ts';
import { averages, averagesTable, loadMeasurements, renderNanoseconds, saveMeasurement, sharePercent, type Measurement } from './gpu.ts';

// `just bench-gpu`: what each background costs the GPU, on this machine, in the real shell. It serves itself with a throwaway
// daemon (a fake player, placeholder lyrics and a made-up cover), so it needs no music and the same scene means the same
// thing each time. Results go in benchmarks/gpu.jsonl and the table shows the average of everything kept there.
//
// Scenes that are see-through run on top of the desktop, ignoring clicks, so the compositor's share means something; opaque
// ones run at the bottom of the stack so they do not cover it, which leaves the compositor out, so it is not reported for them.

const FILE = new URL('../../benchmarks/gpu.jsonl', import.meta.url).pathname;
// Not 6697 or the like: Chromium refuses ports on its unsafe list
const PORT = 6698;

interface Scene {
  name: string;
  // Nothing started: what runs without sleeve
  idle?: boolean;
  band?: boolean;
  below?: boolean;
  background?: string;
  css?: string;
}

const LEFT_THIRD = '33%x100%+0+0';
const SCENES: Scene[] = [
  { name: 'nothing running', idle: true },
  { name: 'band, transparent', band: true },
  { name: 'monitor, transparent', background: 'transparent' },
  { name: 'monitor, see-through color', below: true, background: '#10203099' },
  { name: 'monitor, still cover', below: true, background: 'cover' },
  { name: 'monitor, CSS drift', below: true, background: 'cover', css: '--art-animation: sleeve-art-drift;' },
  { name: 'monitor, flow', below: true, background: 'cover', css: '--art-animation: sleeve-art-flow;' },
  { name: 'monitor, flow at full size', below: true, background: 'cover', css: '--art-animation: sleeve-art-flow; --flow-resolution: 1; --flow-fps: 60;' }
];

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const command = (file: string, ...args: string[]) => {
  try {
    return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

function renderTime(pid: string): number {
  const dir = `/proc/${pid}/fdinfo`;
  const texts: string[] = [];
  try {
    for (const name of readdirSync(dir)) {
      try { texts.push(readFileSync(path.join(dir, name), 'utf8')); } catch { /* closed meanwhile */ }
    }
  } catch {
    return 0;
  }
  return renderNanoseconds(texts);
}

const pidsOf = (pattern: string) => command('pgrep', '--full', pattern).split('\n').filter(Boolean);

async function sample(seconds: number, renderers: string[], compositor: string | null) {
  const pids = [...renderers, ...(compositor ? [compositor] : [])];
  const before = new Map(pids.map(pid => [pid, renderTime(pid)]));
  const start = performance.now();
  await sleep(seconds * 1000);
  const elapsed = (performance.now() - start) / 1000;
  const share = (pid: string) => sharePercent(renderTime(pid) - before.get(pid)!, elapsed);
  return { renderer: renderers.reduce((sum, pid) => sum + share(pid), 0), compositor: compositor ? share(compositor) : null };
}

// A little PNG with the colors spread, so a cover has something to show
function coverPng(file: string): void {
  const size = 256;
  const rows = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1) + 1;
    for (let x = 0; x < size; x++) {
      rows[row + x * 3] = x;
      rows[row + x * 3 + 1] = y;
      rows[row + x * 3 + 2] = 255 - (x + y) / 2;
    }
  }
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (data: Buffer) => {
    let c = 0xffffffff;
    for (const byte of data) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]));
}

function benchPlayer(cover: string): Player {
  const listeners = new Listeners<Playback | null>();
  const now = monotonic();
  const playback: Playback = {
    player: 'bench', state: 'playing', positionMs: 0, at: now, rate: 1, changedAt: now,
    track: { key: 'bench', artist: 'Placeholder Artist', title: 'Placeholder Title', album: 'Placeholder Album', durationMs: 3_600_000, artUrl: `file://${cover}` }
  };
  return {
    name: 'bench', start() {}, ready: async () => {}, current: () => playback, problem: () => null,
    onChange: listener => listeners.add(listener), seek: async () => {}, close: async () => {}
  };
}

function primaryMonitor(): string {
  const line = command('xrandr', '--listactivemonitors').split('\n').find(text => /\*/.test(text));
  const match = line && /(\d+)\/\d+x(\d+)\/\d+\+(\d+)\+(\d+)/.exec(line);
  return match ? `${match[1]}x${match[2]}+${match[3]}+${match[4]}` : '1920x1080+0+0';
}

function bandOf(geometry: string): string {
  const [, width, height, x, y] = /(\d+)x(\d+)\+(\d+)\+(\d+)/.exec(geometry)!.map(Number);
  return `${width}x${Math.round(height * 0.7)}+${x}+${y + Math.round(height * 0.15)}`;
}

async function runScene(scene: Scene, seconds: number, monitor: string, styleFile: string, settle: number): Promise<Omit<Measurement, 'at' | 'version' | 'host' | 'gpu' | 'runner'>> {
  const compositor = pidsOf('^(/usr/local/bin/|/usr/bin/)?picom')[0] ?? null;
  const onTop = !scene.below;
  writeFileSync(styleFile, `:root { ${scene.css ?? ''} }\n`);
  if (scene.idle) {
    const { compositor: share } = await sample(seconds, [], compositor);
    return { scene: scene.name, geometry: '-', rendererPercent: 0, compositorPercent: share, startMs: null, stopMs: null };
  }
  const geometry = scene.band ? bandOf(monitor) : monitor;
  const title = `sleeve-bench-${process.pid}`;
  const known = new Set(pidsOf('electron.*--type=gpu-process'));
  const started = performance.now();
  const args = ['--managed', '--geometry', geometry, '--title', title, '--url', `http://127.0.0.1:${PORT}/`, '--instance', 'bench',
    ...(scene.band ? [] : ['--lyrics-area', LEFT_THIRD]), ...(scene.background ? ['--background', scene.background] : []), ...(scene.below ? ['--map-below'] : [])];
  const child = spawn(path.join(SHELL_ROOT, 'node_modules/.bin/electron'), [SHELL_ROOT, ...args], { stdio: 'ignore' });
  let startMs: number | null = null;
  for (let tries = 0; tries < 150 && startMs === null; tries++) {
    if (command('xdotool', 'search', '--name', `^${title}$`)) startMs = performance.now() - started;
    else await sleep(100);
  }
  await sleep(settle * 1000);
  const renderers = pidsOf('electron.*--type=gpu-process').filter(pid => !known.has(pid));
  const { renderer, compositor: share } = await sample(seconds, renderers, onTop ? compositor : null);
  const stopping = performance.now();
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
  const stopMs = performance.now() - stopping;
  await sleep(1000);
  return { scene: scene.name, geometry, rendererPercent: renderer, compositorPercent: share, startMs, stopMs };
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: {
    rounds: { type: 'string', default: '1' }, seconds: { type: 'string', default: '16' }, settle: { type: 'string', default: '5' },
    'no-save': { type: 'boolean', default: false }, show: { type: 'boolean', default: false }, scene: { type: 'string' }, geometry: { type: 'string' }
  } });
  if (values.show) {
    averagesTable(averages(loadMeasurements(FILE))).forEach(line => console.log(line));
    return 0;
  }
  if (!existsSync(path.join(SHELL_ROOT, 'node_modules/.bin/electron')) || sandboxBlocked(SHELL_ROOT)) {
    console.error('The shell cannot start here: run just shell-install, and just shell-sandbox once if AppArmor blocks it');
    return 2;
  }
  const rounds = Number(values.rounds), seconds = Number(values.seconds), settle = Number(values.settle);
  const scenes = SCENES.filter(scene => !values.scene || scene.name.includes(values.scene));
  const home = mkdtempSync(path.join(os.tmpdir(), 'sleeve-bench-'));
  const style = path.join(home, 'sleeve', 'style.css');
  mkdirSync(path.dirname(style), { recursive: true });
  writeFileSync(style, '');
  const cover = path.join(home, 'cover.png');
  coverPng(cover);
  process.env.XDG_CONFIG_HOME = home;
  const lines = Array.from({ length: 900 }, (_, index) => ({ time: index * 4000, text: `Placeholder line number ${index + 1}` }));
  const best = { provider: 'bench', id: '1', track: { artist: 'Placeholder Artist', title: 'Placeholder Title', durationMs: 3_600_000 }, lyrics: { synced: true, instrumental: false, lines }, score: 1, detail: { title: 1, artist: 1, album: null, duration: null } };
  const hub = new PlayerHub([benchPlayer(cover)]);
  hub.start();
  const session = new NowPlaying(hub, { prefetch: false, lookup: (async () => ({ best, candidates: [best], rejected: [], errors: [], pinned: false, offsetMs: 0 })) as never });
  session.start();
  const daemon = new SleeveDaemon(session, { port: PORT, socketPath: null, log: () => {} });
  await daemon.listen();
  const monitor = values.geometry ?? primaryMonitor();
  const gpu = /renderer string: (.*)/.exec(command('glxinfo', '-B'))?.[1] ?? 'unknown';
  console.error(`${rounds} round${rounds === 1 ? '' : 's'} of ${scenes.length} scenes at ${monitor}, about ${Math.round(rounds * scenes.length * (seconds + settle + 3))} s. Placeholder lyrics will show on the desktop; they ignore clicks.`);
  try {
    for (let round = 1; round <= rounds; round++) {
      for (const scene of scenes) {
        const result = await runScene(scene, seconds, monitor, style, settle);
        const measurement: Measurement = { at: new Date().toISOString(), version: pkg.version, host: os.hostname(), gpu, runner: 'electron', ...result };
        console.error(`round ${round}: ${scene.name}: ${(result.rendererPercent ?? 0).toFixed(1)}%${result.compositorPercent === null ? '' : `, compositor ${result.compositorPercent.toFixed(1)}%`}`);
        if (!values['no-save']) saveMeasurement(FILE, measurement);
      }
    }
  } finally {
    await daemon.close();
    session.close();
    rmSync(home, { recursive: true, force: true });
  }
  averagesTable(averages(loadMeasurements(FILE))).forEach(line => console.log(line));
  return 0;
}

process.exitCode = await main();
process.exit();
