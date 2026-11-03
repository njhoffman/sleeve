import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_PROVIDERS, fetchLyrics, queryForFile, type FetchOptions } from './fetchLyrics.ts';
import { formatLrc, looksLikeLrc, plainText } from './lrc.ts';
import { formatRef } from './prefs.ts';
import type { TagRetries } from './retries.ts';
import { Id3Error } from './tags/id3.ts';
import { FileChangedError, readLyricsTag, writeLyricsTag } from './tags/lyricsTag.ts';
import { throttledFetch } from './throttle.ts';
import { shiftLyrics } from './timing.ts';
import type { ScoredCandidate, TrackQuery } from './types.ts';

// `sleeve tag`: lyrics written into mp3 files' USLT frame as LRC text, the user's offset applied, word times left
// out (most players would show them as text). Synced lyrics replace unsynced ones in the USLT (beets' lyrics plugin
// fills it with plain text on import); a USLT already holding LRC is left alone unless forced, and so is any text
// when only unsynced lyrics are found, so a second run only does what the first did not. The file's own lyrics are never the source (the embedded provider
// is left out): writing them back changes nothing. Files a provider failed for go into TagRetries and wait their
// turn. A few files are looked up at once (jobs); requests to each service are spaced delayMs apart across all of
// them, or further and one at a time where the provider's rate limit asks (LRCLIB: 700 ms; src/core/throttle.ts),
// and reports come in the files' order.

// Lyrics that go into a file are held to more than a match on screen (see doubts below). The providers come in
// the order of preference: when one fails, lyrics from one after it wait (the file is deferred) until it answers,
// so a run while LRCLIB is overloaded does not fill the library with NetEase's lyrics.

// The gap between requests to one service, and the files looked up at once
export const DEFAULT_DELAY_MS = 300;
export const DEFAULT_JOBS = 2;

export type TagStatus =
  | 'written' // the lyrics are in the file
  | 'would write' // what a run with write would do
  | 'unchanged' // the file already has these lyrics
  | 'has lyrics' // its USLT has synced lyrics, or unsynced ones and nothing synced was found; --force replaces them
  | 'instrumental'
  | 'not found' // every provider answered, none with lyrics to write
  | 'doubtful' // synced lyrics found, none fitting the file well enough to write (see doubts)
  | 'deferred' // a provider failed; asked again after the retry pause
  | 'waiting' // deferred before, and its pause has not run out
  | 'skipped' // a file or tag sleeve does not write to
  | 'failed';

export const TAG_STATUSES: TagStatus[] = ['written', 'would write', 'unchanged', 'has lyrics', 'instrumental', 'not found', 'doubtful', 'deferred', 'waiting', 'skipped', 'failed'];

export interface TagReport {
  file: string;
  status: TagStatus;
  detail?: string;
}

export interface TagOptions extends Pick<FetchOptions, 'providers' | 'timeoutMs' | 'fetch' | 'cache' | 'prefs' | 'userAgent' | 'tags'> {
  // Write; otherwise only say what would be written
  write?: boolean;
  // Replace a USLT that has text
  force?: boolean;
  // Write unsynced lyrics when no synced ones are found
  unsynced?: boolean;
  retries?: TagRetries;
  // Ask about deferred files now, whatever their pause
  retryNow?: boolean;
  // The gap between requests to one service
  delayMs?: number;
  // Files looked up at once
  jobs?: number;
  // Stop after this many files written (or that would be); never more, so near it fewer files are looked up at once
  limit?: number;
  // Ends the run: no file is started after it, those under way finish (an interrupted lookup is not reported)
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onFile?: (report: TagReport) => void;
}

// The mp3 files under each path (a file stands for itself), in name order, without hidden files or directories:
// sleeve's temporary files, and musicman's trash and downloads under the library's .musicman (a path given as
// an argument is gone through whatever its name)
export async function listMp3s(paths: string[]): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string) => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) await walk(full);
      else if (/\.mp3$/i.test(entry.name)) found.push(full);
    }
  };
  for (const item of paths) {
    if ((await stat(item)).isDirectory()) await walk(item);
    else found.push(item);
  }
  return found;
}

const time = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });

export async function tagFiles(files: string[], options: TagOptions = {}): Promise<Record<TagStatus, number>> {
  const counts = Object.fromEntries(TAG_STATUSES.map(status => [status, 0])) as Record<TagStatus, number>;
  const now = options.now ?? Date.now;
  const providers = (options.providers ?? DEFAULT_PROVIDERS).filter(provider => provider.name !== 'embedded');
  const online = new Set(providers.filter(provider => !provider.local).map(provider => provider.name));
  const limits = providers.flatMap(provider => provider.rateLimit ? [provider.rateLimit] : []);
  const fetch = throttledFetch(options.fetch ?? globalThis.fetch, {
    gapMs: options.delayMs ?? DEFAULT_DELAY_MS, limits, now, ...(options.sleep ? { sleep: options.sleep } : {})
  });
  const jobs = Math.max(1, options.jobs ?? DEFAULT_JOBS);
  // Reports by file, held until the ones before them are in; null for a file not reported
  const done: Array<TagReport | null> = [];
  let reported = 0;
  let started = 0;
  let underWay = 0;
  let written = 0;
  let failure: { error: unknown } | null = null;
  const flush = () => {
    for (; reported < started && done[reported] !== undefined; reported++) {
      const report = done[reported];
      if (!report) continue;
      counts[report.status]++;
      options.onFile?.(report);
    }
  };
  const more = () => started < files.length && !options.signal?.aborted && !failure
    && (options.limit === undefined || written + underWay < options.limit);
  const worker = async () => {
    while (more()) {
      const index = started++;
      underWay++;
      try {
        const report = await tagFile(files[index], { ...options, providers, fetch }, online, now);
        // Interrupted: only a file written counts, the rest is looked at again on the next run
        const counted = !options.signal?.aborted || report.status === 'written';
        done[index] = counted ? report : null;
        if (counted && (report.status === 'written' || report.status === 'would write')) written++;
      } catch (error) {
        done[index] = null;
        failure ??= { error };
      } finally {
        underWay--;
      }
      try {
        flush();
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  if (failure) throw (failure as { error: unknown }).error;
  return counts;
}

// Synced lyrics written to a file must fit its audio: a length within about 4 seconds (a duration score of 0.75;
// on screen up to 10 seconds passes), and a last line between 15% and 105% of the way through (lyrics that end
// at once or run past the end are another song's, or NetEase's stand-ins)
export const MIN_DURATION_SCORE = 0.75;
export const LYRICS_SPAN: [number, number] = [0.15, 1.05];

// Why these synced lyrics should not go into the file, or null when they may
export function doubts(query: TrackQuery, candidate: ScoredCandidate): string | null {
  if (candidate.exact) return null;
  const { durationMs } = query;
  const found = candidate.track.durationMs;
  if (candidate.detail.duration !== null && candidate.detail.duration < MIN_DURATION_SCORE && durationMs && found) {
    const apart = Math.round(Math.abs(found - durationMs) / 1000);
    return `${formatRef(candidate)} is ${apart} s ${found > durationMs ? 'longer' : 'shorter'} than the file`;
  }
  const last = candidate.lyrics.lines.reduce<number | null>((latest, line) => line.time !== null && (latest === null || line.time > latest) ? line.time : latest, null);
  if (last !== null && durationMs) {
    const share = last / durationMs;
    if (share < LYRICS_SPAN[0]) return `${formatRef(candidate)} ends ${Math.round(share * 100)}% of the way through`;
    if (share > LYRICS_SPAN[1]) return `${formatRef(candidate)} runs past the end of the file`;
  }
  return null;
}

async function tagFile(file: string, options: TagOptions & { fetch: typeof fetch }, online: Set<string>, now: () => number): Promise<TagReport> {
  const report = (status: TagStatus, detail?: string): TagReport => ({ file, status, ...(detail ? { detail } : {}) });
  if (!/\.mp3$/i.test(file)) return report('skipped', 'not an mp3');
  let tag;
  try {
    tag = await readLyricsTag(file);
  } catch (error) {
    return error instanceof Id3Error ? report('skipped', error.message) : report('failed', (error as Error).message);
  }
  if (tag.usltCount > 1) return report('skipped', `${tag.usltCount} USLT frames`);
  // What the file has: synced lyrics (LRC) stay unless forced; unsynced ones give way to synced lyrics found
  const existing = tag.uslt?.text.trim() ? tag.uslt.text : '';
  if (existing && looksLikeLrc(existing) && !options.force) return report('has lyrics');
  const keepsExisting = Boolean(existing) && !options.force;
  const retries = options.retries;
  const retry = retries?.get(tag.file);
  if (retry && retry.nextAt > now() && !options.retryNow) return report('waiting', `until ${time(retry.nextAt)}: ${retry.error}`);

  let query;
  try {
    query = await queryForFile(file, {}, options.tags);
  } catch (error) {
    return report('skipped', (error as Error).message);
  }
  const { providers, timeoutMs, fetch, cache, prefs, userAgent, tags, signal } = options;
  const result = await fetchLyrics(query, {
    providers: providers!, fetch,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(cache ? { cache } : {}), ...(prefs ? { prefs } : {}),
    ...(userAgent ? { userAgent } : {}), ...(tags ? { tags } : {}), ...(signal ? { signal } : {})
  });
  // Interrupted: what the providers said is not an answer
  if (signal?.aborted) return report('failed', 'interrupted');
  const failed = result.errors.filter(error => online.has(error.provider));
  const order = providers!.map(provider => provider.name);
  const best = result.best;
  // The user's pick goes in as it is; otherwise the best synced lyrics that fit the file
  const synced = result.candidates.filter(candidate => candidate.lyrics.synced);
  const fitting = result.pinned ? synced.slice(0, best === synced[0] ? 1 : 0) : synced.filter(candidate => doubts(query, candidate) === null);
  const doubt = !fitting.length && synced.length ? doubts(query, synced[0]) : null;
  let chosen: ScoredCandidate | null = fitting[0] ?? null;
  let text: string | null = null;
  if (chosen) {
    text = formatLrc(shiftLyrics(chosen.lyrics, chosen === best ? result.offsetMs : 0), { words: false });
  } else if (best?.lyrics.instrumental || (best && !best.lyrics.synced && options.unsynced && !keepsExisting)) {
    chosen = best;
  }
  // A provider preferred to the one with the answer failed: wait for it
  const waitFor = chosen ? failed.filter(error => order.indexOf(error.provider) < order.indexOf(chosen.provider)) : failed;
  if (waitFor.length) {
    const deferred = retries?.defer(tag.file, waitFor.map(error => `${error.provider}: ${error.message}`).join('; '));
    const held = chosen ? `; ${chosen.provider} has ${chosen.lyrics.instrumental ? 'it as instrumental' : 'lyrics'}, held until then` : '';
    return report('deferred', `${waitFor.map(error => error.provider).join(', ')} failed${held}${deferred ? `; again after ${time(deferred.nextAt)}` : ''}`);
  }
  if (chosen?.lyrics.instrumental) {
    retries?.clear(tag.file);
    return report('instrumental', formatRef(chosen));
  }
  if (chosen && !chosen.lyrics.synced) text = plainText(chosen.lyrics);
  if (text === null || !chosen) {
    retries?.clear(tag.file);
    if (doubt) return report('doubtful', doubt);
    if (keepsExisting) return report('has lyrics', 'unsynced; no synced lyrics found to replace them');
    return report('not found', best ? `only unsynced lyrics (${formatRef(best)}; --unsynced writes them)` : undefined);
  }
  const offsetMs = chosen === best ? result.offsetMs : 0;
  const source = `${formatRef(chosen)}, ${chosen.lyrics.synced ? 'synced' : 'unsynced'}, ${chosen.lyrics.lines.length} lines${offsetMs ? `, offset ${offsetMs > 0 ? '+' : ''}${offsetMs}ms` : ''}${existing && !looksLikeLrc(existing) ? ', replacing unsynced lyrics' : ''}`;
  if (tag.uslt?.text === text) {
    retries?.clear(tag.file);
    return report('unchanged', source);
  }
  if (!options.write) return report('would write', source);
  try {
    await writeLyricsTag(tag, text);
  } catch (error) {
    if (error instanceof FileChangedError) return report('failed', 'changed while sleeve looked its lyrics up; run again');
    return error instanceof Id3Error ? report('skipped', error.message) : report('failed', (error as Error).message);
  }
  retries?.clear(tag.file);
  return report('written', source);
}
