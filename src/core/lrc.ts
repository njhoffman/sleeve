import type { LyricLine, LyricWord, Lyrics } from './types.ts';

// LRC lyrics: lines like "[01:23.45]text", several timestamps per line allowed ("[00:10.00][01:10.00]Chorus"),
// enhanced LRC word times inside a line ("[00:10.00]<00:10.00>One <00:10.50>two"), and an [offset:+/-ms] tag
// that shifts every time (positive makes the lyrics appear sooner, as the format defines). Other ID tags
// ([ar:], [ti:], [length:] ...) are skipped. Text without any timestamp makes the lyrics unsynced.

const TIME = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
const TAG = /^\[([a-z#]+):(.*)\]$/i;

function toMs(minutes: string, seconds: string, fraction: string | undefined): number {
  // ".5" is half a second and ".05" five hundredths, so the fraction is scaled by its length
  const ms = fraction === undefined ? 0 : Math.round(Number(fraction) * 10 ** (3 - fraction.length));
  return Number(minutes) * 60_000 + Number(seconds) * 1000 + ms;
}

// A line's enhanced word times. Each word keeps the space that follows it (one, however much there was), so
// syllables ("<00:10.00>Hel<00:10.20>lo") join back into "Hello" and the words concatenated are the line's text.
// Text before the first word time starts at the line's own time.
function parseWords(text: string, lineTime: number, offset: number): { text: string; words?: LyricWord[] } {
  const marks = [...text.matchAll(WORD)];
  if (!marks.length) return { text: text.trim() };
  const pieces: { time: number; text: string }[] = [];
  const lead = text.slice(0, marks[0].index);
  if (lead.trim()) pieces.push({ time: lineTime, text: lead });
  marks.forEach((mark, index) => {
    const start = mark.index + mark[0].length;
    const end = marks[index + 1]?.index ?? text.length;
    pieces.push({ time: Math.max(0, toMs(mark[1], mark[2], mark[3]) - offset), text: text.slice(start, end) });
  });
  const words: LyricWord[] = [];
  for (const piece of pieces) {
    const body = piece.text.replace(/\s+/g, ' ');
    // Space before a word belongs to the word before it
    if (body.startsWith(' ') && words.length && !words[words.length - 1].text.endsWith(' ')) words[words.length - 1].text += ' ';
    const word = body.trimStart();
    if (word) words.push({ time: piece.time, text: word });
  }
  if (!words.length) return { text: '' };
  words[words.length - 1].text = words[words.length - 1].text.trimEnd();
  return { text: words.map(word => word.text).join(''), words };
}

export function parseLrc(source: string): Lyrics {
  let offset = 0;
  const timed: LyricLine[] = [];
  const plain: LyricLine[] = [];
  for (const raw of source.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const tag = TAG.exec(line);
    if (tag && !/^\d/.test(tag[1])) {
      if (tag[1].toLowerCase() === 'offset' && /^[+-]?\d+$/.test(tag[2].trim())) offset = Number(tag[2].trim());
      continue;
    }
    const stamps = [...line.matchAll(TIME)];
    if (!stamps.length || stamps[0].index !== 0) {
      plain.push({ time: null, text: line });
      continue;
    }
    const last = stamps[stamps.length - 1];
    const rest = line.slice(last.index + last[0].length);
    for (const stamp of stamps) {
      const time = Math.max(0, toMs(stamp[1], stamp[2], stamp[3]) - offset);
      timed.push({ time, ...parseWords(rest, time, offset) });
    }
  }
  if (!timed.length) return { synced: false, instrumental: false, lines: plain };
  timed.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  return { synced: true, instrumental: false, lines: timed };
}

// Whether text has LRC timestamps at the start of a line, as lyrics stored in an unsynced tag often do
export function looksLikeLrc(text: string): boolean {
  return /^\s*\[\d{1,3}:\d{1,2}([.:]\d{1,3})?\]/m.test(text);
}

function stamp(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const hundredths = Math.floor((ms % 1000) / 10);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
}

// LRC text for lyrics: timed lines with enhanced word times when known (unless words is false, for players that
// would show the word tags as text), or the plain text when unsynced
export function formatLrc(lyrics: Lyrics, { words = true }: { words?: boolean } = {}): string {
  return lyrics.lines.map(line => {
    if (line.time === null) return line.text;
    const body = words && line.words?.length ? line.words.map(word => `<${stamp(word.time)}>${word.text}`).join('') : line.text;
    return `[${stamp(line.time)}]${body}`;
  }).join('\n');
}

// Lyrics as plain text, one line each
export function plainText(lyrics: Lyrics): string {
  return lyrics.lines.map(line => line.text).join('\n');
}
