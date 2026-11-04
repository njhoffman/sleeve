import type { LyricsResult, ScoredCandidate } from '../core/types.ts';
import type { NowState } from '../now/state.ts';
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
