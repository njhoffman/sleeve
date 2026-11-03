import { app, BrowserWindow, ipcMain, type BrowserWindowConstructorOptions, type Rectangle } from 'electron';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  backdropRunning, backdropStatePath, chooseMonitor, formatGeometry, overlayColors, overlayGeometry, parseShellArgs,
  readBackdropState, rendererUrl, type BackdropState, type ShellOptions
} from '../src/shell/layout.ts';
import { markOverlay } from './x11.ts';

// sleeve's window: the renderer sleeved serves, either as an overlay on the desktop (transparent, click-through,
// unmanaged, stacked by backdrop just above the wallpaper) or as a plain window that remembers where it was.
// Everything else (lyrics, keys, picks) is the page's, over its WebSocket to sleeved. The one channel from the shell
// to its page is one way and carries only the wallpaper colors behind the overlay (preload.cjs), which backdrop
// gives the window's owner and nobody else knows.

const log = (text: string) => process.stderr.write(`sleeve shell: ${text}\n`);
const RETRY_MS = 2000;

const webPreferences: BrowserWindowConstructorOptions['webPreferences'] = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  // Lyrics must keep time while the overlay is never focused
  backgroundThrottling: false
};

// Loads the renderer, again every two seconds while sleeved is not up yet; keeps the page on sleeved's origin
function load(window: BrowserWindow, url: string): void {
  const origin = new URL(url).origin;
  let reported = false;
  window.webContents.on('did-fail-load', (_event, code, description, failed, mainFrame) => {
    if (!mainFrame || code === -3) return;
    if (!reported) log(`cannot load ${failed} (${description}); retrying until sleeved answers`);
    reported = true;
    setTimeout(() => { if (!window.isDestroyed()) void window.loadURL(url); }, RETRY_MS);
  });
  window.webContents.on('did-finish-load', () => {
    if (reported) log('renderer loaded');
    reported = false;
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== origin) event.preventDefault();
  });
  void window.loadURL(url);
}

// The X window id behind a BrowserWindow (an XID, little-endian, in the first bytes of the handle)
function windowId(window: BrowserWindow): number {
  return window.getNativeWindowHandle().readUInt32LE(0);
}

function restack(): void {
  execFile('backdrop', ['restack'], (error, _stdout, stderr) => {
    if (error) log(`backdrop restack failed: ${stderr.trim() || error.message}`);
  });
}

// Follows backdrop's state.json: restacks when its daemon changes (a restart puts a new wallpaper at the bottom),
// and hands each new reading of the state to onState
function followBackdrop(statePath: string, pid: number, onState: (state: BackdropState) => void): FSWatcher | null {
  let current = pid;
  try {
    return watch(path.dirname(statePath), (_event, name) => {
      if (name !== path.basename(statePath)) return;
      const state = readBackdropState(statePath);
      if (!state || !backdropRunning(state)) return;
      onState(state);
      if (state.pid === current) return;
      current = state.pid;
      log(`backdrop restarted (pid ${current}); restacking`);
      setTimeout(restack, 500);
    });
  } catch (error) {
    log(`cannot watch ${statePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// Passes the wallpaper colors behind the overlay to its page (preload.cjs) whenever backdrop samples new ones, and
// when the page (re)loads and asks
function forwardColors(window: BrowserWindow, id: number, initial: BackdropState): (state: BackdropState) => void {
  let colors = overlayColors(initial, id);
  if (colors) log(`wallpaper behind the overlay: ${colors.background}, ${colors.main.length} main colors`);
  const send = () => { if (colors && !window.isDestroyed()) window.webContents.send('sleeve:colors', colors); };
  const wanted = (event: Electron.IpcMainEvent) => { if (event.sender === window.webContents) send(); };
  ipcMain.on('sleeve:colors-wanted', wanted);
  window.on('closed', () => ipcMain.off('sleeve:colors-wanted', wanted));
  return state => {
    const next = overlayColors(state, id);
    if (!next || JSON.stringify(next) === JSON.stringify(colors)) return;
    colors = next;
    log(`wallpaper behind the overlay: ${next.background}, ${next.main.length} main colors`);
    send();
  };
}

async function openOverlay(options: ShellOptions): Promise<BrowserWindow> {
  const statePath = backdropStatePath();
  const state = readBackdropState(statePath);
  if (!backdropRunning(state)) {
    log('backdrop is not running, so an overlay cannot be stacked under your windows; opening a window instead');
    return openWindow(options);
  }
  const monitor = chooseMonitor(state!.monitors, options.monitor);
  const bounds = options.geometry ?? (monitor ? overlayGeometry(monitor) : null);
  if (!bounds) throw new Error('backdrop lists no monitors; give --geometry');
  const window = new BrowserWindow({
    ...bounds,
    show: false,
    title: 'sleeve overlay',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: { ...webPreferences, preload: path.join(import.meta.dirname, 'preload.cjs') }
  });
  window.setIgnoreMouseEvents(true);
  const id = windowId(window);
  await markOverlay(id, options.position);
  const onState = forwardColors(window, id, state!);
  load(window, rendererUrl(options.url, 'overlay'));
  window.once('show', () => {
    restack();
    // The compositor and Chromium may map in stages; once more after they settle
    setTimeout(restack, 1000);
  });
  window.showInactive();
  log(`overlay ${formatGeometry(bounds)} on ${monitor?.name ?? 'the screen'}, ${options.position} the visualizer`);
  const watcher = followBackdrop(statePath!, state!.pid, onState);
  window.on('closed', () => watcher?.close());
  return window;
}

// Window mode: where it was last, as the window manager allows (i3 tiles it unless told to float it)
function boundsFile(): string {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'sleeve', 'window.json');
}

function savedBounds(): Rectangle | null {
  try {
    const bounds = JSON.parse(readFileSync(boundsFile(), 'utf8')) as Rectangle;
    return [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ? bounds : null;
  } catch {
    return null;
  }
}

function openWindow(options: ShellOptions): BrowserWindow {
  const window = new BrowserWindow({
    ...(savedBounds() ?? { width: 960, height: 720 }),
    title: 'sleeve',
    backgroundColor: '#0f1218',
    autoHideMenuBar: true,
    webPreferences
  });
  let timer: NodeJS.Timeout | null = null;
  const save = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (window.isDestroyed()) return;
      mkdirSync(path.dirname(boundsFile()), { recursive: true });
      writeFileSync(boundsFile(), JSON.stringify(window.getBounds()));
    }, 500);
  };
  window.on('moved', save);
  window.on('resized', save);
  load(window, rendererUrl(options.url, 'window'));
  return window;
}

app.whenReady().then(async () => {
  let options: ShellOptions;
  try {
    options = parseShellArgs(process.argv.slice(2));
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    app.exit(2);
    return;
  }
  try {
    await (options.mode === 'overlay' ? openOverlay(options) : openWindow(options));
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    app.exit(1);
  }
}, () => app.exit(1));

app.on('window-all-closed', () => app.quit());
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.quit());
