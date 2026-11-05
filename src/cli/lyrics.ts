import { DEFAULT_PROVIDERS, DEFAULT_TIMEOUT_MS, fetchLyrics, queryForFile, type FetchOptions } from '../core/fetchLyrics.ts';
import { formatLrc, plainText } from '../core/lrc.ts';
import { THRESHOLD } from '../core/match.ts';
import { formatRef } from '../core/prefs.ts';
import { shiftLyrics } from '../core/timing.ts';
import type { LyricsResult, ScoredCandidate, TrackQuery } from '../core/types.ts';
import type { TagReader } from '../core/tags/reader.ts';
import { openStores } from './stores.ts';

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

export function describeCandidate(candidate: ScoredCandidate): string {
  const { track, lyrics } = candidate;
  const kind = lyrics.instrumental ? 'instrumental' : `${lyrics.synced ? 'synced' : 'unsynced'}, ${lyrics.lines.length} line${lyrics.lines.length === 1 ? '' : 's'}`;
  const words = lyrics.lines.some(line => line.words?.length) ? ', word timing' : '';
  const album = track.album ? ` (${track.album})` : '';
  const cached = candidate.cachedAt ? ', cached' : '';
  const reported = candidate.reported ? `, reported ${candidate.reported}` : '';
  return `${candidate.provider}: ${track.artist} - ${track.title}${album} ${clock(track.durationMs)}, ${kind}${words}, score ${candidate.score.toFixed(2)}${cached}${reported}`;
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
  io.err(`${describeCandidate(best)}${decisions(result)}`);
  for (const error of result.errors.filter(error => error.provider === 'prefs')) io.err(`prefs: ${error.message}`);
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
    io.err(`${query.artist} - ${query.title} is marked as ${result.marked === 'none' ? 'having no correct lyrics' : 'instrumental'} (sleeve pick --reset to undo)`);
    return 1;
  }
  if (!result.best && !options.all) {
    io.err(`No lyrics found for ${query.artist} - ${query.title}`);
    for (const candidate of result.rejected.slice(0, 3)) io.err(`  under ${THRESHOLD}: ${describeCandidate(candidate)}`);
    for (const error of result.errors) io.err(`  ${error.provider} failed: ${error.message}`);
    return 1;
  }
  printResult(result, options, io);
  return result.best ? 0 : 1;
}
