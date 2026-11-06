import path from 'node:path';
import { DEFAULT_TIMEOUT_MS, type FetchOptions } from '../core/fetchLyrics.ts';
import type { Provider } from '../core/providers/provider.ts';
import { createLrclib } from '../core/providers/lrclib.ts';
import type { TagFallbacks, TagRetries } from '../core/retries.ts';
import { DEFAULT_DELAY_MS, DEFAULT_JOBS, listMp3s, pruneRetries, reportedFiles, TAG_STATUSES, tagFiles, type TagReport, type TagStatus } from '../core/tagger.ts';
import { errStyle, outStyle, parseDuration, warn, pickProviders, type Io } from './lyrics.ts';
import { openStores } from './stores.ts';
import { elapsed, gradientBar, LiveLine, pad, paint, percent, shortenPath, stylePath, table, truncate, visibleWidth, type Cell, type Paint, type Painter, type StreamStyle } from './style.ts';

// `sleeve tag <paths...>`: synced lyrics into the USLT frame of mp3 files (see src/core/tagger.ts). Only says what it
// would write unless --write; one line per file that needs attention (all of them with --verbose), then the counts.

export interface TagCommandOptions {
  write?: boolean;
  force?: boolean;
  unsynced?: boolean;
  retryNow?: boolean;
  recheckFallbacks?: boolean;
  fixReported?: boolean;
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

const statusColor = (status: TagStatus, paints: Paint): Painter => ({
  written: paints.green, 'would write': paints.green, unchanged: paints.dim, 'has lyrics': (text: string) => text, instrumental: paints.cyan,
  'not found': paints.dim, doubtful: paints.yellow, deferred: paints.yellow, waiting: paints.blue, offline: paints.red, skipped: paints.dim, failed: paints.red
} as Record<TagStatus, Painter>)[status];

const STATUS_WIDTH = 12;

// A file's report in a terminal: the status in color, the path shortened to a column of its own, the details dim after it
export function fileLine(report: TagReport, shown: string, style: StreamStyle): string {
  const paints = paint(style);
  const status = statusColor(report.status, paints)(report.status.padEnd(STATUS_WIDTH));
  const detail = report.detail?.replaceAll('; ', ' · ');
  const width = style.columns ? Math.max(30, Math.floor((style.columns - STATUS_WIDTH - 1) * 0.55)) : null;
  const file = stylePath(width ? shortenPath(shown, width) : shown, paints);
  if (!detail) return `${status} ${file}`;
  return `${status} ${width ? pad(file, width) : file}  ${paints.dim(detail)}`;
}

const BAR_MIN = 10;
const BAR_MAX = 32;

// The run so far, as wide as the terminal allows
export function progressLine(finished: number, total: number, counts: Record<TagStatus, number>, tookMs: number, style: StreamStyle): string {
  const fraction = total ? finished / total : 0;
  const notable = (['written', 'would write', 'deferred', 'offline', 'failed'] as TagStatus[]).filter(status => counts[status] || status === 'written' || status === 'deferred');
  const tail = [`${percent(fraction).padStart(4)}`, `${finished}/${total}`, ...notable.map(status => `${counts[status]} ${status}`), elapsed(tookMs)].join(' · ');
  const columns = style.columns ?? 80;
  const room = columns - visibleWidth(tail) - 2;
  if (room < BAR_MIN) return truncate(tail, columns - 1);
  return `${gradientBar(fraction, Math.min(BAR_MAX, room), style.depth)} ${tail}`;
}

const SUMMARY_BAR_WIDTH = 24;
// Fewer files than this say little as bars
const SUMMARY_BARS_FROM = 10;

// The counts at the end of a run in a terminal: a table with each one's share, or one colored line for a few files
export function summaryLines(counts: Record<TagStatus, number>, tookMs: number, style: StreamStyle): string[] {
  const paints = paint(style);
  const present = TAG_STATUSES.filter(status => counts[status]);
  const total = present.reduce((sum, status) => sum + counts[status], 0);
  if (total < SUMMARY_BARS_FROM) return [present.map(status => statusColor(status, paints)(`${counts[status]} ${status}`)).join(paints.dim(' · '))];
  const rows: Cell[][] = present.map(status => [
    { text: status, style: statusColor(status, paints) }, String(counts[status]), gradientBar(counts[status] / total, SUMMARY_BAR_WIDTH, style.depth), percent(counts[status] / total)
  ]);
  return [...table(rows, { right: [1, 3] }), paints.dim(`${total} files in ${elapsed(tookMs)}`)];
}

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
export async function tagCommand(paths: string[], options: TagCommandOptions, io: Io, given: FetchOptions & { retries?: TagRetries; fallbacks?: TagFallbacks; signal?: AbortSignal; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {}): Promise<number> {
  const delayMs = whole(options.delay, '--delay', DEFAULT_DELAY_MS);
  const jobs = whole(options.jobs, '--jobs', DEFAULT_JOBS, 1);
  const limit = options.limit === undefined ? undefined : whole(options.limit, '--limit', 0);
  const timeoutMs = options.timeout ? parseDuration(options.timeout) : DEFAULT_TIMEOUT_MS;
  const providers = forBatch(pickProviders(options.providers)!);
  if (options.recheckFallbacks && options.force) throw new Error('Give --recheck-fallbacks or --force, not both');
  if (options.fixReported && (options.recheckFallbacks || options.force)) throw new Error('Give --fix-reported alone, without --recheck-fallbacks or --force');
  if (options.fixReported && options.prefs === false) throw new Error('--fix-reported reads your reports, so not with --no-prefs');
  const found = await listMp3s(paths);
  const base = paths.length === 1 ? path.resolve(paths[0]) : process.cwd();
  const shown = (file: string) => {
    const relative = path.relative(base, path.resolve(file));
    return relative && !relative.startsWith('..') ? relative : file;
  };
  const stores = openStores({ cache: options.cache !== false, prefs: options.prefs !== false, retries: true, fallbacks: true }, given);
  const started = Date.now();
  // The bar goes where the messages go, so a run piped to a file still shows it
  const line = io.live && errStyle(io).tty ? new LiveLine(io.live) : null;
  const files = options.recheckFallbacks ? found.filter(file => stores.fallbacks!.get(path.resolve(file)))
    : options.fixReported ? await reportedFiles(found, { ...(stores.prefs ? { prefs: stores.prefs } : {}), ...(given.tags ? { tags: given.tags } : {}) })
      : found;
  // Ctrl-C lets the files under way finish (a lookup is cut short, a write is not), never stopping halfway through one
  const abort = new AbortController();
  const signal = given.signal ? AbortSignal.any([abort.signal, given.signal]) : abort.signal;
  const interrupted = () => {
    line?.clear();
    io.err('Stopping once the files under way are done (Ctrl-C again to quit now)');
    abort.abort();
    process.once('SIGINT', () => process.exit(130));
  };
  process.once('SIGINT', interrupted);
  const { cache: _cache, prefs: _prefs, retries: _retries, fallbacks: _fallbacks, signal: _signal, ...rest } = given;
  let counts: Record<TagStatus, number>;
  let networkGone = false;
  try {
    const seen = Object.fromEntries(TAG_STATUSES.map(status => [status, 0])) as Record<TagStatus, number>;
    let finished = 0;
    const style = outStyle(io);
    const forgotten = stores.retries ? pruneRetries(paths, stores.retries) : 0;
    if (forgotten) io.err(`Forgot ${forgotten} deferred file${forgotten === 1 ? '' : 's'} no run would ask about again (gone, or in a hidden directory)`);
    if (!options.write) io.err(`Looking up ${files.length} file${files.length === 1 ? '' : 's'}; nothing is written without --write`);
    counts = await tagFiles(files, {
      ...rest, providers, timeoutMs, delayMs, jobs, signal,
      write: Boolean(options.write), force: Boolean(options.force), unsynced: Boolean(options.unsynced), retryNow: Boolean(options.retryNow),
      ...(limit !== undefined ? { limit } : {}),
      ...(stores.cache ? { cache: stores.cache } : {}),
      ...(stores.prefs ? { prefs: stores.prefs } : {}),
      ...(stores.retries ? { retries: stores.retries } : {}),
      ...(stores.fallbacks ? { fallbacks: stores.fallbacks } : {}),
      ...(options.recheckFallbacks ? { recheck: true } : {}),
      ...(options.fixReported ? { fixReported: true } : {}),
      onNetworkDown: () => { networkGone = true; },
      onFile: (report: TagReport) => {
        finished++;
        seen[report.status]++;
        if (options.verbose || !QUIET.includes(report.status)) {
          line?.clear();
          io.out(style.rich ? fileLine(report, shown(report.file), style) : `${report.status.padEnd(STATUS_WIDTH)} ${shown(report.file)}${report.detail ? `  (${report.detail})` : ''}`);
        }
        line?.update(() => progressLine(finished, files.length, seen, Date.now() - started, errStyle(io)));
      }
    });
  } finally {
    line?.clear();
    process.off('SIGINT', interrupted);
    stores.close();
  }
  const done = TAG_STATUSES.filter(status => counts[status]).map(status => `${counts[status]} ${status}`);
  const stopped = signal.aborted || networkGone;
  const nothing = options.recheckFallbacks ? 'no fallbacks recorded here' : options.fixReported ? 'nothing reported here' : 'no mp3 files';
  if (errStyle(io).rich && done.length) {
    const lines = summaryLines(counts, Date.now() - started, errStyle(io));
    if (lines.length > 1) io.err('');
    if (stopped) io.err(paint(errStyle(io)).yellow('Stopped'));
    for (const text of lines) io.err(text);
  } else {
    io.err(`${stopped ? 'Stopped: ' : ''}${done.join(', ') || nothing}`);
  }
  if (!options.recheckFallbacks && !options.fixReported && (counts.deferred || counts.waiting)) io.err('Deferred files are asked about again on a later run, once their pause is over (--retry-now: at once)');
  if (networkGone) warn(io, 'The network looks down, so the run stopped; nothing is held against the files it could not ask about. Run it again once the network is back');
  return counts.failed || counts.offline ? 1 : 0;
}
