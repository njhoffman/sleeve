import type { RateLimit } from './providers/provider.ts';

// A fetch that spaces the requests to each service (a URL's host) at least gapMs apart by when they start. Every
// lookup that goes through the same one shares the spacing, so files looked up at once ask a service no faster
// than one lookup at a time would, and a lookup the cache answers waits for nothing. A service's own rate limit
// (a provider's rateLimit) raises the gap for its host, never lowers it, and a serial one also has its requests
// sent one at a time: each waits for the one before it to be answered. A request whose signal ends while it
// waits is not sent. The wait counts against the provider's timeout, so a gap stays well under it.

export interface ThrottleOptions {
  gapMs: number;
  limits?: RateLimit[];
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', abort);
    resolve();
  }, ms);
  const abort = () => {
    clearTimeout(timer);
    reject(signal!.reason);
  };
  signal?.addEventListener('abort', abort, { once: true });
});

function hostOf(input: Parameters<typeof fetch>[0]): string {
  const url = input instanceof Request ? input.url : String(input);
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// Resolves when done does, or rejects when the signal ends first
function until(done: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return done;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    done.then(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    });
  });
}

export function throttledFetch(fetch: typeof globalThis.fetch, { gapMs, limits = [], now = Date.now, sleep = wait }: ThrottleOptions): typeof globalThis.fetch {
  const byHost = new Map(limits.map(limit => [limit.host, limit]));
  // When the next request to each host may start
  const next = new Map<string, number>();
  // For serial hosts: settles once every request sent or queued so far has been answered
  const queues = new Map<string, Promise<void>>();

  const send = async (host: string, gap: number, input: Parameters<typeof fetch>[0], init: RequestInit | undefined) => {
    const at = Math.max(now(), next.get(host) ?? -Infinity);
    next.set(host, at + gap);
    const ms = at - now();
    if (ms > 0) await sleep(ms, init?.signal ?? undefined);
    else if (init?.signal?.aborted) throw init.signal.reason;
    return fetch(input, init);
  };

  return async (input, init) => {
    const host = hostOf(input);
    const limit = byHost.get(host);
    const gap = Math.max(gapMs, limit?.gapMs ?? 0);
    if (!limit?.serial) return send(host, gap, input, init);
    const before = queues.get(host) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>(resolve => { release = resolve; });
    // The next request waits for this one and for every one before it, even if this one gives up early
    queues.set(host, before.then(() => mine));
    try {
      await until(before, init?.signal ?? undefined);
      return await send(host, gap, input, init);
    } finally {
      release();
    }
  };
}
