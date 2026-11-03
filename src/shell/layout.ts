import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_HOST, DEFAULT_PORT } from '../daemon/paths.ts';
import { validColors, type OverlayColors } from '../renderer/contrast.ts';

// What the Electron shell (shell/main.ts) decides before it opens a window: its options, whether backdrop runs,
// and where the overlay goes. Free of Electron, so it is tested and typechecked with the rest.
//
// backdrop's contract (Overlays in its docs/specs/visualizer.md): sleeve marks its window _BACKDROP_OVERLAY
// below|above and runs `backdrop restack` when the window maps and whenever backdrop's daemon pid in state.json
// changes. state.json also gives each monitor's place and its visualizer's geometry.

export type ShellMode = 'overlay' | 'window';
export type OverlayPosition = 'below' | 'above';

export interface ShellOptions {
  mode: ShellMode;
  url: string;
  // An explicit overlay geometry; otherwise the band above the visualizer
  geometry: Geometry | null;
  // The monitor the overlay goes on, by name (backdrop's, as xrandr names it); otherwise the primary one
  monitor: string | null;
  position: OverlayPosition;
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
      'estimate-words': { type: 'boolean' }
    }
  });
  const text = (name: string): string | undefined => (typeof values[name] === 'string' ? values[name] as string : undefined);
  const mode = values.window === true ? 'window' : text('mode') ?? 'overlay';
  if (mode !== 'overlay' && mode !== 'window') throw new Error(`Invalid --mode: ${mode} (overlay or window)`);
  const position = text('position') ?? 'below';
  if (position !== 'below' && position !== 'above') throw new Error(`Invalid --position: ${position} (below or above)`);
  const geometryText = text('geometry');
  const geometry = geometryText === undefined ? null : parseGeometry(geometryText);
  if (geometryText !== undefined && !geometry) throw new Error(`Invalid --geometry: ${geometryText} (WIDTHxHEIGHT+X+Y)`);
  const url = text('url') ?? DEFAULT_URL;
  try {
    new URL(url);
  } catch {
    throw new Error(`Invalid --url: ${url}`);
  }
  return { mode, url, geometry, monitor: text('monitor') ?? null, position, estimateWords: values['estimate-words'] === true };
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
    if (!named) throw new Error(`No monitor ${name} in backdrop's state (${monitors.map(monitor => monitor.name).join(', ') || 'none'})`);
    return named;
  }
  return monitors.find(monitor => monitor.primary) ?? monitors[0] ?? null;
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
export function rendererUrl(base: string, mode: ShellMode, estimateWords = false): string {
  const url = new URL(base);
  if (mode === 'overlay') url.searchParams.set('mode', 'overlay');
  if (estimateWords) url.searchParams.set('words', 'estimate');
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
