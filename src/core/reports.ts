import { createHash } from 'node:crypto';
import type { Candidate, Lyrics, ReportKind, ScoredCandidate } from './types.ts';

// What the user said about lyrics they were shown: the words are wrong, or the words are right and the times are not. A
// report is kept for the track until the user takes it back (`sleeve reports --reset`), and picking the lyrics takes it
// back too.
//
// The same lyrics come by several routes: LRCLIB's are in the file once `sleeve tag` wrote them, and then the embedded
// provider offers them too. So a report also catches lyrics that read the same (wrong) or run at the same times
// (mistimed), whoever offers them. A local candidate is held by its content alone: its id names a file, whose lyrics may
// be replaced with right ones.

export interface LyricsReport {
  kind: ReportKind;
  provider: string;
  id?: string;
  // The track as it was playing, for `sleeve reports`
  artist: string;
  title: string;
  path?: string;
  // A hash of the words, '' with none to compare (instrumental)
  words: string;
  // When each line starts, for comparing timing
  times: number[];
  reportedAt: number;
}

// Times this close are the same times: LRC keeps hundredths, so lyrics written to a file come back rounded
const SAME_TIME_MS = 150;

type Reportable = Pick<Candidate, 'provider' | 'id' | 'lyrics'>;

export function wordsHash(lyrics: Lyrics): string {
  const lines = lyrics.lines.map(line => line.text.trim().toLowerCase()).filter(Boolean);
  return lines.length ? createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32) : '';
}

export function lineTimes(lyrics: Lyrics): number[] {
  return lyrics.lines.flatMap(line => line.time === null ? [] : [line.time]);
}

function sameTimes(a: number[], b: number[]): boolean {
  return a.length > 0 && a.length === b.length && a.every((time, index) => Math.abs(time - b[index]) <= SAME_TIME_MS);
}

function caught(report: LyricsReport, candidate: Reportable, local: boolean): boolean {
  if (!local && report.id !== undefined && report.provider === candidate.provider && report.id === candidate.id) return true;
  return report.kind === 'wrong'
    ? report.words !== '' && report.words === wordsHash(candidate.lyrics)
    : sameTimes(report.times, lineTimes(candidate.lyrics));
}

// What was reported about these lyrics, wrong before mistimed; null for nothing. local: the candidate comes with the file.
export function reportFor(candidate: Reportable, reports: LyricsReport[], local: boolean): ReportKind | null {
  const found = reports.filter(report => caught(report, candidate, local));
  if (found.some(report => report.kind === 'wrong')) return 'wrong';
  return found.length ? 'mistimed' : null;
}

// The reports left once the user picked these lyrics: a pick says they are right
export function withoutPicked(reports: LyricsReport[], candidate: Reportable): LyricsReport[] {
  return reports.filter(report => !caught(report, candidate, false));
}

// The words of lyrics whose times were reported, to show when nothing better is found
export function asUntimed(candidate: ScoredCandidate): ScoredCandidate {
  const lines = candidate.lyrics.lines.map(({ text, translation }) => ({ time: null, text, ...(translation ? { translation } : {}) }));
  return { ...candidate, lyrics: { ...candidate.lyrics, synced: false, lines }, reported: 'mistimed' };
}
