import path from 'node:path';
import { DEFAULT_TIMEOUT_MS, type FetchOptions } from '../core/fetchLyrics.ts';
import type { Provider } from '../core/providers/provider.ts';
import { createLrclib } from '../core/providers/lrclib.ts';
import type { TagRetries } from '../core/retries.ts';
import { DEFAULT_DELAY_MS, DEFAULT_JOBS, listMp3s, TAG_STATUSES, tagFiles, type TagReport, type TagStatus } from '../core/tagger.ts';
import { parseDuration, pickProviders, type Io } from './lyrics.ts';
import { openStores } from './stores.ts';

// `sleeve tag <paths...>`: synced lyrics into the USLT frame of mp3 files (see src/core/tagger.ts). Only says what it
// would write unless --write; one line per file that needs attention (all of them with --verbose), then the counts.

export interface TagCommandOptions {
  write?: boolean;
  force?: boolean;
  unsynced?: boolean;
  retryNow?: boolean;
  delay?: string;
  jobs?: string;
  limit?: string;
  providers?: string;
  timeout?: string;
  verbose?: boolean;
  // commander's --no-cache and --no-prefs set these false
  cache?: boolean;
  prefs?: boolean;
}

// Lines for these only with --verbose: the files a run over the library mostly passes by
const QUIET: TagStatus[] = ['has lyrics', 'waiting', 'unchanged'];

function whole(text: string | undefined, name: string, fallback: number, least = 0): number {
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isInteger(value) || value < least) throw new Error(`Invalid ${name}: ${text} (a whole number${least ? ` from ${least}` : ''})`);
  return value;
}

// LRCLIB without its retry: its 503s for tracks it has not looked up last minutes, so a retry a second later only
// slows the run, and the file is deferred to a later run instead
export function forBatch(providers: Provider[]): Provider[] {
  return providers.map(provider => provider.name === 'lrclib' ? createLrclib({ retries: 0 }) : provider);
}

// Resolves to the exit code: 1 when a file failed, else 0
export async function tagCommand(paths: string[], options: TagCommandOptions, io: Io, given: FetchOptions & { retries?: TagRetries; signal?: AbortSignal; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {}): Promise<number> {
  const delayMs = whole(options.delay, '--delay', DEFAULT_DELAY_MS);
  const jobs = whole(options.jobs, '--jobs', DEFAULT_JOBS, 1);
  const limit = options.limit === undefined ? undefined : whole(options.limit, '--limit', 0);
  const timeoutMs = options.timeout ? parseDuration(options.timeout) : DEFAULT_TIMEOUT_MS;
  const providers = forBatch(pickProviders(options.providers)!);
  const files = await listMp3s(paths);
  const base = paths.length === 1 ? path.resolve(paths[0]) : process.cwd();
  const shown = (file: string) => {
    const relative = path.relative(base, path.resolve(file));
    return relative && !relative.startsWith('..') ? relative : file;
  };
  const stores = openStores({ cache: options.cache !== false, prefs: options.prefs !== false, retries: true }, given);
  // Ctrl-C lets the files under way finish (a lookup is cut short, a write is not), never stopping halfway through one
  const abort = new AbortController();
  const signal = given.signal ? AbortSignal.any([abort.signal, given.signal]) : abort.signal;
  const interrupted = () => {
    io.err('Stopping once the files under way are done (Ctrl-C again to quit now)');
    abort.abort();
    process.once('SIGINT', () => process.exit(130));
  };
  process.once('SIGINT', interrupted);
  const { cache: _cache, prefs: _prefs, retries: _retries, signal: _signal, ...rest } = given;
  let counts: Record<TagStatus, number>;
  try {
    if (!options.write) io.err(`Looking up ${files.length} file${files.length === 1 ? '' : 's'}; nothing is written without --write`);
    counts = await tagFiles(files, {
      ...rest, providers, timeoutMs, delayMs, jobs, signal,
      write: Boolean(options.write), force: Boolean(options.force), unsynced: Boolean(options.unsynced), retryNow: Boolean(options.retryNow),
      ...(limit !== undefined ? { limit } : {}),
      ...(stores.cache ? { cache: stores.cache } : {}),
      ...(stores.prefs ? { prefs: stores.prefs } : {}),
      ...(stores.retries ? { retries: stores.retries } : {}),
      onFile: (report: TagReport) => {
        if (options.verbose || !QUIET.includes(report.status)) io.out(`${report.status.padEnd(12)} ${shown(report.file)}${report.detail ? `  (${report.detail})` : ''}`);
      }
    });
  } finally {
    process.off('SIGINT', interrupted);
    stores.close();
  }
  const done = TAG_STATUSES.filter(status => counts[status]).map(status => `${counts[status]} ${status}`);
  io.err(`${signal.aborted ? 'Stopped: ' : ''}${done.join(', ') || 'no mp3 files'}`);
  if (counts.deferred || counts.waiting) io.err('Deferred files are asked about again on a later run, once their pause is over (--retry-now: at once)');
  return counts.failed ? 1 : 0;
}
