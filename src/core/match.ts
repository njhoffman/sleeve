import type { Candidate, ScoreDetail, ScoredCandidate, TrackQuery } from './types.ts';

// Scoring a provider's candidate against the track asked for. Titles and artists are compared after
// normalizing away what differs between catalogs for the same recording ("Remastered 2011", "feat. X",
// punctuation, accents); durations are compared because a wrong version (live, radio edit) has the same name
// but different timing, which makes synced lyrics useless.

// Version markers that name the same recording, dropped from titles before comparing
const SAME_RECORDING = /\b(remaster(ed)?|\d{4} remaster(ed)?|remaster(ed)? \d{4}|mono|stereo|single version|album version|explicit|clean|bonus track|deluxe( edition)?)\b/;

// Removes accents, case, punctuation and bracketed or dashed suffixes that do not change the recording
export function normalizeTitle(title: string): string {
  let text = title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // "(feat. X)", "[feat. X]", "feat. X" at the end
  text = text.replace(/[([]\s*(feat|ft|featuring|with)\.?\s[^)\]]*[)\]]/g, ' ').replace(/\s(feat|ft|featuring)\.?\s.*$/, ' ');
  // "(Remastered 2011)" and "- 2011 Remaster" style suffixes
  text = text.replace(/[([]([^)\]]*)[)\]]/g, (whole, inner: string) => (SAME_RECORDING.test(inner) ? ' ' : ` ${inner} `));
  text = text.replace(/\s[-–—]\s(.*)$/, (whole, tail: string) => (SAME_RECORDING.test(tail) ? ' ' : ` ${tail} `));
  return text.replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

// Artists: the same, and also only the first credited artist ("A & B", "A, B", "A feat. B" count as A)
export function normalizeArtist(artist: string): string {
  const first = artist.split(/\s*(?:,|;|\/|\s&\s|\sx\s|\sfeat\.?\s|\sft\.?\s|\sfeaturing\s|\swith\s)\s*/i)[0];
  return normalizeTitle(first).replace(/^the /, '');
}

// Words in a title's bracketed or dashed suffix that mark another version of the song: a remix, a live take, an
// acoustic or stripped one, an edit. Synced lyrics from one do not fit the other, so titles must agree on them.
// Only suffixes count, so a song named "Live Forever" is not taken for a live version; "original mix" is the original.
const VERSION_MARKERS = ['remix', 'mix', 'rework', 'bootleg', 'vip', 'dub', 'live', 'acoustic', 'unplugged', 'stripped', 'edit', 'demo', 'instrumental', 'karaoke', 'cover'];

export function versionMarkers(title: string): Set<string> {
  const text = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  // Bracketed credits ("(feat. Mix Master Mike)") are not versions
  const suffixes = [...text.matchAll(/[([]([^)\]]*)[)\]]/g)].map(match => match[1]).filter(inner => !/^\s*(feat|ft|featuring|with)\b/.test(inner));
  const dashed = /\s[-–—]\s(.*)$/.exec(text.replace(/[([][^)\]]*[)\]]/g, ' '));
  if (dashed) suffixes.push(dashed[1]);
  const found = new Set<string>();
  for (const suffix of suffixes) {
    const words = suffix.replace(/\boriginal mix\b/g, ' ').split(/[^\p{L}\p{N}]+/u);
    for (const marker of VERSION_MARKERS) if (words.includes(marker)) found.add(marker === 'mix' ? 'remix' : marker);
  }
  return found;
}

function sameVersion(a: string, b: string): boolean {
  const left = versionMarkers(a);
  const right = versionMarkers(b);
  return left.size === right.size && [...left].every(marker => right.has(marker));
}

function bigrams(text: string): Map<string, number> {
  const grams = new Map<string, number>();
  const padded = ` ${text} `;
  for (let index = 0; index < padded.length - 1; index++) {
    const gram = padded.slice(index, index + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

// Dice coefficient over character bigrams of the normalized strings: 1 for equal, 0 for nothing shared
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const left = bigrams(a);
  const right = bigrams(b);
  let shared = 0;
  let total = 0;
  for (const count of left.values()) total += count;
  for (const [gram, count] of right) {
    total += count;
    shared += Math.min(count, left.get(gram) ?? 0);
  }
  return (2 * shared) / total;
}

// Full marks within 2 seconds, falling to 0 at 10 seconds apart; null when either duration is unknown
export function durationScore(wanted: number | undefined, found: number | undefined): number | null {
  if (!wanted || !found) return null;
  const apart = Math.abs(wanted - found) / 1000;
  if (apart <= 2) return 1;
  if (apart >= 10) return 0;
  return 1 - (apart - 2) / 8;
}

// Candidates scoring under this are not offered as a match
export const THRESHOLD = 0.6;

const WEIGHTS = { title: 0.4, artist: 0.3, album: 0.05, duration: 0.25 };

// 0 to 1. Missing album or duration leave their weight out rather than counting as a mismatch. A duration
// 10 or more seconds off, a title or artist that barely matches, or titles that disagree on the version (one a
// remix or live, the other not) cap the score under the threshold whatever the rest says. Exact matches (found by identifier or from the file) score 1.
//
// A query without a duration may be scored against typical, the duration most candidates share
// (typicalDuration): it ranks other lengths lower, but never vetoes them, since the user asked for no length.
export function scoreCandidate(query: TrackQuery, candidate: Candidate, typical?: number): ScoredCandidate {
  const detail: ScoreDetail = {
    title: similarity(normalizeTitle(query.title), normalizeTitle(candidate.track.title)),
    artist: similarity(normalizeArtist(query.artist), normalizeArtist(candidate.track.artist)),
    album: query.album && candidate.track.album ? similarity(normalizeTitle(query.album), normalizeTitle(candidate.track.album)) : null,
    duration: durationScore(query.durationMs ?? typical, candidate.track.durationMs)
  };
  if (candidate.exact) return { ...candidate, score: 1, detail };
  let weighted = WEIGHTS.title * detail.title + WEIGHTS.artist * detail.artist;
  let weights = WEIGHTS.title + WEIGHTS.artist;
  if (detail.album !== null) {
    weighted += WEIGHTS.album * detail.album;
    weights += WEIGHTS.album;
  }
  if (detail.duration !== null) {
    weighted += WEIGHTS.duration * detail.duration;
    weights += WEIGHTS.duration;
  }
  let score = weighted / weights;
  const vetoed = (detail.duration === 0 && Boolean(query.durationMs)) || detail.title < 0.5 || detail.artist < 0.5 || !sameVersion(query.title, candidate.track.title);
  if (vetoed) score = Math.min(score, THRESHOLD - 0.01);
  return { ...candidate, score: Math.round(score * 1000) / 1000, detail };
}

// The duration most of the passing candidates share (within 2 seconds of each other), for a query without one:
// live and other versions under the same name are usually the few. Undefined unless at least two agree and no
// other length has as many.
export function typicalDuration(candidates: ScoredCandidate[]): number | undefined {
  const durations = candidates.filter(candidate => candidate.score >= THRESHOLD && candidate.track.durationMs)
    .map(candidate => candidate.track.durationMs!).sort((a, b) => a - b);
  let best: number[] = [];
  let tied = false;
  for (const duration of durations) {
    const near = durations.filter(other => Math.abs(other - duration) <= 2000);
    if (near.length > best.length) {
      // A group overlapping the best one so far is the same length, not a rival
      tied = false;
      best = near;
    } else if (near.length === best.length && !near.some(other => best.includes(other))) {
      tied = true;
    }
  }
  return best.length >= 2 && !tied ? best[Math.floor(best.length / 2)] : undefined;
}

// Best first among accepted candidates: synced over unsynced (the threshold already keeps out wrong songs, and
// unsynced lyrics are no use to the display), then higher score, then word timing, then more lines
export function rankCandidates(candidates: ScoredCandidate[]): ScoredCandidate[] {
  const words = (candidate: ScoredCandidate) => candidate.lyrics.lines.some(line => line.words?.length);
  return [...candidates].sort((a, b) =>
    Number(b.lyrics.synced) - Number(a.lyrics.synced)
    || b.score - a.score
    || Number(words(b)) - Number(words(a))
    || b.lyrics.lines.length - a.lyrics.lines.length);
}
