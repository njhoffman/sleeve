import type { LyricsResult, ScoredCandidate } from '../core/types.ts';
import type { NowState } from '../now/state.ts';
import { LYRICS_ALIGNS, NOW_POSITIONS, NOW_PRESETS, type DisplayChange, type LyricsAlign, type NowPosition, type NowPreset } from '../protocol/messages.ts';
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
    return `${candidate.provider}: ${track.artist} - ${track.title}${track.album ? ` (${track.album})` : ''}${length}, ${kind}, score ${candidate.score.toFixed(2)}`;
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
  visible: boolean;
}

// Each setting from the first place that names a known value: given (a live change), the URL, then the variable
export function displaySettings(read: (name: string) => string, params: { get(name: string): string | null }, overlay: boolean, given: DisplayChange = {}): DisplaySettings {
  const choose = <T extends string>(known: readonly T[], fallback: T, ...values: Array<string | null | undefined>): T =>
    values.map(value => value?.trim()).find((value): value is T => (known as readonly string[]).includes(value ?? '')) ?? fallback;
  return {
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

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

// How far the lyrics keep off the window's edges so the panel never covers them: the strip it stands in at the top or
// bottom, the column at a side. The top of the lyrics is faded out over TOP_FADE of their height anyway, so a panel
// that fits in there costs them nothing.
const TOP_FADE = 0.08;
const PANEL_GAP = 16;

export function lyricsInsets(position: NowPosition, panel: { top: number; right: number; bottom: number; left: number } | null, view: { width: number; height: number }): Insets {
  const insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  if (!panel) return insets;
  if (position.startsWith('top')) insets.top = Math.max(0, panel.bottom + PANEL_GAP - view.height * TOP_FADE);
  else if (position.startsWith('bottom')) insets.bottom = view.height - panel.top + PANEL_GAP;
  else if (position === 'center-left') insets.left = panel.right + PANEL_GAP;
  else insets.right = view.width - panel.left + PANEL_GAP;
  return insets;
}

// --art-animation: sleeve-art-flow, set from CSS variables. speed, amount, detail, zoom and saturation glide to a new
// value; resolution and fps apply at once, since they do not show as movement.
export interface FlowSettings {
  speed: number;
  amount: number;
  detail: number;
  zoom: number;
  saturation: number;
  resolution: number;
  fps: number;
}

// What is drawn this frame: phase is how far the picture has moved, so a new speed carries on from there
export interface FlowView extends FlowSettings {
  phase: number;
}

const FLOW_VARIABLES: Record<keyof FlowSettings, { name: string; fallback: number; min: number; max: number }> = {
  speed: { name: '--flow-speed', fallback: 1, min: -20, max: 20 },
  amount: { name: '--flow-amount', fallback: 1, min: 0, max: 5 },
  detail: { name: '--flow-detail', fallback: 1, min: 0.1, max: 10 },
  zoom: { name: '--flow-zoom', fallback: 1.4, min: 1, max: 6 },
  saturation: { name: '--art-saturation', fallback: 1.3, min: 0, max: 4 },
  resolution: { name: '--flow-resolution', fallback: 0.25, min: 0.05, max: 1 },
  fps: { name: '--flow-fps', fallback: 30, min: 1, max: 60 }
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
  const glide = (key: 'speed' | 'amount' | 'detail' | 'zoom' | 'saturation') => {
    const next = view[key] + (target[key] - view[key]) * share;
    return Math.abs(next - target[key]) < 0.001 ? target[key] : next;
  };
  return {
    phase: view.phase + dtMs / 1000 * view.speed,
    speed: glide('speed'),
    amount: glide('amount'),
    detail: glide('detail'),
    zoom: glide('zoom'),
    saturation: glide('saturation'),
    resolution: target.resolution,
    fps: target.fps
  };
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
