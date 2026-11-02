import type { LyricLine, LyricsResult } from '../core/types.ts';

// Which line of synced lyrics plays at a position, with the user's offset applied. Free of Node imports, so the
// daemon, the CLI and a browser client share it.

export interface CurrentLine {
  // -1 before the first line
  index: number;
  line: LyricLine | null;
  // When the line starts, the offset applied (ms)
  time: number | null;
}

// The line playing at positionMs, with lyrics shifted by the result's offsetMs (positive: later)
export function lineAt(result: LyricsResult | null, positionMs: number): CurrentLine {
  const lyrics = result?.best?.lyrics;
  if (!lyrics?.synced) return { index: -1, line: null, time: null };
  const offset = result!.offsetMs;
  let index = -1;
  for (let at = 0; at < lyrics.lines.length; at++) {
    if ((lyrics.lines[at].time ?? 0) + offset > positionMs) break;
    index = at;
  }
  return index < 0 ? { index, line: null, time: null } : { index, line: lyrics.lines[index], time: lyrics.lines[index].time! + offset };
}

// Where the line after the one playing at positionMs starts (ms into the track, offset applied); null after the
// last line or without synced lyrics
export function nextLineTime(result: LyricsResult | null, positionMs: number): number | null {
  const lyrics = result?.best?.lyrics;
  if (!lyrics?.synced) return null;
  const next = lyrics.lines[lineAt(result, positionMs).index + 1];
  return next ? next.time! + result!.offsetMs : null;
}
