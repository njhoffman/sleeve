import type { Candidate, TrackQuery } from '../types.ts';
import type { TagReader } from '../tags/reader.ts';

// What every provider is given: the HTTP client (fetch, replaced in tests), the signal that ends its turn
// (the per-provider timeout, or the caller giving up), the user agent online services ask for, and the tag
// reader for providers that look inside local files.
export interface ProviderContext {
  fetch: typeof fetch;
  signal: AbortSignal;
  userAgent: string;
  tags: TagReader;
}

// A source of lyrics. search() returns every candidate it has for the query, unscored, and [] when it has
// none or the query is not for it (an online-only track for a local provider). It throws on failures
// (network, a service error), which the caller reports without stopping the other providers.
export interface Provider {
  name: string;
  // Local providers are cheap and authoritative: they run first and need no network
  local: boolean;
  search(query: TrackQuery, context: ProviderContext): Promise<Candidate[]>;
  // What the service asks of clients that send many requests (a library run): the least time between two
  // requests to its host, and whether they go one at a time
  rateLimit?: RateLimit;
}

export interface RateLimit {
  host: string;
  gapMs: number;
  serial: boolean;
}

export class ProviderHttpError extends Error {
  status: number;

  constructor(provider: string, status: number, detail: string) {
    super(`${provider} answered ${status}${detail ? `: ${detail}` : ''}`);
    this.status = status;
  }
}
