import { parseLrc } from '../lrc.ts';
import type { Candidate, Lyrics, TrackQuery } from '../types.ts';
import { ProviderHttpError, type Provider, type ProviderContext } from './provider.ts';

// LRCLIB (https://lrclib.net): free, keyless, synced LRC. /api/get matches artist, title, album and a
// duration within about 2 seconds, and answers 404 when it has nothing; /api/search returns up to 20 records
// by artist and title. A get hit is the best candidate, so search only runs when get misses or when no
// duration is known (get needs one). The service answers 503 "ServerOverloaded" under load, mostly for
// lookups it has not cached, so a 503 or 429 is retried once after a short pause. Overloads often last minutes;
// sleeved asks again later (src/now/session.ts) rather than holding the lookup up here.

const BASE = 'https://lrclib.net/api';
const RETRIES = 1;
const RETRY_DELAY_MS = 1000;

// One LRCLIB record, as /api/get and /api/search return it
export interface LrclibRecord {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string | null;
  // Seconds
  duration?: number | null;
  instrumental?: boolean;
  hasWordSync?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

function lyricsOf(record: LrclibRecord): Lyrics | null {
  if (record.syncedLyrics?.trim()) return { ...parseLrc(record.syncedLyrics), instrumental: false };
  if (record.plainLyrics?.trim()) {
    return { synced: false, instrumental: false, lines: record.plainLyrics.split(/\r?\n/).map(text => ({ time: null, text: text.trim() })) };
  }
  if (record.instrumental) return { synced: false, instrumental: true, lines: [] };
  return null;
}

export function toCandidate(record: LrclibRecord): Candidate | null {
  const lyrics = lyricsOf(record);
  if (!lyrics) return null;
  return {
    provider: 'lrclib',
    id: String(record.id),
    track: {
      artist: record.artistName,
      title: record.trackName,
      ...(record.albumName ? { album: record.albumName } : {}),
      ...(record.duration ? { durationMs: Math.round(record.duration * 1000) } : {})
    },
    lyrics
  };
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(signal.reason);
  }, { once: true });
});

interface Retry {
  retries: number;
  retryDelayMs: number;
}

// The parsed JSON of a GET, or null for 404; retries 429 and 503, throws on other failures
async function request(path: string, params: Record<string, string>, context: ProviderContext, retry: Retry): Promise<unknown> {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    const response = await context.fetch(url, { headers: { 'User-Agent': context.userAgent, Accept: 'application/json' }, signal: context.signal });
    if (response.status === 404) return null;
    if (response.ok) return response.json();
    if ((response.status === 503 || response.status === 429) && attempt < retry.retries) {
      await sleep(retry.retryDelayMs * (attempt + 1), context.signal);
      continue;
    }
    const body = await response.text().catch(() => '');
    let detail = body.slice(0, 200);
    try {
      detail = (JSON.parse(body) as { message?: string }).message ?? detail;
    } catch {
      // not JSON: the start of the body
    }
    throw new ProviderHttpError('LRCLIB', response.status, detail);
  }
}

// Retries wait retryDelayMs, then twice that, and so on
export function createLrclib({ retries = RETRIES, retryDelayMs = RETRY_DELAY_MS }: Partial<Retry> = {}): Provider {
  const retry = { retries, retryDelayMs };
  return {
    name: 'lrclib',
    local: false,

    async search(query: TrackQuery, context: ProviderContext): Promise<Candidate[]> {
      if (query.durationMs) {
        const record = await request('/get', {
          artist_name: query.artist,
          track_name: query.title,
          ...(query.album ? { album_name: query.album } : {}),
          duration: String(Math.round(query.durationMs / 1000))
        }, context, retry) as LrclibRecord | null;
        const candidate = record && toCandidate(record);
        if (candidate) return [candidate];
      }
      const records = await request('/search', { artist_name: query.artist, track_name: query.title }, context, retry) as LrclibRecord[] | null;
      return (records ?? []).map(toCandidate).filter((candidate): candidate is Candidate => candidate !== null);
    }
  };
}

export const lrclib = createLrclib();
