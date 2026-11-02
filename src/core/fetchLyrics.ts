import pkg from '../../package.json' with { type: 'json' };
import { rankCandidates, scoreCandidate, THRESHOLD } from './match.ts';
import { lrclib } from './providers/lrclib.ts';
import { embedded, sidecar } from './providers/local.ts';
import type { Provider, ProviderContext } from './providers/provider.ts';
import { musicMetadataReader } from './tags/musicMetadata.ts';
import type { FileTags, TagReader } from './tags/reader.ts';
import type { LyricsResult, ProviderError, ScoredCandidate, TrackQuery } from './types.ts';

// Lyrics for a track from every provider, each a fallback for the others. Local providers (an .lrc next to the
// file, the file's own tags) run first; when one of them has synced lyrics, those are the answer and nothing
// goes online unless `all` asks for every candidate. Online providers run in parallel, each with its own
// timeout, and a provider that fails or times out is reported in errors without holding up the rest.

export const DEFAULT_PROVIDERS: Provider[] = [sidecar, embedded, lrclib];
export const DEFAULT_TIMEOUT_MS = 10_000;

export interface FetchOptions {
  providers?: Provider[];
  // Per provider, in milliseconds
  timeoutMs?: number;
  // Ask every provider, even after a local file gave synced lyrics
  all?: boolean;
  fetch?: typeof fetch;
  tags?: TagReader;
  userAgent?: string;
  signal?: AbortSignal;
}

export const USER_AGENT = `sleeve/${pkg.version} (https://github.com/njhoffman/sleeve)`;

// One read per file for every provider that asks
function memoized(reader: TagReader): TagReader {
  const reads = new Map<string, Promise<FileTags>>();
  return {
    read(file: string) {
      if (!reads.has(file)) reads.set(file, reader.read(file));
      return reads.get(file)!;
    }
  };
}

function message(error: unknown, signal: AbortSignal): string {
  if (signal.aborted && signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError') return 'timed out';
  return error instanceof Error ? error.message : String(error);
}

async function run(providers: Provider[], query: TrackQuery, options: Required<Pick<FetchOptions, 'timeoutMs' | 'fetch' | 'userAgent'>> & { tags: TagReader; signal?: AbortSignal }) {
  const errors: ProviderError[] = [];
  const results = await Promise.all(providers.map(async provider => {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    const context: ProviderContext = { fetch: options.fetch, signal, userAgent: options.userAgent, tags: options.tags };
    try {
      return await Promise.race([
        provider.search(query, context),
        // A provider that ignores its signal still ends its turn at the timeout
        new Promise<never>((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      ]);
    } catch (error) {
      errors.push({ provider: provider.name, message: message(error, signal) });
      return [];
    }
  }));
  return { candidates: results.flat().map(candidate => scoreCandidate(query, candidate)), errors };
}

export async function fetchLyrics(query: TrackQuery, options: FetchOptions = {}): Promise<LyricsResult> {
  const providers = options.providers ?? DEFAULT_PROVIDERS;
  const settings = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetch: options.fetch ?? globalThis.fetch,
    userAgent: options.userAgent ?? USER_AGENT,
    tags: memoized(options.tags ?? musicMetadataReader),
    ...(options.signal ? { signal: options.signal } : {})
  };
  const local = await run(providers.filter(provider => provider.local), query, settings);
  const haveSynced = local.candidates.some(candidate => candidate.score >= THRESHOLD && candidate.lyrics.synced);
  const online = haveSynced && !options.all
    ? { candidates: [] as ScoredCandidate[], errors: [] as ProviderError[] }
    : await run(providers.filter(provider => !provider.local), query, settings);
  const all = [...local.candidates, ...online.candidates];
  const candidates = rankCandidates(all.filter(candidate => candidate.score >= THRESHOLD));
  const rejected = rankCandidates(all.filter(candidate => candidate.score < THRESHOLD));
  return { best: candidates[0] ?? null, candidates, rejected, errors: [...local.errors, ...online.errors] };
}

// A query for a local file from its tags, with what the caller already knows taking precedence. The
// duration is the audio's own, since synced lyrics must fit what plays; Spotify's comes second.
export async function queryForFile(file: string, given: Partial<TrackQuery> = {}, tags: TagReader = musicMetadataReader): Promise<TrackQuery> {
  const read = await tags.read(file);
  const artist = given.artist ?? read.artist;
  const title = given.title ?? read.title;
  if (!artist || !title) throw new Error(`${file} has no artist or title tag; pass --artist and --title`);
  const durationMs = given.durationMs ?? read.durationMs ?? read.spotifyDurationMs;
  const album = given.album ?? read.album;
  const isrc = given.isrc ?? read.isrc;
  const spotifyId = given.spotifyId ?? read.spotifyId;
  return {
    artist, title, path: file,
    ...(album ? { album } : {}),
    ...(durationMs ? { durationMs } : {}),
    ...(isrc ? { isrc } : {}),
    ...(spotifyId ? { spotifyId } : {})
  };
}
