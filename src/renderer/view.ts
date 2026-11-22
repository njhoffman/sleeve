import type { LyricsResult, ScoredCandidate } from '../core/types.ts';
import type { NowState } from '../now/state.ts';
import { LYRICS_ALIGNS, NOW_POSITIONS, NOW_PRESETS, parseArea, parseBackground, type AreaLength, type DisplayChange, type LyricsAlign, type NowPosition, type NowPreset } from '../protocol/messages.ts';
import type { OverlayColors } from './contrast.ts';

// What the renderer shows, worked out without the DOM, so it is tested in Node.

// Moves value toward target as a critically damped follow with time constant tauMs, the same whatever the frame
// rate, and picking up from wherever it is when the target moves (no restart, no jump)
export function follow(value: number, target: number, dtMs: number, tauMs: number): number {
  if (tauMs <= 0 || dtMs <= 0) return dtMs <= 0 ? value : target;
  const next = target + (value - target) * Math.exp(-dtMs / tauMs);
  return Math.abs(next - target) < 0.05 ? target : next;
}

// "+250 ms", "-1.2 s"
export function formatOffset(ms: number): string {
  const sign = ms > 0 ? '+' : ms < 0 ? '-' : '';
  const size = Math.abs(ms);
  return size >= 1000 ? `${sign}${(size / 1000).toFixed(size % 1000 ? 1 : 0)} s` : `${sign}${size} ms`;
}

export interface Status {
  // Artist - title, or why there is none
  title: string;
  // Where the lyrics came from, and the user's choices for them
  source: string;
  // Shown in place of lyrics
  message: string | null;
}

export function status(state: NowState, connected: boolean): Status {
  if (!connected) return { title: '', source: '', message: 'Waiting for sleeved' };
  const track = state.playback?.track;
  if (!track) return { title: '', source: '', message: 'Nothing playing' };
  const title = `${track.artist ? `${track.artist} - ` : ''}${track.title}`;
  const result = state.result;
  const best = result?.best;
  const source = best
    ? [best.provider, best.lyrics.synced ? null : 'unsynced', result!.pinned ? 'pinned' : null, result!.offsetMs ? formatOffset(result!.offsetMs) : null]
      .filter(Boolean).join(' · ')
    : result?.marked ? 'marked' : '';
  let message: string | null = null;
  if (state.error) message = `Lookup failed: ${state.error}`;
  else if (result?.marked) message = result.marked === 'none' ? 'No correct lyrics' : 'Instrumental';
  else if (!best && state.loading) message = 'Looking up lyrics';
  else if (!state.query && !state.loading) message = 'No artist or title to look up';
  else if (!best) message = 'No lyrics found';
  else if (best.lyrics.instrumental) message = 'Instrumental';
  return { title, source, message };
}

// The scroll position for unsynced lyrics: how far through the track playback is, 0 to 1
export function progress(positionMs: number, durationMs: number | undefined): number {
  if (!durationMs) return 0;
  return Math.min(1, Math.max(0, positionMs / durationMs));
}

export interface CandidateEntry {
  ref: string;
  label: string;
  shown: boolean;
  rejected: boolean;
}

// Every candidate, numbered as `sleeve lyrics --all` numbers them, for the pick panel
export function candidateEntries(result: LyricsResult, shown: ScoredCandidate | null): CandidateEntry[] {
  const describe = (candidate: ScoredCandidate) => {
    const { track, lyrics } = candidate;
    const length = track.durationMs ? ` ${Math.floor(track.durationMs / 60_000)}:${String(Math.floor(track.durationMs / 1000) % 60).padStart(2, '0')}` : '';
    const kind = lyrics.instrumental ? 'instrumental' : `${lyrics.synced ? 'synced' : 'unsynced'}, ${lyrics.lines.length} lines`;
    return `${candidate.provider}: ${track.artist} - ${track.title}${track.album ? ` (${track.album})` : ''}${length}, ${kind}, score ${candidate.score.toFixed(2)}${candidate.reported ? `, reported ${candidate.reported}` : ''}`;
  };
  const same = (a: ScoredCandidate, b: ScoredCandidate | null) => !!b && a.provider === b.provider && a.id === b.id;
  return [
    ...result.candidates.map(candidate => ({ candidate, rejected: false })),
    ...result.rejected.map(candidate => ({ candidate, rejected: true }))
  ].filter(({ candidate }) => candidate.id).map(({ candidate, rejected }) => ({
    ref: `${candidate.provider}:${candidate.id}`,
    label: describe(candidate),
    shown: same(candidate, shown),
    rejected
  }));
}

// What the page shows besides the lyrics, and where: from the URL (?now=, ?now-position=, ?lyrics-align=), else from CSS
// variables (--now-preset, --now-position, --lyrics-align). The overlay shows only lyrics unless told otherwise.
export interface DisplaySettings {
  preset: NowPreset;
  position: NowPosition;
  align: LyricsAlign;
  // As given, whole window when null; see resolveArea
  lyricsArea: string | null;
  nowArea: string | null;
  // As given; null: the default for the mode (nothing on the overlay, the cover in a window)
  background: string | null;
  visible: boolean;
}

// Each setting from the first place that names a known value: given (a live change), the URL, then the variable
export function displaySettings(read: (name: string) => string, params: { get(name: string): string | null }, overlay: boolean, given: DisplayChange = {}): DisplaySettings {
  const choose = <T extends string>(known: readonly T[], fallback: T, ...values: Array<string | null | undefined>): T =>
    values.map(value => value?.trim()).find((value): value is T => (known as readonly string[]).includes(value ?? '')) ?? fallback;
  const area = (...values: Array<string | null | undefined>) => values.map(value => value?.trim()).find(value => !!value && parseArea(value)) ?? null;
  const fill = (...values: Array<string | null | undefined>) => values.map(value => value?.trim()).find(value => !!value && parseBackground(value)) ?? null;
  // ?background=none predates the others, and meant no cover
  const urlBackground = params.get('background') === 'none' ? 'transparent' : params.get('background');
  return {
    background: fill(given.background, urlBackground, read('--background')),
    lyricsArea: area(given.lyricsArea, params.get('lyrics-area'), read('--lyrics-area')),
    nowArea: area(given.nowArea, params.get('now-area'), read('--now-area')),
    preset: choose(NOW_PRESETS, overlay ? 'lyrics' : 'minimal', given.preset, params.get('now'), read('--now-preset')),
    position: choose(NOW_POSITIONS, 'top-left', given.position, params.get('now-position'), read('--now-position')),
    align: choose(LYRICS_ALIGNS, 'left', given.align, params.get('lyrics-align'), read('--lyrics-align')),
    visible: given.visible ?? true
  };
}

// The panel's lines. The full panel gives artist and title lines of their own; the others share one line.
export function nowText(state: NowState, preset: NowPreset, combined: string): { title: string; artist: string; album: string } {
  const track = state.playback?.track;
  if (preset !== 'full' || !track) return { title: combined, artist: '', album: '' };
  return { title: track.title, artist: track.artist, album: track.album ?? '' };
}

// m:ss, or h:mm:ss from an hour up; an empty string for a length not known
export function formatTime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, '0');
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// An area in pixels within a window of this size, clipped to it; the whole window without one
export function resolveArea(text: string | null, window: { width: number; height: number }): Rect {
  const area = text ? parseArea(text) : null;
  if (!area) return { left: 0, top: 0, width: window.width, height: window.height };
  const pixels = ({ value, percent }: AreaLength, whole: number) => (percent ? value / 100 * whole : value);
  const left = pixels(area.x, window.width);
  const top = pixels(area.y, window.height);
  const right = Math.min(window.width, left + pixels(area.width, window.width));
  const bottom = Math.min(window.height, top + pixels(area.height, window.height));
  const clippedLeft = Math.max(0, left);
  const clippedTop = Math.max(0, top);
  return { left: clippedLeft, top: clippedTop, width: Math.max(0, right - clippedLeft), height: Math.max(0, bottom - clippedTop) };
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

// How far the lyrics keep off the window's edges so the panel never covers them: the strip it stands in at the top or
// bottom, the column at a side. The top of the lyrics is empty over clearTop of their height anyway (--lyrics-clear-top), so
// a panel that fits in there costs them nothing.
const PANEL_GAP = 16;

export function lyricsInsets(position: NowPosition, panel: { top: number; right: number; bottom: number; left: number } | null, area: { left?: number; top?: number; width: number; height: number }, clearTop = 0.08): Insets {
  const insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  if (!panel) return insets;
  const areaLeft = area.left ?? 0;
  const areaTop = area.top ?? 0;
  // A panel standing elsewhere leaves the lyrics alone
  if (panel.right <= areaLeft || panel.left >= areaLeft + area.width || panel.bottom <= areaTop || panel.top >= areaTop + area.height) return insets;
  if (position.startsWith('top')) insets.top = Math.max(0, panel.bottom - areaTop + PANEL_GAP - area.height * clearTop);
  else if (position.startsWith('bottom')) insets.bottom = Math.max(0, areaTop + area.height - panel.top + PANEL_GAP);
  else if (position === 'center-left') insets.left = Math.max(0, panel.right - areaLeft + PANEL_GAP);
  else insets.right = Math.max(0, areaLeft + area.width - panel.left + PANEL_GAP);
  return insets;
}

// --art-animation: sleeve-art-flow and sleeve-art-swirl, set from CSS variables. Everything that shows as movement glides
// to a new value; resolution and fps apply at once, since they do not.
export interface FlowSettings {
  speed: number;
  amount: number;
  detail: number;
  zoom: number;
  saturation: number;
  resolution: number;
  fps: number;
  // sleeve-art-swirl: seconds a layer takes to turn once, how many seconds the second layer trails the first, a layer's side in
  // viewport lengths (vmax), and the brightness of each layer before they are blended
  period: number;
  delay: number;
  size: number;
  brightness: number;
}

// What is drawn this frame: phase is how far the flow has moved, turn how many turns the swirl has made, so a new
// speed or period carries on from where the picture is
export interface FlowView extends FlowSettings {
  phase: number;
  turn: number;
}

const FLOW_VARIABLES: Record<keyof FlowSettings, { name: string; fallback: number; min: number; max: number }> = {
  speed: { name: '--flow-speed', fallback: 1, min: -20, max: 20 },
  amount: { name: '--flow-amount', fallback: 1, min: 0, max: 5 },
  detail: { name: '--flow-detail', fallback: 1, min: 0.1, max: 10 },
  zoom: { name: '--flow-zoom', fallback: 1.4, min: 1, max: 6 },
  saturation: { name: '--art-saturation', fallback: 1.3, min: 0, max: 4 },
  resolution: { name: '--flow-resolution', fallback: 0.25, min: 0.05, max: 1 },
  fps: { name: '--flow-fps', fallback: 30, min: 1, max: 60 },
  period: { name: '--swirl-period', fallback: 60, min: 1, max: 3600 },
  delay: { name: '--swirl-delay', fallback: 10, min: -3600, max: 3600 },
  size: { name: '--swirl-size', fallback: 2, min: 0.5, max: 6 },
  brightness: { name: '--swirl-brightness', fallback: 0.5, min: 0, max: 2 }
};
const FLOW_GLIDE_MS = 800;

// The settings from CSS variables (read gives one's value); a missing or unreadable one takes its default, and each
// stays within its range
export function flowSettings(read: (name: string) => string): FlowSettings {
  const settings = {} as FlowSettings;
  for (const key of Object.keys(FLOW_VARIABLES) as Array<keyof FlowSettings>) {
    const { name, fallback, min, max } = FLOW_VARIABLES[key];
    const value = Number.parseFloat(read(name));
    settings[key] = Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  }
  return settings;
}

// The next frame's view: the phase moved on at the speed shown, the rest closer to its setting
export function flowStep(view: FlowView, target: FlowSettings, dtMs: number): FlowView {
  const share = 1 - Math.exp(-Math.max(0, dtMs) / FLOW_GLIDE_MS);
  const glide = (key: 'speed' | 'amount' | 'detail' | 'zoom' | 'saturation' | 'period' | 'delay' | 'size' | 'brightness') => {
    const next = view[key] + (target[key] - view[key]) * share;
    return Math.abs(next - target[key]) < 0.001 ? target[key] : next;
  };
  const seconds = Math.max(0, dtMs) / 1000 * view.speed;
  return {
    phase: view.phase + seconds,
    turn: view.turn + seconds / view.period,
    speed: glide('speed'),
    amount: glide('amount'),
    detail: glide('detail'),
    zoom: glide('zoom'),
    saturation: glide('saturation'),
    resolution: target.resolution,
    fps: target.fps,
    period: glide('period'),
    delay: glide('delay'),
    size: glide('size'),
    brightness: glide('brightness')
  };
}

// A CSS timing function (--swirl-timing) as a function of progress 0..1: the keywords, cubic-bezier() and steps() aside
// (a turn in steps is not a swirl), linear for anything else, so the shader eases the way the CSS version does
const TIMING_KEYWORDS: Record<string, [number, number, number, number]> = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1]
};

export function timingFunction(text: string): (progress: number) => number {
  const value = text.trim().toLowerCase();
  const bezier = /^cubic-bezier\(\s*([^,]+),([^,]+),([^,]+),([^)]+)\)$/.exec(value);
  const points = bezier ? bezier.slice(1).map(Number) : TIMING_KEYWORDS[value];
  if (!points || points.some(point => !Number.isFinite(point)) || points[0] < 0 || points[0] > 1 || points[2] < 0 || points[2] > 1) return progress => progress;
  const [x1, y1, x2, y2] = points;
  if (x1 === y1 && x2 === y2) return progress => progress;
  const curve = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return progress => {
    const x = Math.min(1, Math.max(0, progress));
    if (x === 0 || x === 1) return x;
    // x is monotonic in t for x1, x2 within 0..1, so bisection always finds it
    let low = 0;
    let high = 1;
    for (let step = 0; step < 30; step++) {
      const middle = (low + high) / 2;
      if (curve(x1, x2, middle) < x) low = middle;
      else high = middle;
    }
    return curve(y1, y2, (low + high) / 2);
  };
}

// One swirl layer, in viewport lengths (vmax) from the window's top-left, y down: the center it turns around and its
// angle in radians, clockwise on screen as CSS rotate() is
export interface SwirlLayer {
  x: number;
  y: number;
  angle: number;
}

// sleeve-art-swirl, after Sunamu's background: two copies of the cover, each size vmax square, in a box 125% of the
// window centered on it, one at the box's top-left turning forward, the other at its bottom-right turning back and
// delay seconds behind, each turn eased by the timing function
export function swirlLayers(view: Pick<FlowView, 'turn' | 'period' | 'delay' | 'size'>, ease: (progress: number) => number, width: number, height: number): [SwirlLayer, SwirlLayer] {
  const vmax = Math.max(1, width, height);
  const [boxWidth, boxHeight] = [1.25 * width / vmax, 1.25 * height / vmax];
  const [left, top] = [-0.125 * width / vmax, -0.125 * height / vmax];
  const half = view.size / 2;
  const fraction = (value: number) => value - Math.floor(value);
  const forward = 2 * Math.PI * ease(fraction(view.turn));
  // CSS's animation-direction: reverse plays the turn from 360 degrees back to 0
  const back = 2 * Math.PI * (1 - ease(fraction(view.turn - view.delay / view.period)));
  return [
    { x: left + half, y: top + half, angle: forward },
    { x: left + boxWidth - half, y: top + boxHeight - half, angle: back }
  ];
}

// Where a click on a line plays from (ms into the track, offset applied); null for a line without a time
export function lineStart(line: { time: number | null } | undefined, offsetMs: number): number | null {
  return typeof line?.time === 'number' ? Math.max(0, line.time + offsetMs) : null;
}

// Scrolling back through the lyrics by wheel: the wheel moves the view by offset pixels from where playback
// would put it, until SCROLL_BACK_MS after the last turn, when it returns to the current line (the scroll follows its
// target, so it glides back). The offset is kept between first and last line: some line always sits at the anchor.
export const SCROLL_BACK_MS = 4000;
// A wheel step given in lines rather than pixels (Firefox), in pixels
const WHEEL_LINE_PX = 40;

export interface ScrollBack {
  offset: number;
  until: number;
}

export const NO_SCROLL_BACK: ScrollBack = { offset: 0, until: 0 };

// After a wheel turn of deltaY (positive: down, toward later lines; deltaMode 1: in lines), with the offset kept
// within [min, max]
export function wheel(back: ScrollBack, deltaY: number, deltaMode: number, now: number, min: number, max: number): ScrollBack {
  const px = deltaMode === 1 ? deltaY * WHEEL_LINE_PX : deltaY;
  const start = now < back.until ? back.offset : 0;
  return { offset: Math.min(max, Math.max(min, start - px)), until: now + SCROLL_BACK_MS };
}

// The offset to add to the scroll target at now: none once the pause after the last turn has run out
export function scrollBackOffset(back: ScrollBack, now: number): number {
  return now < back.until ? back.offset : 0;
}

// How busy the cover is behind the lyrics, 0 (flat, or blurred as the 64 px default is) to 1 (sharp detail): the mean
// difference in brightness between neighboring pixels of a side x side RGBA copy (128 px, so any --art-size reads
// alike), from DETAIL_FLAT up over DETAIL_RANGE. Measured on a busy cover: 1 at 64 px blurred 6, 3.6 at 128 px blurred 3,
// 6.4 at 256 px blurred 2, 12 at 512 px sharp.
export const DETAIL_SAMPLE_SIZE = 128;
const DETAIL_FLAT = 1.5;
const DETAIL_RANGE = 10;

export function coverDetail(pixels: ArrayLike<number>, side: number): number {
  if (side < 2 || pixels.length < side * side * 4) return 0;
  const brightness = (at: number) => 0.2126 * pixels[at] + 0.7152 * pixels[at + 1] + 0.0722 * pixels[at + 2];
  let sum = 0;
  let count = 0;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const at = (y * side + x) * 4;
      if (x + 1 < side) { sum += Math.abs(brightness(at) - brightness(at + 4)); count++; }
      if (y + 1 < side) { sum += Math.abs(brightness(at) - brightness(at + side * 4)); count++; }
    }
  }
  return Math.min(1, Math.max(0, (sum / count - DETAIL_FLAT) / DETAIL_RANGE));
}

// The scrim's opacity behind the lyrics (--lyrics-scrim): auto follows the cover's detail, up to SCRIM_MAX; a number
// from 0 to 1 is taken as it is; anything else is auto
export const SCRIM_MAX = 0.6;

export function scrimAlpha(setting: string, detail: number): number {
  const value = setting.trim();
  const fixed = value === '' || value === 'auto' ? Number.NaN : Number(value);
  const alpha = Number.isFinite(fixed) ? fixed : SCRIM_MAX * detail;
  return Math.round(Math.min(1, Math.max(0, alpha)) * 100) / 100;
}

// The colors behind the lyrics when the cover is the background, for textTheme (contrast.ts): each pixel of the
// drawn cover as it shows on screen, laid at opacity over the page's base color and darkened by dim (the share of
// black over it), then grouped into coarse colors (4 bits a channel). background is their average; main the
// commonest, with their shares.
export function coverColors(pixels: ArrayLike<number>, { opacity, dim, base }: { opacity: number; dim: number; base: [number, number, number] }): OverlayColors {
  const groups = new Map<number, { count: number; sum: [number, number, number] }>();
  const total: [number, number, number] = [0, 0, 0];
  let count = 0;
  for (let at = 0; at + 3 < pixels.length; at += 4) {
    const alpha = (pixels[at + 3] / 255) * opacity;
    const shown = [0, 1, 2].map(channel => (base[channel] * (1 - alpha) + pixels[at + channel] * alpha) * (1 - dim)) as [number, number, number];
    const group = ((shown[0] >> 4) << 8) | ((shown[1] >> 4) << 4) | (shown[2] >> 4);
    const entry = groups.get(group) ?? { count: 0, sum: [0, 0, 0] };
    entry.count++;
    shown.forEach((value, channel) => { entry.sum[channel] += value; total[channel] += value; });
    groups.set(group, entry);
    count++;
  }
  const hex = (rgb: number[]) => `#${rgb.map(value => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
  if (!count) return { background: hex(base.map(value => value * (1 - dim))), main: [] };
  const main = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 6)
    .map(entry => ({ color: hex(entry.sum.map(value => value / entry.count)), share: Math.round(entry.count / count * 1000) / 1000 }));
  return { background: hex(total.map(value => value / count)), main };
}

// How long to wait before reconnecting, after `attempt` failures in a row
export function reconnectDelay(attempt: number): number {
  return Math.min(5000, 250 * 2 ** Math.max(0, attempt));
}
