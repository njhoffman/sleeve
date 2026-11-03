import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_PROVIDERS, fetchLyrics, queryForFile, type FetchOptions } from './fetchLyrics.ts';
import { formatLrc, looksLikeLrc, plainText } from './lrc.ts';
import { formatRef } from './prefs.ts';
import type { TagRetries } from './retries.ts';
import { Id3Error } from './tags/id3.ts';
import { FileChangedError, readLyricsTag, writeLyricsTag } from './tags/lyricsTag.ts';
import { shiftLyrics } from './timing.ts';

// `sleeve tag`: lyrics written into mp3 files' USLT frame as LRC text, the user's offset applied, word times left
// out (most players would show them as text). Synced lyrics replace unsynced ones in the USLT (beets' lyrics plugin
// fills it with plain text on import); a USLT already holding LRC is left alone unless forced, and so is any text
// when only unsynced lyrics are found, so a second run only does what the first did not. The file's own lyrics are never the source (the embedded provider
// is left out): writing them back changes nothing. Files a provider failed for go into TagRetries and wait their
// turn; online lookups are spaced by delayMs.

export const DEFAULT_DELAY_MS = 1000;

export type TagStatus =
  | 'written' // the lyrics are in the file
  | 'would write' // what a run with write would do
  | 'unchanged' // the file already has these lyrics
  | 'has lyrics' // its USLT has synced lyrics, or unsynced ones and nothing synced was found; --force replaces them
  | 'instrumental'
  | 'not found' // every provider answered, none with lyrics to write
  | 'deferred' // a provider failed; asked again after the retry pause
  | 'waiting' // deferred before, and its pause has not run out
  | 'skipped' // a file or tag sleeve does not write to
  | 'failed';

export const TAG_STATUSES: TagStatus[] = ['written', 'would write', 'unchanged', 'has lyrics', 'instrumental', 'not found', 'deferred', 'waiting', 'skipped', 'failed'];

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
  // The pause after a file that went online
  delayMs?: number;
  // Stop after this many files written (or that would be)
  limit?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onFile?: (report: TagReport) => void;
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// The mp3 files under each path (a file stands for itself), in name order, without sleeve's temporary files
export async function listMp3s(paths: string[]): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string) => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.mp3$/i.test(entry.name) && !entry.name.startsWith('.')) found.push(full);
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
  const sleep = options.sleep ?? wait;
  const providers = (options.providers ?? DEFAULT_PROVIDERS).filter(provider => provider.name !== 'embedded');
  const online = new Set(providers.filter(provider => !provider.local).map(provider => provider.name));
  let written = 0;
  let pause = false;
  for (const file of files) {
    if (options.signal?.aborted || (options.limit !== undefined && written >= options.limit)) break;
    if (pause) await sleep(options.delayMs ?? DEFAULT_DELAY_MS);
    pause = false;
    // Online providers are asked through this fetch, so a lookup the cache answered needs no pause after it
    const baseFetch = options.fetch ?? globalThis.fetch;
    const fetch: typeof globalThis.fetch = (...args) => { pause = true; return baseFetch(...args); };
    const report = await tagFile(file, { ...options, providers, fetch }, online, now);
    if (options.signal?.aborted && report.status !== 'written') break;
    counts[report.status]++;
    if (report.status === 'written' || report.status === 'would write') written++;
    options.onFile?.(report);
  }
  return counts;
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
  const best = result.best;
  let text: string | null = null;
  if (best?.lyrics.instrumental) {
    retries?.clear(tag.file);
    return report('instrumental', formatRef(best));
  }
  if (best?.lyrics.synced) text = formatLrc(shiftLyrics(best.lyrics, result.offsetMs), { words: false });
  else if (best && options.unsynced && !keepsExisting) text = plainText(best.lyrics);
  if (text === null || !best) {
    if (failed.length) {
      const deferred = retries?.defer(tag.file, failed.map(error => `${error.provider}: ${error.message}`).join('; '));
      return report('deferred', `${failed.map(error => error.provider).join(', ')} failed${deferred ? `; again after ${time(deferred.nextAt)}` : ''}`);
    }
    retries?.clear(tag.file);
    if (keepsExisting) return report('has lyrics', 'unsynced; no synced lyrics found to replace them');
    return report('not found', best ? `only unsynced lyrics (${formatRef(best)}; --unsynced writes them)` : undefined);
  }
  const source = `${formatRef(best)}, ${best.lyrics.synced ? 'synced' : 'unsynced'}, ${best.lyrics.lines.length} lines${result.offsetMs ? `, offset ${result.offsetMs > 0 ? '+' : ''}${result.offsetMs}ms` : ''}${existing && !looksLikeLrc(existing) ? ', replacing unsynced lyrics' : ''}`;
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
