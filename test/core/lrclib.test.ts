import { expect } from 'chai';
import { createLrclib, toCandidate, type LrclibRecord } from '../../src/core/providers/lrclib.ts';
import type { ProviderContext } from '../../src/core/providers/provider.ts';
import { fakeFetch, fixture, type Route } from '../helpers/fetch.ts';

const deathCab = fixture('lrclib/get-death-cab-interior-decorator.json') as LrclibRecord;
const search = fixture('lrclib/search-radiohead-right-place.json') as LrclibRecord[];
const overloaded = fixture('lrclib/overloaded.json');

describe('LRCLIB provider', () => {
  const provider = createLrclib({ retryDelayMs: 1 });

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
