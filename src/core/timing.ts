import type { Lyrics } from './types.ts';

// Lyrics with every line and word time moved by offsetMs (positive: later), clamped at the start of the track.
// Unsynced lines have no time and stay as they are.
export function shiftLyrics(lyrics: Lyrics, offsetMs: number): Lyrics {
  if (!offsetMs) return lyrics;
  const shift = (time: number) => Math.max(0, time + offsetMs);
  return {
    ...lyrics,
    lines: lyrics.lines.map(line => ({
      ...line,
      time: line.time === null ? null : shift(line.time),
      ...(line.words ? { words: line.words.map(word => ({ ...word, time: shift(word.time) })) } : {})
    }))
  };
}
