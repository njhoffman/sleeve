import { app, BrowserWindow, ipcMain, screen, type BrowserWindowConstructorOptions, type Rectangle } from 'electron';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  backdropRunning, backdropStatePath, chooseMonitor, chooseOverlay, formatGeometry, overlayColors, overlayGeometry, parseMonitors,
  parseShellArgs, readBackdropState, rendererUrl, waitForBackdrop, type BackdropMonitor, type BackdropState, type Geometry, type ShellOptions
} from '../src/shell/layout.ts';
import { compositorRunning, lowerWindow, markOverlay, sizeWindow, stackSelf } from './x11.ts';
import { validColors } from '../src/renderer/contrast.ts';

// sleeve's window: the renderer sleeved serves, either as an overlay on the desktop (transparent, click-through,
// unmanaged; stacked by backdrop just above the wallpaper, or by sleeve itself when backdrop does not run) or as a
// borderless window that remembers where it was.
// Everything else (lyrics, keys, picks) is the page's, over its WebSocket to sleeved. The one channel from the shell
// to its page is one way and carries only the wallpaper colors behind the overlay (preload.cjs), which backdrop
// gives the window's owner and nobody else knows.

const log = (text: string) => process.stderr.write(`sleeve shell: ${text}\n`);
// WM_CLASS "sleeve" (productName in package.json), for window manager rules (i3: for_window [class="sleeve"]
// floating enable). Chromium's profile stays in sleeve-shell, out of the way of sleeve's own ~/.config/sleeve.
app.setPath('userData', path.join(app.getPath('appData'), 'sleeve-shell'));
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

// The monitors xrandr lists (as backdrop names them), else Electron's displays
function monitors(): Promise<BackdropMonitor[]> {
  return new Promise(resolve => {
    execFile('xrandr', ['--listactivemonitors'], (error, stdout) => {
      const listed = error ? [] : parseMonitors(stdout);
      if (listed.length) return resolve(listed);
      const primary = screen.getPrimaryDisplay().id;
      resolve(screen.getAllDisplays().map(display => ({ name: display.label || String(display.id), ...display.bounds, primary: display.id === primary })));
    });
  });
}

// The transparent, click-through window both overlays use, unmanaged (and marked for backdrop when it stacks it)
async function overlayWindow(bounds: Geometry, mark: ShellOptions['position'] | null): Promise<BrowserWindow> {
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
  await markOverlay(windowId(window), mark);
  await sizeWindow(windowId(window), bounds.width, bounds.height);
  return window;
}

async function openOverlay(options: ShellOptions): Promise<BrowserWindow> {
  const statePath = backdropStatePath();
  let state = readBackdropState(statePath);
  if (!backdropRunning(state) && options.stack !== 'self' && options.waitBackdropS > 0) {
    log(`waiting up to ${options.waitBackdropS} s for backdrop`);
    state = await waitForBackdrop(() => readBackdropState(statePath), options.waitBackdropS * 1000) ?? state;
  }
  const backdrop = backdropRunning(state);
  const compositor = backdrop && options.stack !== 'self' ? true : await compositorRunning().catch(error => {
    log(`cannot tell whether a compositor runs: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  });
  const choice = chooseOverlay(options.stack, { backdrop, compositor });
  if (choice.kind === 'window') {
    log(choice.reason);
    return openWindow(options);
  }
  const monitor = chooseMonitor(choice.kind === 'backdrop' ? state!.monitors : await monitors(), options.monitor);
  const bounds = options.geometry ?? (monitor ? overlayGeometry(monitor) : null);
  if (!bounds) throw new Error('no monitors found; give --geometry');
  const where = `${formatGeometry(bounds)} on ${monitor?.name ?? 'the screen'}`;
  if (choice.kind === 'self') return openSelfOverlay(options, bounds, where);

  const window = await overlayWindow(bounds, options.position);
  const id = windowId(window);
  const onState = forwardColors(window, id, state!);
  load(window, rendererUrl(options.url, 'overlay', options.estimateWords, options));
  window.once('show', () => {
    restack();
    // The compositor and Chromium may map in stages; once more after they settle
    setTimeout(restack, 1000);
  });
  window.showInactive();
  log(`overlay ${where}, ${options.position} the visualizer`);
  const watcher = followBackdrop(statePath!, state!.pid, onState);
  window.on('closed', () => watcher?.close());
  return window;
}

// The overlay without backdrop: sleeve stacks it (shell/x11.ts), and the page has no wallpaper colors, so it
// keeps its shadowed text
async function openSelfOverlay(options: ShellOptions, bounds: Geometry, where: string): Promise<BrowserWindow> {
  const window = await overlayWindow(bounds, null);
  load(window, rendererUrl(options.url, 'overlay', options.estimateWords, options));
  window.once('show', () => {
    stackSelf(windowId(window), options.position, log).then(stacking => {
      setTimeout(() => stacking.restack(), 1000);
      window.on('closed', () => void stacking.close());
    }, error => log(`cannot stack the overlay: ${error instanceof Error ? error.message : String(error)}`));
  });
  window.showInactive();
  log(`overlay ${where}, stacked by sleeve ${options.position === 'above' ? 'over every window' : 'above the desktop'} (backdrop not used)`);
  return window;
}

// The overlay for a program that places it (--managed): it finds the window by --title, stacks it, and sends the
// wallpaper colors behind it down stdin, as one JSON object a line ({ background, main }). Nothing here touches stacking.
async function openManaged(options: ShellOptions): Promise<BrowserWindow> {
  const window = await overlayWindow(options.geometry!, null);
  if (options.title) {
    window.setTitle(options.title);
    window.on('page-title-updated', event => event.preventDefault());
  }
  let colors: unknown = null;
  const send = () => { if (colors && !window.isDestroyed()) window.webContents.send('sleeve:colors', colors); };
  const wanted = () => send();
  ipcMain.on('sleeve:colors-wanted', wanted);
  window.on('closed', () => ipcMain.off('sleeve:colors-wanted', wanted));
  createInterface({ input: process.stdin }).on('line', line => {
    try {
      const next = validColors(JSON.parse(line));
      if (!next) throw new Error('no background and main colors');
      colors = next;
      send();
    } catch (error) {
      log(`colors on stdin: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  load(window, rendererUrl(options.url, 'overlay', options.estimateWords, options));
  if (options.mapBelow) {
    // Before it maps, and again as it does, since Chromium may raise it then; after that it is the other program's to stack
    await lowerWindow(windowId(window));
    window.once('show', () => { lowerWindow(windowId(window)).catch(error => log(`cannot lower the window: ${error instanceof Error ? error.message : String(error)}`)); });
  }
  window.showInactive();
  log(`managed overlay at ${formatGeometry(options.geometry!)}${options.title ? `, titled ${options.title}` : ''}`);
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
    // Borderless: the window manager moves and sizes it
    frame: false,
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
  load(window, rendererUrl(options.url, 'window', options.estimateWords, options));
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
    await (options.managed ? openManaged(options) : options.mode === 'overlay' ? openOverlay(options) : openWindow(options));
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    app.exit(1);
  }
}, () => app.exit(1));

app.on('window-all-closed', () => app.quit());
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.quit());
