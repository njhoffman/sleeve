import { expect } from 'chai';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  backdropRunning, backdropStatePath, chooseMonitor, DEFAULT_URL, formatGeometry, overlayColors, overlayGeometry, parseGeometry, parseShellArgs,
  readBackdropState, rendererUrl, type BackdropMonitor
} from '../../src/shell/layout.ts';

const dp3: BackdropMonitor = { name: 'DP-3', x: 0, y: 0, width: 1920, height: 1080, primary: true, visualizer: { geometry: '1920x270+0+810', running: true } };
const hdmi: BackdropMonitor = { name: 'HDMI-1', x: 1920, y: 0, width: 2560, height: 1440 };

describe('shell layout', () => {
  it('parses and formats X geometries', () => {
    expect(parseGeometry('1920x636+0+162')).to.deep.equal({ x: 0, y: 162, width: 1920, height: 636 });
    expect(parseGeometry('800x600-10-20')).to.deep.equal({ x: -10, y: -20, width: 800, height: 600 });
    for (const bad of ['1920x636', '0x10+0+0', 'axb+1+2', '']) expect(parseGeometry(bad), bad).to.equal(null);
    expect(formatGeometry({ x: -10, y: 162, width: 800, height: 600 })).to.equal('800x600-10+162');
  });

  it('takes its own options and lets Chromium\'s through', () => {
    expect(parseShellArgs([])).to.deep.equal({ mode: 'overlay', url: DEFAULT_URL, geometry: null, monitor: null, position: 'below' });
    expect(parseShellArgs(['--no-sandbox', '--window', '--url', 'http://127.0.0.1:7000/'])).to.deep.include({ mode: 'window', url: 'http://127.0.0.1:7000/' });
    expect(parseShellArgs(['--mode=overlay', '--geometry', '800x400+10+20', '--monitor', 'HDMI-1', '--position', 'above']))
      .to.deep.include({ geometry: { x: 10, y: 20, width: 800, height: 400 }, monitor: 'HDMI-1', position: 'above' });
    expect(() => parseShellArgs(['--mode', 'fullscreen'])).to.throw('Invalid --mode: fullscreen (overlay or window)');
    expect(() => parseShellArgs(['--position', 'middle'])).to.throw('Invalid --position: middle (below or above)');
    expect(() => parseShellArgs(['--geometry', 'big'])).to.throw('Invalid --geometry: big (WIDTHxHEIGHT+X+Y)');
    expect(() => parseShellArgs(['--url', 'nope'])).to.throw('Invalid --url: nope');
  });

  it('puts the overlay between 15% of the monitor and its visualizer, or 85% without one', () => {
    expect(overlayGeometry(dp3)).to.deep.equal({ x: 0, y: 162, width: 1920, height: 636 });
    expect(overlayGeometry(hdmi)).to.deep.equal({ x: 1920, y: 216, width: 2560, height: 1008 });
    // A visualizer at the top of the monitor (above the band) is not in the way
    expect(overlayGeometry({ ...dp3, visualizer: { geometry: '1920x100+0+0' } })).to.deep.equal({ x: 0, y: 162, width: 1920, height: 756 });
  });

  it('chooses the named monitor, else the primary one, else the first', () => {
    expect(chooseMonitor([hdmi, dp3], null)).to.equal(dp3);
    expect(chooseMonitor([hdmi], null)).to.equal(hdmi);
    expect(chooseMonitor([], null)).to.equal(null);
    expect(chooseMonitor([hdmi, dp3], 'HDMI-1')).to.equal(hdmi);
    expect(() => chooseMonitor([dp3], 'DP-1')).to.throw('No monitor DP-1 in backdrop\'s state (DP-3)');
  });

  it('reads backdrop\'s state and tells whether its daemon runs', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sleeve-backdrop-'));
    try {
      const file = path.join(dir, 'state.json');
      expect(readBackdropState(file)).to.equal(null);
      await writeFile(file, '{ broken');
      expect(readBackdropState(file)).to.equal(null);
      await writeFile(file, JSON.stringify({ pid: 4242, monitors: [dp3], version: '2.41.0' }));
      const state = readBackdropState(file);
      expect(state).to.deep.include({ pid: 4242, monitors: [dp3] });
      expect(backdropRunning(state, pid => pid === 4242)).to.equal(true);
      expect(backdropRunning(state, () => false)).to.equal(false);
      expect(backdropRunning(null)).to.equal(false);
      expect(backdropRunning({ pid: process.pid, monitors: [] })).to.equal(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(backdropStatePath({ XDG_RUNTIME_DIR: '/run/user/1000' })).to.equal('/run/user/1000/backdrop/state.json');
    expect(backdropStatePath({})).to.equal(null);
  });

  it('finds the colors backdrop sampled behind a window', () => {
    const colors = { background: '#3e323a', main: [{ color: '#1e151b', share: 0.5 }] };
    const state = { pid: 1, monitors: [hdmi, { ...dp3, overlays: [{ window: 7, colors: null }, { window: 9, colors }] }] };
    expect(overlayColors(state, 9)).to.deep.equal(colors);
    expect(overlayColors(state, 7)).to.equal(null);
    expect(overlayColors(state, 8)).to.equal(null);
    expect(overlayColors(null, 9)).to.equal(null);
  });

  it('asks the renderer for overlay mode in the URL', () => {
    expect(rendererUrl('http://127.0.0.1:6620/', 'overlay')).to.equal('http://127.0.0.1:6620/?mode=overlay');
    expect(rendererUrl('http://127.0.0.1:6620/', 'window')).to.equal('http://127.0.0.1:6620/');
  });
});
