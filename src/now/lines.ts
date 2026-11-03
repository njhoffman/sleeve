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

// Word-by-word timing for the line playing. A line with its own word times (enhanced LRC) uses them; any other line
// can have them estimated: the line split at its spaces, its time spread over the words by their length. Ends are
// capped at MAX_MS_PER_CHAR per character, so a long gap before the next line (an instrumental break) does not stretch
// the last word or the estimate over it.

export const MAX_MS_PER_CHAR = 250;
// A line's pace when nothing comes after it to time it by
const LAST_LINE_MS_PER_CHAR = 90;

export interface WordTiming {
  // The word with the space after it; the texts concatenated are the line's text
  text: string;
  // ms into the track, the offset applied
  start: number;
  end: number;
}

// The line's pieces for word highlighting: its own words, or else its text split after each run of spaces
export function wordTexts(line: LyricLine): string[] {
  if (line.words?.length) return line.words.map(word => word.text);
  return line.text.match(/\S+\s*/g) ?? [];
}

const letters = (text: string) => Math.max(1, text.replace(/\s/g, '').length);

// When each piece of wordTexts(line) starts and ends, with the offset applied; nextLineTime is where the line after it
// starts (offset applied, as nextLineTime() gives it), or null after the last line. [] for a line without a time.
export function wordTimings(line: LyricLine, offsetMs: number, nextLineTime: number | null): WordTiming[] {
  if (line.time === null) return [];
  const lineStart = line.time + offsetMs;
  const texts = wordTexts(line);
  const limit = nextLineTime ?? Infinity;
  if (line.words?.length) {
    // Never earlier than the line or the word before it, so odd times still fill left to right
    const starts: number[] = [];
    line.words.forEach((word, at) => starts.push(Math.max(word.time + offsetMs, at ? starts[at - 1] : lineStart)));
    return texts.map((text, at) => {
      const start = starts[at];
      const end = at + 1 < starts.length ? starts[at + 1] : Math.min(limit, start + letters(text) * MAX_MS_PER_CHAR);
      return { text, start, end: Math.max(start, end) };
    });
  }
  const total = texts.reduce((sum, text) => sum + letters(text), 0);
  const span = nextLineTime === null
    ? total * LAST_LINE_MS_PER_CHAR
    : Math.min(Math.max(0, nextLineTime - lineStart), total * MAX_MS_PER_CHAR);
  let done = 0;
  return texts.map(text => {
    const start = lineStart + span * done / total;
    done += letters(text);
    return { text, start, end: lineStart + span * done / total };
  });
}

// How much of a word is sung at positionMs: 0 before it starts, 1 once it ends
export function wordFill(word: WordTiming, positionMs: number): number {
  if (positionMs >= word.end) return 1;
  if (positionMs < word.start) return 0;
  return (positionMs - word.start) / (word.end - word.start);
}
