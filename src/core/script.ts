import type { Candidate, LyricLine, Lyrics } from './types.ts';

// Latin script only: sleeve never shows or writes text in another alphabet (Han, kana, Hangul, Cyrillic, ...).
// Letters with accents are Latin. Every candidate goes through latinCandidate before it is scored, whatever its
// provider, so a display, a pick and a tag all see the same:
//
// - Look-alikes are put right: a Cyrillic or Greek letter that looks like a Latin one, inside a word that has
//   Latin letters too ("hеre" with a Cyrillic е), becomes the Latin letter. Full-width punctuation becomes ASCII.
// - A line with any other non-Latin letter is dropped: on NetEase these are uploaders' credits ("钢琴 : ..."),
//   album notes and translated titles, and what would be left of the line is no lyric.
// - Lyrics with more than MAX_FOREIGN_SHARE of their lines dropped are in another language (or a translation
//   filed as lyrics), and so is a track named in another alphabet: the candidate is left out.

export const MAX_FOREIGN_SHARE = 0.2;

const LOOKALIKES: Record<string, string> = {
  // Cyrillic
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', һ: 'h', ԛ: 'q', ԝ: 'w',
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y', І: 'I', Ј: 'J', Ѕ: 'S',
  // Greek
  ο: 'o', ι: 'i', Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X'
};

const LATIN = /\p{Script=Latin}/u;
const FOREIGN = /(?=\p{L})\P{Script=Latin}/u;

// Look-alikes inside Latin words put right, full-width punctuation and spaces made ASCII
export function normalizeLatin(text: string): string {
  const narrowed = text
    .replace(/[！-～]/gu, char => /\p{L}/u.test(char) ? char : String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ');
  return narrowed.replace(/\p{L}+/gu, word => {
    if (!LATIN.test(word) || !FOREIGN.test(word)) return word;
    const fixed = [...word].map(char => LOOKALIKES[char] ?? char).join('');
    return FOREIGN.test(fixed) ? word : fixed;
  });
}

// Whether text has no letter outside the Latin script (look-alikes put right first)
export function isLatin(text: string): boolean {
  return !FOREIGN.test(normalizeLatin(text));
}

function latinLine(line: LyricLine): LyricLine | null {
  const text = normalizeLatin(line.text);
  if (FOREIGN.test(text)) return null;
  const { translation, ...rest } = line;
  const kept: LyricLine = { ...rest, text };
  if (line.words) kept.words = line.words.map(word => ({ ...word, text: normalizeLatin(word.text) }));
  if (translation !== undefined && isLatin(translation)) kept.translation = normalizeLatin(translation);
  return kept;
}

// The lyrics in Latin script, or null when too much of them is not
export function latinLyrics(lyrics: Lyrics): Lyrics | null {
  const worded = lyrics.lines.filter(line => /\p{L}/u.test(line.text)).length;
  const lines = lyrics.lines.map(latinLine);
  const dropped = lines.filter(line => line === null).length;
  if (dropped > worded * MAX_FOREIGN_SHARE) return null;
  return { ...lyrics, lines: lines.filter((line): line is LyricLine => line !== null) };
}

// The candidate in Latin script, or null when it cannot be (see above)
export function latinCandidate<T extends Candidate>(candidate: T): T | null {
  const { track } = candidate;
  if (!isLatin(track.artist) || !isLatin(track.title)) return null;
  const lyrics = latinLyrics(candidate.lyrics);
  if (!lyrics) return null;
  const album = track.album !== undefined && !isLatin(track.album) ? undefined : track.album;
  const named = { ...track, artist: normalizeLatin(track.artist), title: normalizeLatin(track.title) };
  if (album === undefined) delete named.album;
  else named.album = normalizeLatin(album);
  return { ...candidate, track: named, lyrics };
}

export function latinCandidates<T extends Candidate>(candidates: T[]): T[] {
  return candidates.map(latinCandidate).filter((candidate): candidate is T => candidate !== null);
}
