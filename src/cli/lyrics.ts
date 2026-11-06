import { DEFAULT_PROVIDERS, DEFAULT_TIMEOUT_MS, fetchLyrics, queryForFile, type FetchOptions } from '../core/fetchLyrics.ts';
import { formatLrc, plainText } from '../core/lrc.ts';
import { THRESHOLD } from '../core/match.ts';
import { formatRef } from '../core/prefs.ts';
import { shiftLyrics } from '../core/timing.ts';
import type { LyricsResult, ScoredCandidate, TrackQuery } from '../core/types.ts';
import type { TagReader } from '../core/tags/reader.ts';
import { openStores } from './stores.ts';
import { gradientBar, paint, PLAIN, table, type Cell, type Paint, type StreamStyle } from './style.ts';

// `sleeve lyrics [file]`: the best lyrics for a track, from a local file's tags or from --artist and --title.

export interface LyricsOptions {
  artist?: string;
  title?: string;
  album?: string;
  duration?: string;
  providers?: string;
  timeout?: string;
  all?: boolean;
  json?: boolean;
  format?: string;
  // commander's --no-cache sets this false
  cache?: boolean;
  refresh?: boolean;
  // commander's --no-prefs sets this false
  prefs?: boolean;
}

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  // What each stream can show; without them, plain
  styles?: { out: StreamStyle; err: StreamStyle };
  // Writes to the terminal with no newline, for a line redrawn in place
  live?: (text: string) => unknown;
}

export const outStyle = (io: Io) => io.styles?.out ?? PLAIN;
export const errStyle = (io: Io) => io.styles?.err ?? PLAIN;

// Something that went wrong without ending the command
export function warn(io: Io, text: string): void {
  const style = errStyle(io);
  io.err(style.rich ? `${paint(style).yellow('warning:')} ${text}` : text);
}

// What ended it, in a command's own words
export function problem(io: Io, text: string): void {
  const style = errStyle(io);
  io.err(style.rich ? `${paint(style).red('error:')} ${text}` : text);
}

// A command having done what was asked
export function done(io: Io, text: string): void {
  io.out(paint(outStyle(io)).green(text));
}

export const FORMATS = ['lrc', 'plain'];

// "177", "177.5" (seconds) or "2:57" to milliseconds
export function parseDuration(text: string): number {
  const clock = /^(\d+):([0-5]?\d(?:\.\d+)?)$/.exec(text.trim());
  const seconds = clock ? Number(clock[1]) * 60 + Number(clock[2]) : Number(text);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`Invalid duration: ${text} (use seconds, like 177, or m:ss, like 2:57)`);
  return Math.round(seconds * 1000);
}

function clock(ms: number | undefined): string {
  if (!ms) return '?:??';
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// "+250ms", "-1200ms"
export function formatOffset(ms: number): string {
  return `${ms > 0 ? '+' : ''}${ms}ms`;
}

// What the user decided about the candidate shown: ", pinned, offset +250ms"
function decisions(result: LyricsResult): string {
  return `${result.pinned ? ', pinned' : ''}${result.offsetMs ? `, offset ${formatOffset(result.offsetMs)}` : ''}`;
}

function candidateKind({ lyrics }: ScoredCandidate): string {
  const kind = lyrics.instrumental ? 'instrumental' : `${lyrics.synced ? 'synced' : 'unsynced'}, ${lyrics.lines.length} line${lyrics.lines.length === 1 ? '' : 's'}`;
  return `${kind}${lyrics.lines.some(line => line.words?.length) ? ', word timing' : ''}`;
}

const candidateTrack = ({ track }: ScoredCandidate) => `${track.artist} - ${track.title}${track.album ? ` (${track.album})` : ''}`;

export function describeCandidate(candidate: ScoredCandidate, paints?: Paint): string {
  const { track } = candidate;
  const name = candidateTrack(candidate);
  const after = ` ${clock(track.durationMs)}, ${candidateKind(candidate)}, score ${candidate.score.toFixed(2)}${candidate.cachedAt ? ', cached' : ''}`;
  const reported = candidate.reported ? `, reported ${candidate.reported}` : '';
  if (!paints) return `${candidate.provider}: ${name}${after}${reported}`;
  return `${paints.cyan(`${candidate.provider}:`)} ${paints.bold(name)}${paints.dim(after)}${reported ? paints.red(reported) : ''}`;
}

const SCORE_BAR_WIDTH = 8;

// Candidates as a table for a terminal: a mark, the number and ref to pick them by, how well each matched, and the rest
export function candidateRows(list: ScoredCandidate[], style: StreamStyle, { shown, rejectedFrom = list.length, notes }: {
  shown?: ScoredCandidate | null; rejectedFrom?: number; notes?: (candidate: ScoredCandidate) => string;
} = {}): string[] {
  const paints = paint(style);
  const rows: Cell[][] = list.map((candidate, index) => {
    const rejected = index >= rejectedFrom;
    const quiet = (text: string): Cell => (rejected ? { text, style: paints.dim } : text);
    const facts = [rejected ? 'rejected' : '', candidateKind(candidate), candidate.cachedAt ? 'cached' : '', notes?.(candidate) ?? ''].filter(Boolean).join(', ');
    return [
      candidate === shown ? { text: '*', style: paints.green } : ' ',
      String(index + 1),
      { text: formatRef(candidate), style: rejected ? paints.dim : paints.cyan },
      `${gradientBar(candidate.score, SCORE_BAR_WIDTH, style.depth)} ${candidate.score.toFixed(2)}`,
      quiet(candidateTrack(candidate)),
      quiet(clock(candidate.track.durationMs)),
      { text: `${facts}${candidate.reported ? `${facts ? ', ' : ''}reported ${candidate.reported}` : ''}`, style: candidate.reported ? paints.red : paints.dim }
    ];
  });
  return table(rows, { right: [1, 5], flex: 4, columns: style.columns, gap: 2 });
}

export function pickProviders(names: string | undefined): FetchOptions['providers'] {
  if (!names) return DEFAULT_PROVIDERS;
  const wanted = names.split(',').map(name => name.trim().toLowerCase()).filter(Boolean);
  const unknown = wanted.filter(name => !DEFAULT_PROVIDERS.some(provider => provider.name === name));
  if (unknown.length) throw new Error(`Unknown provider: ${unknown.join(', ')} (known: ${DEFAULT_PROVIDERS.map(provider => provider.name).join(', ')})`);
  return DEFAULT_PROVIDERS.filter(provider => wanted.includes(provider.name));
}

export async function buildQuery(file: string | undefined, options: LyricsOptions, tags?: TagReader): Promise<TrackQuery> {
  const given: Partial<TrackQuery> = {
    ...(options.artist ? { artist: options.artist } : {}),
    ...(options.title ? { title: options.title } : {}),
    ...(options.album ? { album: options.album } : {}),
    ...(options.duration ? { durationMs: parseDuration(options.duration) } : {})
  };
  if (file) return queryForFile(file, given, tags);
  if (!given.artist || !given.title) throw new Error('Give a file, or --artist and --title');
  return given as TrackQuery;
}

// Every candidate, numbered as `sleeve pick` takes them, with its ref
function printAll(result: LyricsResult, io: Io): void {
  const listed = [...result.candidates, ...result.rejected];
  if (outStyle(io).rich) {
    for (const line of candidateRows(listed, outStyle(io), { shown: result.best, rejectedFrom: result.candidates.length, notes: candidate => candidate === result.best ? decisions(result).slice(2) : '' })) io.out(line);
    for (const error of result.errors) warn(io, `${error.provider} failed: ${error.message}`);
    return;
  }
  listed.forEach((candidate, index) => {
    const rejected = index >= result.candidates.length ? 'rejected ' : '';
    const mine = candidate === result.best ? decisions(result) : '';
    io.out(`${index + 1} ${formatRef(candidate)}  ${rejected}${describeCandidate(candidate)}${mine}`);
  });
  for (const error of result.errors) io.err(`${error.provider} failed: ${error.message}`);
}

function printResult(result: LyricsResult, options: LyricsOptions, io: Io): void {
  if (options.all) {
    printAll(result, io);
    return;
  }
  const best = result.best!;
  const style = errStyle(io);
  io.err(`${describeCandidate(best, style.rich ? paint(style) : undefined)}${paint(style).dim(decisions(result))}`);
  for (const error of result.errors.filter(error => error.provider === 'prefs')) warn(io, `prefs: ${error.message}`);
  if (best.lyrics.instrumental) {
    io.out('(instrumental)');
    return;
  }
  const lyrics = shiftLyrics(best.lyrics, result.offsetMs);
  io.out(options.format === 'plain' ? plainText(lyrics) : formatLrc(lyrics));
}

// Resolves to the exit code: 0 with lyrics, 1 without
export async function lyricsCommand(file: string | undefined, options: LyricsOptions, io: Io, fetchOptions: FetchOptions = {}): Promise<number> {
  if (options.format && !FORMATS.includes(options.format)) throw new Error(`Invalid format: ${options.format} (use ${FORMATS.join(' or ')})`);
  const query = await buildQuery(file, options, fetchOptions.tags);
  const timeoutMs = options.timeout ? parseDuration(options.timeout) : DEFAULT_TIMEOUT_MS;
  const providers = pickProviders(options.providers);
  const { cache: _cache, prefs: _prefs, ...rest } = fetchOptions;
  const stores = openStores({ cache: options.cache !== false, prefs: options.prefs !== false }, fetchOptions);
  let result: LyricsResult;
  try {
    result = await fetchLyrics(query, {
      ...rest, providers, timeoutMs, all: Boolean(options.all), refresh: Boolean(options.refresh),
      ...(stores.cache ? { cache: stores.cache } : {}),
      ...(stores.prefs ? { prefs: stores.prefs } : {})
    });
  } finally {
    stores.close();
  }
  if (options.json) {
    io.out(JSON.stringify({ query, ...result }, null, 2));
    return result.best ? 0 : 1;
  }
  if (result.marked && !options.all) {
    problem(io, `${query.artist} - ${query.title} is marked as ${result.marked === 'none' ? 'having no correct lyrics' : 'instrumental'} (sleeve pick --reset to undo)`);
    return 1;
  }
  if (!result.best && !options.all) {
    problem(io, `No lyrics found for ${query.artist} - ${query.title}`);
    const paints = errStyle(io).rich ? paint(errStyle(io)) : undefined;
    for (const candidate of result.rejected.slice(0, 3)) io.err(`  under ${THRESHOLD}: ${describeCandidate(candidate, paints)}`);
    for (const error of result.errors) io.err(`  ${error.provider} failed: ${error.message}`);
    return 1;
  }
  printResult(result, options, io);
  return result.best ? 0 : 1;
}
