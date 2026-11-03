// A fetch that spaces the requests to each service (a URL's host) at least gapMs apart by when they start. Every
// lookup that goes through the same one shares the spacing, so files looked up at once ask a service no faster
// than one lookup at a time would, and a lookup the cache answers waits for nothing. A request whose signal ends
// while it waits is not sent. The wait counts against the provider's timeout, so a gap stays well under it.

export interface ThrottleOptions {
  gapMs: number;
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

export function throttledFetch(fetch: typeof globalThis.fetch, { gapMs, now = Date.now, sleep = wait }: ThrottleOptions): typeof globalThis.fetch {
  // When the next request to each host may start
  const next = new Map<string, number>();
  return async (input, init) => {
    const host = hostOf(input);
    const at = Math.max(now(), next.get(host) ?? -Infinity);
    next.set(host, at + gapMs);
    const ms = at - now();
    if (ms > 0) await sleep(ms, init?.signal ?? undefined);
    else if (init?.signal?.aborted) throw init.signal.reason;
    return fetch(input, init);
  };
}
