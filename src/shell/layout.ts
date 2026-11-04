import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_HOST, DEFAULT_PORT } from '../daemon/paths.ts';
import { LYRICS_ALIGNS, NOW_POSITIONS, NOW_PRESETS } from '../protocol/messages.ts';
import { validColors, type OverlayColors } from '../renderer/contrast.ts';

// What the Electron shell (shell/main.ts) decides before it opens a window: its options, whether backdrop runs,
// who stacks the overlay, and where it goes. Free of Electron, so it is tested and typechecked with the rest.
//
// Three modes: an overlay stacked by backdrop (when it runs), an overlay sleeve stacks itself (no backdrop, but a
// compositor to make it transparent: just above the root, or with --position above over every window), and a
// plain window. --managed is the overlay for a program that does it all (backdrop's sleeve engine, its
// docs/specs/sleeve.md): it opens at the geometry given, named as given, and stacks and marks nothing.
//
// backdrop's contract (Overlays in its docs/specs/visualizer.md): sleeve marks its window _BACKDROP_OVERLAY
// below|above and runs `backdrop restack` when the window maps and whenever backdrop's daemon pid in state.json
// changes. state.json also gives each monitor's place and its visualizer's geometry.

export type ShellMode = 'overlay' | 'window';
export type OverlayPosition = 'below' | 'above';
// Who stacks the overlay: backdrop, sleeve itself, or whichever can (backdrop first)
export type OverlayStack = 'auto' | 'backdrop' | 'self';

export interface ShellOptions {
  mode: ShellMode;
  // A program starts, places and stops this window
  managed: boolean;
  // The window's title, for that program to find it
  title: string | null;
  // What `sleeve ctl display --instance` calls this page (the page's ?instance=)
  instance: string | null;
  // The page's ?now=, ?now-position= and ?lyrics-align=
  now: string | null;
  nowPosition: string | null;
  lyricsAlign: string | null;
  url: string;
  // An explicit overlay geometry; otherwise the band above the visualizer
  geometry: Geometry | null;
  // The monitor the overlay goes on, by name (backdrop's, as xrandr names it); otherwise the primary one
  monitor: string | null;
  // Under backdrop: below or above its visualizer. Stacked by sleeve: just above the root, or over every window
  position: OverlayPosition;
  stack: OverlayStack;
  // In auto mode, how long to wait for backdrop to come up before stacking the overlay itself (seconds): at login
  // the overlay may start before backdrop does
  waitBackdropS: number;
  // Fill lines without word times word by word, estimated (the page's ?words=estimate)
  estimateWords: boolean;
}

export interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BackdropMonitor {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  primary?: boolean;
  // The visualizer's geometry, "WxH+X+Y"
  visualizer?: { geometry?: string; running?: boolean } | null;
  // The overlays backdrop stacked there, with the wallpaper colors behind each (null until sampled)
  overlays?: Array<{ window: number; colors?: unknown }>;
}

export interface BackdropState {
  pid: number;
  monitors: BackdropMonitor[];
}

export const DEFAULT_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}/`;

export function backdropStatePath(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, 'backdrop', 'state.json') : null;
}

// "1920x638+0+162" (the X geometry form; offsets may be negative)
export function parseGeometry(text: string): Geometry | null {
  const match = /^(\d+)x(\d+)([+-]\d+)([+-]\d+)$/.exec(text.trim());
  if (!match) return null;
  const [width, height, x, y] = match.slice(1).map(Number);
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export function formatGeometry({ x, y, width, height }: Geometry): string {
  const offset = (value: number) => (value < 0 ? `${value}` : `+${value}`);
  return `${width}x${height}${offset(x)}${offset(y)}`;
}

// The shell's own arguments; Chromium's (--no-sandbox and the like) pass through untouched
export function parseShellArgs(argv: string[]): ShellOptions {
  const { values } = parseArgs({
    args: argv,
    strict: false,
    allowPositionals: true,
    options: {
      mode: { type: 'string' },
      window: { type: 'boolean' },
      url: { type: 'string' },
      geometry: { type: 'string' },
      monitor: { type: 'string' },
      position: { type: 'string' },
      stack: { type: 'string' },
      'wait-backdrop': { type: 'string' },
      'estimate-words': { type: 'boolean' },
      managed: { type: 'boolean' },
      title: { type: 'string' },
      instance: { type: 'string' },
      now: { type: 'string' },
      'now-position': { type: 'string' },
      'lyrics-align': { type: 'string' }
    }
  });
  const text = (name: string): string | undefined => (typeof values[name] === 'string' ? values[name] as string : undefined);
  const mode = values.window === true ? 'window' : text('mode') ?? 'overlay';
  if (mode !== 'overlay' && mode !== 'window') throw new Error(`Invalid --mode: ${mode} (overlay or window)`);
  const position = text('position') ?? 'below';
  if (position !== 'below' && position !== 'above') throw new Error(`Invalid --position: ${position} (below or above)`);
  const stack = text('stack') ?? 'auto';
  if (stack !== 'auto' && stack !== 'backdrop' && stack !== 'self') throw new Error(`Invalid --stack: ${stack} (auto, backdrop or self)`);
  const waitText = text('wait-backdrop') ?? '0';
  const waitBackdropS = Number(waitText);
  if (!/^\d+(\.\d+)?$/.test(waitText) || !Number.isFinite(waitBackdropS)) throw new Error(`Invalid --wait-backdrop: ${waitText} (seconds)`);
  const geometryText = text('geometry');
  const geometry = geometryText === undefined ? null : parseGeometry(geometryText);
  if (geometryText !== undefined && !geometry) throw new Error(`Invalid --geometry: ${geometryText} (WIDTHxHEIGHT+X+Y)`);
  const url = text('url') ?? DEFAULT_URL;
  try {
    new URL(url);
  } catch {
    throw new Error(`Invalid --url: ${url}`);
  }
  const managed = values.managed === true;
  if (managed && !geometry) throw new Error('--managed needs --geometry');
  if (managed && mode === 'window') throw new Error('--managed is an overlay, not a --window');
  const known = (name: string, values: readonly string[]) => {
    const value = text(name) ?? null;
    if (value !== null && !values.includes(value)) throw new Error(`Invalid --${name}: ${value} (${values.join(', ')})`);
    return value;
  };
  const page = { title: text('title') ?? null, instance: text('instance') ?? null, now: known('now', NOW_PRESETS), nowPosition: known('now-position', NOW_POSITIONS), lyricsAlign: known('lyrics-align', LYRICS_ALIGNS) };
  return { managed, ...page, mode, url, geometry, monitor: text('monitor') ?? null, position, stack, waitBackdropS, estimateWords: values['estimate-words'] === true };
}

// backdrop's state, or null when it has none or it cannot be read
export function readBackdropState(file: string | null): BackdropState | null {
  if (!file) return null;
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as Partial<BackdropState>;
    return typeof state.pid === 'number' && Array.isArray(state.monitors) ? state as BackdropState : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs, as someone else
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Whether backdrop's daemon runs: its state names a live pid
export function backdropRunning(state: BackdropState | null, isAlive: (pid: number) => boolean = alive): boolean {
  return !!state && state.pid > 0 && isAlive(state.pid);
}

export function chooseMonitor(monitors: BackdropMonitor[], name: string | null): BackdropMonitor | null {
  if (name) {
    const named = monitors.find(monitor => monitor.name === name);
    if (!named) throw new Error(`No monitor ${name} (${monitors.map(monitor => monitor.name).join(', ') || 'none'})`);
    return named;
  }
  return monitors.find(monitor => monitor.primary) ?? monitors[0] ?? null;
}

// backdrop's state once its daemon runs, checking every intervalMs for up to timeoutMs; null if it never does
export async function waitForBackdrop(
  read: () => BackdropState | null, timeoutMs: number,
  { intervalMs = 500, now = Date.now, sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)), isAlive = alive } = {}
): Promise<BackdropState | null> {
  const end = now() + timeoutMs;
  for (;;) {
    const state = read();
    if (backdropRunning(state, isAlive)) return state;
    if (now() >= end) return null;
    await sleep(Math.min(intervalMs, end - now()));
  }
}

// How the overlay is shown: stacked by backdrop or by sleeve, or as a window when neither can, with why
export type OverlayChoice = { kind: 'backdrop' | 'self' } | { kind: 'window'; reason: string };

export function chooseOverlay(stack: OverlayStack, { backdrop, compositor }: { backdrop: boolean; compositor: boolean }): OverlayChoice {
  if (stack === 'backdrop' && !backdrop) throw new Error('--stack backdrop, but backdrop is not running');
  if (backdrop && stack !== 'self') return { kind: 'backdrop' };
  if (compositor) return { kind: 'self' };
  return {
    kind: 'window',
    reason: `${stack === 'self' ? '' : 'backdrop is not running and '}no compositor runs (picom or the like), so an overlay could not be transparent; opening a window instead`
  };
}

// The monitors `xrandr --listactivemonitors` lists, as backdrop names them:
//  0: +*DP-3 1920/522x1080/294+0+0  DP-3
export function parseMonitors(text: string): BackdropMonitor[] {
  const monitors: BackdropMonitor[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*\d+:\s+\+?(\*?)(\S+)\s+(\d+)\/\d+x(\d+)\/\d+([+-]\d+)([+-]\d+)/.exec(line);
    if (!match) continue;
    const [, star, name, width, height, x, y] = match;
    monitors.push({ name, x: Number(x), y: Number(y), width: Number(width), height: Number(height), ...(star ? { primary: true } : {}) });
  }
  return monitors;
}

// The default overlay: the monitor's full width, from 15% down to just above its visualizer (or to 85% of the
// height when it has none), so lyrics sit over the wallpaper and the bars stay clear of them
export function overlayGeometry(monitor: BackdropMonitor, gap = 12): Geometry {
  const top = monitor.y + Math.round(monitor.height * 0.15);
  const visualizer = monitor.visualizer?.geometry ? parseGeometry(monitor.visualizer.geometry) : null;
  const onMonitor = visualizer && visualizer.y > top && visualizer.y <= monitor.y + monitor.height;
  const bottom = onMonitor ? visualizer.y - gap : monitor.y + Math.round(monitor.height * 0.85);
  return { x: monitor.x, y: top, width: monitor.width, height: Math.max(100, bottom - top) };
}

// The renderer's URL for a mode (the overlay draws on a transparent page) and the options the page takes
export function rendererUrl(base: string, mode: ShellMode, estimateWords = false, page: Partial<Pick<ShellOptions, 'instance' | 'now' | 'nowPosition' | 'lyricsAlign'>> = {}): string {
  const url = new URL(base);
  if (mode === 'overlay') url.searchParams.set('mode', 'overlay');
  if (estimateWords) url.searchParams.set('words', 'estimate');
  if (page.instance) url.searchParams.set('instance', page.instance);
  if (page.now) url.searchParams.set('now', page.now);
  if (page.nowPosition) url.searchParams.set('now-position', page.nowPosition);
  if (page.lyricsAlign) url.searchParams.set('lyrics-align', page.lyricsAlign);
  return url.toString();
}

// The wallpaper colors backdrop sampled behind the window (its X id), or null until it has
export function overlayColors(state: BackdropState | null, window: number): OverlayColors | null {
  for (const monitor of state?.monitors ?? []) {
    const overlay = monitor.overlays?.find(entry => entry.window === window);
    if (overlay) return validColors(overlay.colors);
  }
  return null;
}
