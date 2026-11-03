import { parseLrc } from '../lrc.ts';
import type { Candidate, Lyrics, TrackQuery } from '../types.ts';
import { ProviderHttpError, type Provider, type ProviderContext, type RateLimit } from './provider.ts';

// LRCLIB (https://lrclib.net): free, keyless, synced LRC. /api/get matches artist, title, album and a
// duration within about 2 seconds, and answers 404 when it has nothing; /api/search returns up to 20 records
// by artist and title. A get hit is the best candidate, so search only runs when get misses or when no
// duration is known (get needs one). The service answers 503 "ServerOverloaded" under load, mostly for
// lookups it has not cached, so a 503 or 429 is retried once after a short pause, or after its Retry-After, which
// also keeps every other request back until it has run out. Overloads often last minutes;
// sleeved asks again later (src/now/session.ts) rather than holding the lookup up here.
//
// Its rate limit (https://lrclib.net/docs, "Rate Limiting") is about 90 requests a minute per IP for a client
// that names itself in its User-Agent, and it asks batch clients to send requests one at a time with a pause
// between them: rateLimit keeps a library run to about 85 a minute.

const BASE = 'https://lrclib.net/api';
const RETRIES = 1;
const RETRY_DELAY_MS = 1000;
// A hold with no more than this left is waited out rather than failed: a 503's Retry-After is usually 1 s, and
// failing every lookup during it would defer a run's files by the dozen without asking. Half the provider timeout.
export const MAX_HOLD_WAIT_MS = 5000;
export const LRCLIB_RATE_LIMIT: RateLimit = { host: 'lrclib.net', gapMs: 700, serial: true };

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

const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const abort = () => {
    clearTimeout(timer);
    reject(signal.reason);
  };
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', abort);
    resolve();
  }, ms);
  signal.addEventListener('abort', abort, { once: true });
});

// Retry-After in milliseconds: seconds, or an HTTP date; null when missing or unreadable
export function retryAfterMs(value: string | null, now: number): number | null {
  if (!value?.trim()) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export class LrclibHeldError extends Error {
  until: number;

  constructor(until: number) {
    super(`LRCLIB asked to wait until ${new Date(until).toLocaleTimeString()} (Retry-After); not asked`);
    this.until = until;
  }
}

interface Retry {
  retries: number;
  retryDelayMs: number;
}

interface Clock {
  now: () => number;
  random: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

// Until when LRCLIB asked not to be sent anything (its Retry-After), for every lookup through one provider
interface Hold {
  until: number;
}

// The parsed JSON of a GET, or null for 404; retries 429 and 503, throws on other failures. A Retry-After on
// either is honored, as LRCLIB's docs require: nothing is sent until it has run out (plus up to 30% jitter, so
// throttled clients do not come back all at once), and a retry waits at least that long. A lookup made during a
// hold waits for its end when that is at most MAX_HOLD_WAIT_MS away, and fails without asking otherwise.
async function request(path: string, params: Record<string, string>, context: ProviderContext, retry: Retry, clock: Clock, hold: Hold): Promise<unknown> {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    const left = hold.until - clock.now();
    if (left > MAX_HOLD_WAIT_MS) throw new LrclibHeldError(hold.until);
    if (left > 0) await clock.sleep(left, context.signal);
    const response = await context.fetch(url, { headers: { 'User-Agent': context.userAgent, Accept: 'application/json' }, signal: context.signal });
    if (response.status === 404) return null;
    if (response.ok) return response.json();
    if (response.status === 503 || response.status === 429) {
      const asked = retryAfterMs(response.headers.get('Retry-After'), clock.now());
      const holdMs = asked === null ? 0 : Math.ceil(asked * (1 + 0.3 * clock.random()));
      if (holdMs) hold.until = Math.max(hold.until, clock.now() + holdMs);
      if (attempt < retry.retries) {
        await clock.sleep(Math.max(holdMs, retry.retryDelayMs * (attempt + 1)), context.signal);
        continue;
      }
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

// Retries wait retryDelayMs, then twice that, and so on, or longer when LRCLIB says how long
export function createLrclib({ retries = RETRIES, retryDelayMs = RETRY_DELAY_MS, now = Date.now, random = Math.random, sleep = wait }: Partial<Retry & Clock> = {}): Provider {
  const retry = { retries, retryDelayMs };
  const clock = { now, random, sleep };
  const hold: Hold = { until: 0 };
  return {
    name: 'lrclib',
    local: false,
    rateLimit: LRCLIB_RATE_LIMIT,

    async search(query: TrackQuery, context: ProviderContext): Promise<Candidate[]> {
      if (query.durationMs) {
        const record = await request('/get', {
          artist_name: query.artist,
          track_name: query.title,
          ...(query.album ? { album_name: query.album } : {}),
          duration: String(Math.round(query.durationMs / 1000))
        }, context, retry, clock, hold) as LrclibRecord | null;
        const candidate = record && toCandidate(record);
        if (candidate) return [candidate];
      }
      const records = await request('/search', { artist_name: query.artist, track_name: query.title }, context, retry, clock, hold) as LrclibRecord[] | null;
      return (records ?? []).map(toCandidate).filter((candidate): candidate is Candidate => candidate !== null);
    }
  };
}

export const lrclib = createLrclib();
