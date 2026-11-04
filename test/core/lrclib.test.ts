import { expect } from 'chai';
import { createLrclib, lrclibAppIdFile, LrclibHeldError, MAX_HOLD_WAIT_MS, readLrclibAppId, retryAfterMs, toCandidate, type LrclibRecord } from '../../src/core/providers/lrclib.ts';
import type { ProviderContext } from '../../src/core/providers/provider.ts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fakeFetch, fixture, type Route } from '../helpers/fetch.ts';

const deathCab = fixture('lrclib/get-death-cab-interior-decorator.json') as LrclibRecord;
const search = fixture('lrclib/search-radiohead-right-place.json') as LrclibRecord[];
const overloaded = fixture('lrclib/overloaded.json');

describe('LRCLIB provider', () => {
  const provider = createLrclib({ retryDelayMs: 1, appId: () => null });

  describe('the application id', () => {
    it('is sent on every request when there is one, and read once', async () => {
      let reads = 0;
      const named = createLrclib({ appId: () => { reads++; return 'app-1'; } });
      const { context: ctx, calls } = context([{ match: /\/api\/get\?/, status: 404 }, { match: /\/api\/search\?/, body: search }]);
      await named.search(query, ctx);
      await named.search(query, ctx);
      expect(calls.map(call => call.headers['Lrclib-App-Id'])).to.deep.equal(['app-1', 'app-1', 'app-1', 'app-1']);
      expect(reads).to.equal(1);
    });

    it('is left out when there is none', async () => {
      const { context: ctx, calls } = context([{ match: /\/api\/get\?/, body: deathCab }]);
      await provider.search(query, ctx);
      expect(calls[0].headers).to.not.have.property('Lrclib-App-Id');
    });

    it('comes from the first line of a file in the config directory', async () => {
      const folder = await mkdtemp(path.join(os.tmpdir(), 'sleeve-lrclib-'));
      const file = lrclibAppIdFile({ XDG_CONFIG_HOME: folder });
      expect(file).to.equal(path.join(folder, 'sleeve', 'lrclib-app-id'));
      expect(readLrclibAppId(file)).to.equal(null);
      await mkdir(path.dirname(file));
      await writeFile(file, '  app-2  \nanything else\n');
      expect(readLrclibAppId(file)).to.equal('app-2');
      await writeFile(file, '\n');
      expect(readLrclibAppId(file)).to.equal(null);
      await rm(folder, { recursive: true });
    });
  });

  function context(routes: Route[]) {
    const fake = fakeFetch(routes);
    const value: ProviderContext = {
      fetch: fake.fetch, signal: new AbortController().signal, userAgent: 'sleeve-test',
      tags: { read: async () => { throw new Error('not used'); } }
    };
    return { context: value, calls: fake.calls };
  }

  const query = { artist: 'Death Cab for Cutie', title: 'Death of an Interior Decorator', album: 'Transatlanticism', durationMs: 176_600 };

  it('asks /api/get with the duration in seconds and returns its record as a synced candidate', async () => {
    const { context: ctx, calls } = context([{ match: /\/api\/get\?/, body: deathCab }]);
    const [candidate, ...rest] = await provider.search(query, ctx);
    expect(rest).to.deep.equal([]);
    const url = new URL(calls[0].url);
    expect(url.pathname).to.equal('/api/get');
    expect(Object.fromEntries(url.searchParams)).to.deep.equal({
      artist_name: 'Death Cab for Cutie', track_name: 'Death of an Interior Decorator', album_name: 'Transatlanticism', duration: '177'
    });
    expect(calls[0].headers['User-Agent']).to.equal('sleeve-test');
    expect(candidate.track).to.deep.equal({ artist: 'Death Cab for Cutie', title: 'Death of an Interior Decorator', album: 'Transatlanticism', durationMs: 177000 });
    expect(candidate).to.include({ provider: 'lrclib', id: '321980' });
    expect(candidate.lyrics.synced).to.equal(true);
    expect(candidate.lyrics.lines[0]).to.deep.equal({ time: 18730, text: 'You were the mother of three girls so sweet' });
  });

  it('searches when get misses, and only searches without a duration', async () => {
    const missed = context([{ match: /\/api\/get\?/, status: 404, body: { message: 'Failed to find specified track' } }, { match: /\/api\/search\?/, body: search }]);
    const candidates = await provider.search({ artist: 'Radiohead', title: 'Everything In Its Right Place', durationMs: 251_000 }, missed.context);
    expect(missed.calls.map(call => new URL(call.url).pathname)).to.deep.equal(['/api/get', '/api/search']);
    expect(candidates.map(item => item.track.durationMs)).to.deep.equal([251000, 251000, 328000, 429000]);

    const noDuration = context([{ match: /\/api\/search\?/, body: search }]);
    await provider.search({ artist: 'Radiohead', title: 'Everything In Its Right Place' }, noDuration.context);
    expect(noDuration.calls.map(call => new URL(call.url).pathname)).to.deep.equal(['/api/search']);
  });

  describe('Retry-After', () => {
    // A clock the test moves; sleeping moves it too
    const clocked = (retries: number) => {
      let clock = 1_000_000;
      const slept: number[] = [];
      const lrclib = createLrclib({ retries, retryDelayMs: 1000, now: () => clock, random: () => 0.5, sleep: async ms => { slept.push(ms); clock += ms; } });
      return { lrclib, slept, advance: (ms: number) => { clock += ms; } };
    };
    const limited = { message: 'Too many requests from this IP address.', name: 'RateLimitExceeded', statusCode: 429, scope: 'ip' };

    it('sends nothing until it has run out, with jitter, after a 429 that says how long', async () => {
      const { lrclib, advance } = clocked(0);
      const busy = context([{ match: /\/api\/get\?/, sequence: [{ status: 429, body: limited, headers: { 'Retry-After': '20' } }, { status: 200, body: deathCab }] }]);
      expect((await lrclib.search(query, busy.context).catch(caught => caught)).status).to.equal(429);
      // 20 s and 15% of it (random 0.5 of the 30%): nothing is sent before 23 s, and 5.1 s before is too long to wait
      advance(17_900);
      const held = await lrclib.search(query, busy.context).catch(caught => caught);
      expect(held).to.be.instanceOf(LrclibHeldError);
      expect(busy.calls).to.have.length(1);
      advance(5200);
      expect(await lrclib.search(query, busy.context)).to.have.length(1);
      expect(busy.calls).to.have.length(2);
    });

    it('waits out a short hold instead of failing, as after a 503 that asks for a second', async () => {
      const { lrclib, slept } = clocked(0);
      const busy = context([{ match: /\/api\/get\?/, sequence: [{ status: 503, body: overloaded, headers: { 'Retry-After': '1' } }, { status: 200, body: deathCab }] }]);
      expect((await lrclib.search(query, busy.context).catch(caught => caught)).status).to.equal(503);
      // 1 s and 15% of it
      expect(await lrclib.search(query, busy.context)).to.have.length(1);
      expect(slept).to.deep.equal([1150]);
      expect(busy.calls).to.have.length(2);
    });

    it('fails without asking when a hold has more than MAX_HOLD_WAIT_MS left, and waits once it has less', async () => {
      const { lrclib, slept, advance } = clocked(0);
      const busy = context([{ match: /\/api\/get\?/, sequence: [{ status: 429, body: limited, headers: { 'Retry-After': '10' } }, { status: 200, body: deathCab }] }]);
      await lrclib.search(query, busy.context).catch(() => undefined);
      // Held until 11.5 s: 6.5 s left, then 5 s
      advance(5000);
      expect(await lrclib.search(query, busy.context).catch(caught => caught)).to.be.instanceOf(LrclibHeldError);
      advance(1500);
      expect(await lrclib.search(query, busy.context)).to.have.length(1);
      expect(slept).to.deep.equal([MAX_HOLD_WAIT_MS]);
    });

    it('stops waiting for a hold when the lookup is cancelled', async () => {
      const lrclib = createLrclib({ retries: 0 });
      const busy = context([{ match: /\/api\/get\?/, sequence: [{ status: 503, body: overloaded, headers: { 'Retry-After': '3' } }, { status: 200, body: deathCab }] }]);
      await lrclib.search(query, busy.context).catch(() => undefined);
      const controller = new AbortController();
      const waiting = lrclib.search(query, { ...busy.context, signal: controller.signal }).catch(caught => caught);
      controller.abort(new Error('cancelled'));
      expect((await waiting).message).to.equal('cancelled');
      expect(busy.calls).to.have.length(1);
    });

    it('retries no sooner than it says, and as before when it does not say', async () => {
      const told = clocked(1);
      const busy = context([{ match: /\/api\/get\?/, sequence: [{ status: 503, body: overloaded, headers: { 'Retry-After': '4' } }, { status: 200, body: deathCab }] }]);
      expect(await told.lrclib.search(query, busy.context)).to.have.length(1);
      expect(told.slept).to.deep.equal([4600]);

      const untold = clocked(1);
      const quiet = context([{ match: /\/api\/get\?/, sequence: [{ status: 503, body: overloaded }, { status: 200, body: deathCab }] }]);
      expect(await untold.lrclib.search(query, quiet.context)).to.have.length(1);
      expect(untold.slept).to.deep.equal([1000]);
    });

    it('reads seconds and HTTP dates', () => {
      expect(retryAfterMs('30', 0)).to.equal(30_000);
      expect(retryAfterMs(new Date(90_000).toUTCString(), 30_000)).to.equal(60_000);
      expect(retryAfterMs('soon', 0)).to.equal(null);
      expect(retryAfterMs(null, 0)).to.equal(null);
    });
  });

  it('retries an overloaded service, then gives up with its message', async () => {
    const recovering = context([{ match: /\/api\/get\?/, sequence: [{ status: 503, body: overloaded }, { status: 200, body: deathCab }] }]);
    expect(await provider.search(query, recovering.context)).to.have.length(1);
    expect(recovering.calls).to.have.length(2);

    const down = context([{ match: /\/api\/get\?/, status: 503, body: overloaded }]);
    const error = await provider.search(query, down.context).catch(caught => caught);
    expect(error.message).to.equal('LRCLIB answered 503: The server is busy, please retry in a moment');
    expect(error.status).to.equal(503);
    // The first try and one retry
    expect(down.calls).to.have.length(2);
  });

  it('does not retry other errors, and reports a body that is not JSON', async () => {
    const broken = context([{ match: /\/api\/get\?/, status: 500, body: 'Internal error' }]);
    expect((await provider.search(query, broken.context).catch(caught => caught)).message).to.equal('LRCLIB answered 500: Internal error');
    expect(broken.calls).to.have.length(1);
  });

  it('turns records into candidates: plain lyrics unsynced, instrumentals empty, empty records dropped', () => {
    const base = { id: 1, trackName: 'T', artistName: 'A', duration: 100 };
    expect(toCandidate({ ...base, plainLyrics: 'one\ntwo' })?.lyrics).to.deep.equal({
      synced: false, instrumental: false, lines: [{ time: null, text: 'one' }, { time: null, text: 'two' }]
    });
    expect(toCandidate({ ...base, instrumental: true })?.lyrics).to.deep.equal({ synced: false, instrumental: true, lines: [] });
    expect(toCandidate({ ...base, plainLyrics: '', syncedLyrics: null })).to.equal(null);
    expect(toCandidate({ ...base, albumName: null, duration: null, plainLyrics: 'x' })?.track).to.deep.equal({ artist: 'A', title: 'T' });
  });
});
