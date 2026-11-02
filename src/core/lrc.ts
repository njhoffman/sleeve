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

function parseWords(text: string, offset: number): { text: string; words?: LyricWord[] } {
  const marks = [...text.matchAll(WORD)];
  if (!marks.length) return { text: text.trim() };
  const words: LyricWord[] = [];
  marks.forEach((mark, index) => {
    const start = mark.index + mark[0].length;
    const end = marks[index + 1]?.index ?? text.length;
    const word = text.slice(start, end).trim();
    if (word) words.push({ time: Math.max(0, toMs(mark[1], mark[2], mark[3]) - offset), text: word });
  });
  return { text: words.map(word => word.text).join(' '), words };
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
    const body = parseWords(line.slice(last.index + last[0].length), offset);
    for (const stamp of stamps) {
      timed.push({ time: Math.max(0, toMs(stamp[1], stamp[2], stamp[3]) - offset), ...body });
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

// LRC text for lyrics: timed lines with enhanced word times when known, or the plain text when unsynced
export function formatLrc(lyrics: Lyrics): string {
  return lyrics.lines.map(line => {
    if (line.time === null) return line.text;
    const body = line.words?.length ? line.words.map(word => `<${stamp(word.time)}>${word.text}`).join(' ') : line.text;
    return `[${stamp(line.time)}]${body}`;
  }).join('\n');
}

// Lyrics as plain text, one line each
export function plainText(lyrics: Lyrics): string {
  return lyrics.lines.map(line => line.text).join('\n');
}
