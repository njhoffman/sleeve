import { existsSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_PROVIDERS, fetchLyrics, queryForFile, type FetchOptions } from './fetchLyrics.ts';
import { formatLrc, looksLikeLrc, parseLrc, plainText } from './lrc.ts';
import { formatRef } from './prefs.ts';
import { reportFor } from './reports.ts';
import { gaveUp, lyricsHash, type TagFallbacks, type TagRetries } from './retries.ts';
import { Id3Error } from './tags/id3.ts';
import { FileChangedError, readLyricsTag, writeLyricsTag } from './tags/lyricsTag.ts';
import { throttledFetch } from './throttle.ts';
import { shiftLyrics } from './timing.ts';
import type { Lyrics, ProviderError, ScoredCandidate, TrackMark, TrackQuery } from './types.ts';

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
// so a run while LRCLIB is overloaded does not fill the library with NetEase's lyrics. A file that has waited a day
// and three tries (gaveUp, src/core/retries.ts) takes the later provider's answer, and its report says so. Such a
// write is recorded (TagFallbacks), and a recheck run asks the providers it waited for again, about just those files.

// A provider that could not be reached because this machine has no network has said nothing, so the file is left as it
// was, with no pause and no try counted toward that day and three tries. A run stops once that happens a few times
// close together: a blip costs a file or two, which the next run picks up.

// Lyrics the user reported (src/core/reports.ts) are not written, but a run leaves the file's own lyrics alone, reported or
// not: fixReported is what replaces them.

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
  | 'offline' // no network to ask a provider over; nothing recorded, asked on the next run
  | 'skipped' // a file or tag sleeve does not write to
  | 'failed';

export const TAG_STATUSES: TagStatus[] = ['written', 'would write', 'unchanged', 'has lyrics', 'instrumental', 'not found', 'doubtful', 'deferred', 'waiting', 'offline', 'skipped', 'failed'];

export interface TagReport {
  file: string;
  status: TagStatus;
  detail?: string;
  // On a doubtful file: what was held back, for someone to look at
  doubt?: FileDoubt;
}

export interface FileDoubt {
  query: TrackQuery;
  reason: string;
  // The synced lyrics found, best first: the first is what the reason is about
  candidates: ScoredCandidate[];
}

export interface TagOptions extends Pick<FetchOptions, 'providers' | 'timeoutMs' | 'fetch' | 'cache' | 'prefs' | 'userAgent' | 'tags'> {
  // Write; otherwise only say what would be written
  write?: boolean;
  // Replace a USLT that has text
  force?: boolean;
  // Write unsynced lyrics when no synced ones are found
  unsynced?: boolean;
  retries?: TagRetries;
  // Where writes that gave up on a provider are recorded
  fallbacks?: TagFallbacks;
  // Ask the providers those writes gave up on again, and do nothing else (see recheckFile)
  recheck?: boolean;
  // Replace lyrics the user reported in the files that hold them, and do nothing else (see fixReportedFile)
  fixReported?: boolean;
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
  // Told once when the run stops for want of a network
  onNetworkDown?: () => void;
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

// Forgets the deferred files no run over these paths would ever ask about again, which would otherwise stay for good: those no
// longer on disk, and those a directory's listing leaves out (listMp3s). Paths outside the given directories are left alone.
export function pruneRetries(paths: string[], retries: TagRetries): number {
  const roots = paths.map(given => path.resolve(given)).filter(root => statSync(root, { throwIfNoEntry: false })?.isDirectory());
  let forgotten = 0;
  for (const file of retries.paths()) {
    const relative = roots.map(root => path.relative(root, file)).find(inside => !inside.startsWith('..') && !path.isAbsolute(inside));
    if (relative === undefined) continue;
    if (existsSync(file) && !relative.split(path.sep).some(part => part.startsWith('.'))) continue;
    retries.clear(file);
    forgotten++;
  }
  return forgotten;
}

const time = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
const noNetwork = (errors: ProviderError[]) => `no network: ${errors.map(error => `${error.provider}: ${error.message}`).join('; ')}; asked on the next run`;

// How many files with no network, how close together, stop a run
export const OFFLINE_STOP_AFTER = 3;
export const OFFLINE_WINDOW_MS = 60_000;

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
  // Finding a file's track means reading its tags, which a library's files with lyrics otherwise never need
  const anyMarks = Boolean(options.prefs?.markCount());
  // Reports by file, held until the ones before them are in; null for a file not reported
  const done: Array<TagReport | null> = [];
  let reported = 0;
  let started = 0;
  let underWay = 0;
  let written = 0;
  let failure: { error: unknown } | null = null;
  let offlineAt: number[] = [];
  let networkGone = false;
  const noteOffline = () => {
    const at = now();
    offlineAt = [...offlineAt.filter(earlier => at - earlier <= OFFLINE_WINDOW_MS), at];
    if (networkGone || offlineAt.length < OFFLINE_STOP_AFTER) return;
    networkGone = true;
    options.onNetworkDown?.();
  };
  const flush = () => {
    for (; reported < started && done[reported] !== undefined; reported++) {
      const report = done[reported];
      if (!report) continue;
      counts[report.status]++;
      options.onFile?.(report);
    }
  };
  const more = () => started < files.length && !options.signal?.aborted && !failure && !networkGone
    && (options.limit === undefined || written + underWay < options.limit);
  const worker = async () => {
    while (more()) {
      const index = started++;
      underWay++;
      try {
        const report = await tagFile(files[index], { ...options, providers, fetch, anyMarks }, online, now);
        // Interrupted: only a file written counts, the rest is looked at again on the next run
        const counted = !options.signal?.aborted || report.status === 'written';
        done[index] = counted ? report : null;
        if (counted && report.status === 'offline') noteOffline();
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

// How far from fitting a candidate is, for looking at the likeliest first: the seconds its length is off, with lyrics that stop
// early or run past the end after all of those, whatever its length, since those are more often another song
export function doubtDistance(query: TrackQuery, candidate: ScoredCandidate): number {
  const span = doubts({ durationMs: query.durationMs, artist: query.artist, title: query.title }, { ...candidate, detail: { ...candidate.detail, duration: null } });
  const apart = query.durationMs && candidate.track.durationMs ? Math.abs(candidate.track.durationMs - query.durationMs) / 1000 : 0;
  return span ? 1_000_000 + apart : apart;
}

// What the user marked the file's track as; null for a file with no tags to look it up by
async function markOf(file: string, { prefs, tags }: TagOptions): Promise<TrackMark | null> {
  try {
    return prefs!.get(await queryForFile(file, {}, tags))?.mark ?? null;
  } catch {
    return null;
  }
}

// A file written from a later provider, asked about again: only the providers it gave up on are asked, and their synced
// lyrics replace the file's when they fit it. Lyrics that changed since, or a pick or mark made since, stay as they
// are, and so do the file's lyrics when those providers answer with nothing that fits; either way the file is done
// with. A provider failing again leaves the record for the next recheck. Without write, nothing is changed.
async function recheckFile(file: string, options: TagOptions & { fetch: typeof fetch }, online: Set<string>): Promise<TagReport> {
  const report = (status: TagStatus, detail?: string): TagReport => ({ file, status, ...(detail ? { detail } : {}) });
  const key = path.resolve(file);
  const record = options.fallbacks?.get(key);
  if (!record) return report('skipped', 'no fallback recorded');
  const done = (status: TagStatus, detail: string) => {
    if (options.write) options.fallbacks!.forget(key);
    return report(status, detail);
  };
  let tag;
  try {
    tag = await readLyricsTag(file);
  } catch (error) {
    return error instanceof Id3Error ? report('skipped', error.message) : report('failed', (error as Error).message);
  }
  if (!tag.uslt || lyricsHash(tag.uslt.text) !== record.textHash) return done('has lyrics', 'changed since the fallback; left alone');
  let query;
  try {
    query = await queryForFile(file, {}, options.tags);
  } catch (error) {
    return report('skipped', (error as Error).message);
  }
  const { fetch, cache, prefs, timeoutMs, userAgent, tags, signal } = options;
  const decided = prefs?.get(query);
  if (decided?.pick || decided?.mark) return done('has lyrics', 'picked or marked since the fallback; left alone');
  const providers = options.providers!.filter(provider => record.waitedFor.includes(provider.name));
  if (!providers.length) return report('skipped', `${record.waitedFor.join(', ')} not among the providers`);
  const result = await fetchLyrics(query, {
    providers, fetch,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(cache ? { cache } : {}), ...(prefs ? { prefs } : {}),
    ...(userAgent ? { userAgent } : {}), ...(tags ? { tags } : {}), ...(signal ? { signal } : {})
  });
  if (signal?.aborted) return report('failed', 'interrupted');
  const failed = result.errors.filter(error => online.has(error.provider));
  if (failed.some(error => error.offline)) return report('offline', noNetwork(failed));
  if (failed.length) return report('deferred', `${failed.map(error => error.provider).join(', ')} failed again; ${record.provider}'s lyrics stay until the next recheck`);
  const chosen = result.candidates.find(candidate => candidate.lyrics.synced && doubts(query, candidate) === null);
  if (!chosen) return done('has lyrics', `${record.waitedFor.join(', ')} has nothing that fits; ${record.provider}'s lyrics stay`);
  const text = formatLrc(chosen.lyrics, { words: false });
  const source = `${formatRef(chosen)}, synced, ${chosen.lyrics.lines.length} lines, replacing ${record.provider}'s lyrics`;
  if (tag.uslt.text === text) return done('unchanged', source);
  if (!options.write) return report('would write', source);
  try {
    await writeLyricsTag(tag, text);
  } catch (error) {
    if (error instanceof FileChangedError) return report('failed', 'changed while sleeve looked its lyrics up; run again');
    return error instanceof Id3Error ? report('skipped', error.message) : report('failed', (error as Error).message);
  }
  return done('written', source);
}

// What a file's lyrics text says, as the lyrics a provider would give
function lyricsInFile(text: string): Lyrics {
  if (looksLikeLrc(text)) return parseLrc(text);
  return { synced: false, instrumental: false, lines: text.split(/\r?\n/).filter(line => line.trim()).map(line => ({ time: null, text: line.trim() })) };
}

// The files among these whose track has reports: reading each one's tags, so only for a run asking for them
export async function reportedFiles(files: string[], { prefs, tags }: Pick<TagOptions, 'prefs' | 'tags'>): Promise<string[]> {
  if (!prefs?.reportCount()) return [];
  const found: string[] = [];
  for (const file of files) {
    try {
      if (prefs.get(await queryForFile(file, {}, tags))?.reports) found.push(file);
    } catch {
      // No tags to find its track by
    }
  }
  return found;
}

// A file whose track has reports: if it holds the lyrics reported, the best synced lyrics that fit it replace them (a pick
// goes in as it is). With nothing to replace them, the file stays as it is: no text gives way to unsynced lyrics, and display
// does not show what was reported anyway.
async function fixReportedFile(file: string, options: TagOptions & { fetch: typeof fetch }, online: Set<string>): Promise<TagReport> {
  const report = (status: TagStatus, detail?: string): TagReport => ({ file, status, ...(detail ? { detail } : {}) });
  let tag;
  try {
    tag = await readLyricsTag(file);
  } catch (error) {
    return error instanceof Id3Error ? report('skipped', error.message) : report('failed', (error as Error).message);
  }
  if (tag.usltCount > 1) return report('skipped', `${tag.usltCount} USLT frames`);
  let query;
  try {
    query = await queryForFile(file, {}, options.tags);
  } catch (error) {
    return report('skipped', (error as Error).message);
  }
  const { fetch, cache, prefs, timeoutMs, userAgent, tags, signal, providers } = options;
  const decided = prefs?.get(query);
  const existing = tag.uslt?.text.trim() ? tag.uslt.text : '';
  const reported = existing && decided?.reports ? reportFor({ provider: 'embedded', lyrics: lyricsInFile(existing) }, decided.reports, true) : null;
  if (!reported) return report('unchanged', 'the lyrics reported are not in this file');
  if (decided?.mark) return report('has lyrics', 'marked by you; the lyrics reported stay in the file');
  const result = await fetchLyrics(query, {
    providers: providers!, fetch, ...(prefs ? { prefs } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(cache ? { cache } : {}),
    ...(userAgent ? { userAgent } : {}), ...(tags ? { tags } : {}), ...(signal ? { signal } : {})
  });
  if (signal?.aborted) return report('failed', 'interrupted');
  const synced = result.candidates.filter(candidate => candidate.lyrics.synced);
  const chosen = result.pinned ? (result.best?.lyrics.synced ? result.best : null) : synced.find(candidate => doubts(query, candidate) === null) ?? null;
  const order = providers!.map(provider => provider.name);
  const failed = result.errors.filter(error => online.has(error.provider));
  const earlier = chosen ? failed.filter(error => order.indexOf(error.provider) < order.indexOf(chosen.provider)) : failed;
  if (earlier.some(error => error.offline)) return report('offline', noNetwork(earlier));
  if (earlier.length) return report('deferred', `${earlier.map(error => error.provider).join(', ')} failed; run again later`);
  if (!chosen) return report('has lyrics', `nothing else fits; the lyrics reported ${reported} stay in the file`);
  const text = formatLrc(shiftLyrics(chosen.lyrics, chosen === result.best ? result.offsetMs : 0), { words: false });
  const source = `${formatRef(chosen)}, synced, ${chosen.lyrics.lines.length} lines, replacing lyrics reported ${reported}`;
  if (!options.write) return report('would write', source);
  try {
    await writeLyricsTag(tag, text);
  } catch (error) {
    if (error instanceof FileChangedError) return report('failed', 'changed while sleeve looked its lyrics up; run again');
    return error instanceof Id3Error ? report('skipped', error.message) : report('failed', (error as Error).message);
  }
  options.fallbacks?.forget(path.resolve(file));
  return report('written', source);
}

async function tagFile(file: string, options: TagOptions & { fetch: typeof fetch; anyMarks: boolean }, online: Set<string>, now: () => number): Promise<TagReport> {
  if (options.recheck) return recheckFile(file, options, online);
  if (options.fixReported) return fixReportedFile(file, options, online);
  const report = (status: TagStatus, detail?: string): TagReport => ({ file, status, ...(detail ? { detail } : {}) });
  if (!/\.mp3$/i.test(file)) return report('skipped', 'not an mp3');
  let tag;
  try {
    tag = await readLyricsTag(file);
  } catch (error) {
    return error instanceof Id3Error ? report('skipped', error.message) : report('failed', (error as Error).message);
  }
  if (tag.usltCount > 1) return report('skipped', `${tag.usltCount} USLT frames`);
  // Marked by the user: never written, whatever the file has now, forced or not
  const mark = options.anyMarks ? await markOf(file, options) : null;
  if (mark) {
    options.retries?.clear(tag.file);
    const left = tag.uslt?.text.trim() ? '; the file still has lyrics' : '';
    return report(mark === 'none' ? 'not found' : 'instrumental', `marked by you${left}`);
  }
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
  const earlier = chosen ? failed.filter(error => order.indexOf(error.provider) < order.indexOf(chosen.provider)) : failed;
  if (earlier.some(error => error.offline)) return report('offline', noNetwork(earlier));
  // ...unless it has waited long enough for them, and the later provider has an answer
  const waitedOut = chosen !== null && earlier.length > 0 && gaveUp(retry, now());
  const waitFor = waitedOut ? [] : earlier;
  const fellBack = waitedOut ? `; ${earlier.map(error => error.provider).join(', ')} failing since ${time(retry!.firstAt)}` : '';
  if (waitFor.length) {
    const deferred = retries?.defer(tag.file, waitFor.map(error => `${error.provider}: ${error.message}`).join('; '));
    const held = chosen ? `; ${chosen.provider} has ${chosen.lyrics.instrumental ? 'it as instrumental' : 'lyrics'}, held until then` : '';
    return report('deferred', `${waitFor.map(error => error.provider).join(', ')} failed${held}${deferred ? `; again after ${time(deferred.nextAt)}` : ''}`);
  }
  if (chosen?.lyrics.instrumental) {
    retries?.clear(tag.file);
    return report('instrumental', `${formatRef(chosen)}${fellBack}`);
  }
  if (chosen && !chosen.lyrics.synced) text = plainText(chosen.lyrics);
  if (text === null || !chosen) {
    retries?.clear(tag.file);
    if (doubt) return { ...report('doubtful', doubt), doubt: { query, reason: doubt, candidates: synced } };
    if (keepsExisting) return report('has lyrics', 'unsynced; no synced lyrics found to replace them');
    return report('not found', best ? `only unsynced lyrics (${formatRef(best)}; --unsynced writes them)` : undefined);
  }
  const offsetMs = chosen === best ? result.offsetMs : 0;
  const source = `${formatRef(chosen)}, ${chosen.lyrics.synced ? 'synced' : 'unsynced'}, ${chosen.lyrics.lines.length} lines${offsetMs ? `, offset ${offsetMs > 0 ? '+' : ''}${offsetMs}ms` : ''}${existing && !looksLikeLrc(existing) ? ', replacing unsynced lyrics' : ''}${fellBack}`;
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
  if (waitedOut) options.fallbacks?.record(path.resolve(file), chosen.provider, earlier.map(error => error.provider), text);
  return report('written', source);
}
