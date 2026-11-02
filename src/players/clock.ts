import type { Playback } from './types.ts';

// Where playback is now: the reported position, run on at the playback rate while playing, and kept within the
// track's length

export const monotonic = (): number => performance.now();

export function positionAt(playback: Playback, now: number = monotonic()): number {
  const elapsed = playback.state === 'playing' ? (now - playback.at) * playback.rate : 0;
  const position = Math.max(0, playback.positionMs + elapsed);
  const length = playback.track?.durationMs;
  return length ? Math.min(position, length) : position;
}

// "1:05" from milliseconds
export function clockTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
