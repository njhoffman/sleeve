import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A fetch stand-in for provider tests: answers each request from a list of routes and records the calls, so
// tests never reach the network. Recorded responses live in test/fixtures/<provider>/.

export interface Route {
  // Matched against the request URL
  match: RegExp;
  status?: number;
  body?: unknown;
  // Answers in turn for repeated requests to the same route; the last one repeats
  sequence?: Array<{ status: number; body?: unknown }>;
}

export interface FakeFetch {
  fetch: typeof fetch;
  calls: Array<{ url: string; headers: Record<string, string> }>;
}

export function fixture(path: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${path}`, import.meta.url)), 'utf8'));
}

export function fakeFetch(routes: Route[]): FakeFetch {
  const calls: FakeFetch['calls'] = [];
  const counts = new Map<Route, number>();
  const fetch: typeof globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    if (init?.signal?.aborted) throw init.signal.reason;
    const route = routes.find(item => item.match.test(url));
    if (!route) return new Response('{"message":"no route"}', { status: 404 });
    const count = counts.get(route) ?? 0;
    counts.set(route, count + 1);
    const answer = route.sequence ? route.sequence[Math.min(count, route.sequence.length - 1)] : { status: route.status ?? 200, body: route.body };
    const body = answer.body === undefined ? null : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
    return new Response(body, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
