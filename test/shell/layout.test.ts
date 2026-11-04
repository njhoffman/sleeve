import { expect } from 'chai';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  backdropRunning, backdropStatePath, chooseMonitor, chooseOverlay, parseMonitors, waitForBackdrop, DEFAULT_URL, formatGeometry, overlayColors, overlayGeometry, parseGeometry, parseShellArgs,
  readBackdropState, rendererUrl, type BackdropMonitor
} from '../../src/shell/layout.ts';

const dp3: BackdropMonitor = { name: 'DP-3', x: 0, y: 0, width: 1920, height: 1080, primary: true, visualizer: { geometry: '1920x270+0+810', running: true } };
const hdmi: BackdropMonitor = { name: 'HDMI-1', x: 1920, y: 0, width: 2560, height: 1440 };

describe('the shell\'s managed mode', () => {
  it('needs a geometry, and is not a window', () => {
    expect(() => parseShellArgs(['--managed'])).to.throw('--managed needs --geometry');
    expect(() => parseShellArgs(['--managed', '--geometry', '800x600+0+0', '--window'])).to.throw('not a --window');
  });

  it('takes what a program gives it', () => {
    const options = parseShellArgs(['--managed', '--geometry', '800x600+10+20', '--title', 'backdrop-visualizer-DP-3-lyrics', '--instance', 'DP-3-lyrics', '--now', 'full', '--now-position', 'bottom-left', '--lyrics-align', 'center']);
    expect(options).to.deep.include({ managed: true, mode: 'overlay', title: 'backdrop-visualizer-DP-3-lyrics', instance: 'DP-3-lyrics', now: 'full', nowPosition: 'bottom-left', lyricsAlign: 'center' });
    expect(options.geometry).to.deep.equal({ x: 10, y: 20, width: 800, height: 600 });
    expect(parseShellArgs([])).to.deep.include({ managed: false, title: null, instance: null, now: null });
  });

  it('refuses a preset or place it does not know', () => {
    expect(() => parseShellArgs(['--now', 'huge'])).to.throw('Invalid --now: huge');
    expect(() => parseShellArgs(['--now-position', 'middle'])).to.throw('Invalid --now-position: middle');
    expect(() => parseShellArgs(['--lyrics-align', 'up'])).to.throw('Invalid --lyrics-align: up');
  });

  it('hands the page its instance and look in the URL', () => {
    const url = new URL(rendererUrl('http://127.0.0.1:6620/', 'overlay', false, { instance: 'DP-3 lyrics', now: 'full', nowPosition: 'top-right', lyricsAlign: 'right' }));
    expect(Object.fromEntries(url.searchParams)).to.deep.equal({ mode: 'overlay', instance: 'DP-3 lyrics', now: 'full', 'now-position': 'top-right', 'lyrics-align': 'right' });
  });
});

describe('shell layout', () => {
  it('parses and formats X geometries', () => {
    expect(parseGeometry('1920x636+0+162')).to.deep.equal({ x: 0, y: 162, width: 1920, height: 636 });
    expect(parseGeometry('800x600-10-20')).to.deep.equal({ x: -10, y: -20, width: 800, height: 600 });
    for (const bad of ['1920x636', '0x10+0+0', 'axb+1+2', '']) expect(parseGeometry(bad), bad).to.equal(null);
    expect(formatGeometry({ x: -10, y: 162, width: 800, height: 600 })).to.equal('800x600-10+162');
  });

  it('takes its own options and lets Chromium\'s through', () => {
    expect(parseShellArgs([])).to.deep.include({ mode: 'overlay', url: DEFAULT_URL, geometry: null, monitor: null, position: 'below', stack: 'auto', waitBackdropS: 0, estimateWords: false });
    expect(parseShellArgs(['--no-sandbox', '--window', '--url', 'http://127.0.0.1:7000/'])).to.deep.include({ mode: 'window', url: 'http://127.0.0.1:7000/' });
    expect(parseShellArgs(['--estimate-words']).estimateWords).to.equal(true);
    expect(parseShellArgs(['--mode=overlay', '--geometry', '800x400+10+20', '--monitor', 'HDMI-1', '--position', 'above']))
      .to.deep.include({ geometry: { x: 10, y: 20, width: 800, height: 400 }, monitor: 'HDMI-1', position: 'above' });
    expect(() => parseShellArgs(['--mode', 'fullscreen'])).to.throw('Invalid --mode: fullscreen (overlay or window)');
    expect(() => parseShellArgs(['--position', 'middle'])).to.throw('Invalid --position: middle (below or above)');
    expect(parseShellArgs(['--stack', 'self']).stack).to.equal('self');
    expect(parseShellArgs(['--wait-backdrop', '20']).waitBackdropS).to.equal(20);
    expect(() => parseShellArgs(['--wait-backdrop', 'soon'])).to.throw('Invalid --wait-backdrop: soon (seconds)');
    expect(() => parseShellArgs(['--stack', 'i3'])).to.throw('Invalid --stack: i3 (auto, backdrop or self)');
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
    expect(() => chooseMonitor([dp3], 'DP-1')).to.throw('No monitor DP-1 (DP-3)');
  });

  it('lets backdrop stack the overlay when it runs, else stacks it itself if a compositor runs, else opens a window', () => {
    const both = { backdrop: true, compositor: true };
    const neither = { backdrop: false, compositor: false };
    expect(chooseOverlay('auto', both)).to.deep.equal({ kind: 'backdrop' });
    expect(chooseOverlay('auto', { backdrop: false, compositor: true })).to.deep.equal({ kind: 'self' });
    expect(chooseOverlay('auto', neither)).to.deep.include({ kind: 'window' });
    expect((chooseOverlay('auto', neither) as { reason: string }).reason).to.match(/^backdrop is not running and no compositor runs/);
    // Forced: sleeve stacks it even when backdrop runs; backdrop only when it runs
    expect(chooseOverlay('self', both)).to.deep.equal({ kind: 'self' });
    expect((chooseOverlay('self', { backdrop: true, compositor: false }) as { reason: string }).reason).to.match(/^no compositor runs/);
    expect(chooseOverlay('backdrop', both)).to.deep.equal({ kind: 'backdrop' });
    expect(() => chooseOverlay('backdrop', neither)).to.throw('--stack backdrop, but backdrop is not running');
  });

  it('waits for backdrop to come up, as long as it is given', async () => {
    let clock = 0;
    const slept: number[] = [];
    const clocks = { intervalMs: 500, now: () => clock, sleep: async (ms: number) => { slept.push(ms); clock += ms; }, isAlive: () => true };
    const up = { pid: 42, monitors: [dp3] };
    // Up at the third look
    let looks = 0;
    expect(await waitForBackdrop(() => (++looks >= 3 ? up : null), 5000, clocks)).to.equal(up);
    expect(slept).to.deep.equal([500, 500]);
    // Never up: gives up at the timeout, its last wait cut short
    slept.length = 0;
    clock = 0;
    expect(await waitForBackdrop(() => null, 1200, clocks)).to.equal(null);
    expect(slept).to.deep.equal([500, 500, 200]);
  });

  it('reads the monitors xrandr lists, the primary one marked', () => {
    const text = 'Monitors: 2\n 0: +*DP-3 1920/522x1080/294+0+0  DP-3\n 1: +HDMI-1 2560/597x1440/336+1920-120  HDMI-1\n';
    expect(parseMonitors(text)).to.deep.equal([
      { name: 'DP-3', x: 0, y: 0, width: 1920, height: 1080, primary: true },
      { name: 'HDMI-1', x: 1920, y: -120, width: 2560, height: 1440 }
    ]);
    expect(parseMonitors('')).to.deep.equal([]);
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
    expect(rendererUrl('http://127.0.0.1:6620/', 'overlay', true)).to.equal('http://127.0.0.1:6620/?mode=overlay&words=estimate');
  });
});
