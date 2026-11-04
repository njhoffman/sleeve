import { expect } from 'chai';
import { LyricsCache } from '../../src/core/cache.ts';
import { fetchLyrics, queryForFile } from '../../src/core/fetchLyrics.ts';
import { TrackPrefs } from '../../src/core/prefs.ts';
import type { Provider } from '../../src/core/providers/provider.ts';
import type { FileTags, TagReader } from '../../src/core/tags/reader.ts';
import type { Candidate, Lyrics, LyricsResult } from '../../src/core/types.ts';
import { until } from '../helpers/fakeMpd.ts';

const synced: Lyrics = { synced: true, instrumental: false, lines: [{ time: 1000, text: 'synced' }] };
const unsynced: Lyrics = { synced: false, instrumental: false, lines: [{ time: null, text: 'plain' }] };
const query = { artist: 'Artist', title: 'Song', durationMs: 200_000, path: '/m/song.mp3' };

function provider(name: string, local: boolean, search: Provider['search']): Provider {
  return { name, local, search };
}

const answer = (name: string, lyrics: Lyrics, extra: Partial<Candidate> = {}): Candidate => ({
  provider: name, track: { artist: 'Artist', title: 'Song', durationMs: 200_000 }, lyrics, ...extra
});

describe('fetchLyrics', () => {
  it('stops at a local file\'s synced lyrics, and asks everyone with all', async () => {
    const asked: string[] = [];
    const providers = [
      provider('sidecar', true, async () => { asked.push('sidecar'); return [answer('sidecar', synced, { exact: true })]; }),
      provider('online', false, async () => { asked.push('online'); return [answer('online', synced)]; })
    ];
    const result = await fetchLyrics(query, { providers });
    expect(asked).to.deep.equal(['sidecar']);
    expect(result.best?.provider).to.equal('sidecar');

    const everything = await fetchLyrics(query, { providers, all: true });
    expect(asked).to.deep.equal(['sidecar', 'sidecar', 'online']);
    expect(everything.candidates.map(item => item.provider)).to.deep.equal(['sidecar', 'online']);
  });

  it('goes online when local lyrics are only unsynced, and prefers synced ones from there', async () => {
    const result = await fetchLyrics(query, { providers: [
      provider('embedded', true, async () => [answer('embedded', unsynced, { exact: true })]),
      provider('online', false, async () => [answer('online', synced)])
    ] });
    expect(result.candidates.map(item => item.provider)).to.deep.equal(['online', 'embedded']);
  });

  it('reports the result so far while slower providers are still out', async () => {
    let release: () => void = () => {};
    const slow = provider('slow', false, async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return [answer('slow', synced, { id: 's' })];
    });
    const partials: LyricsResult[] = [];
    const pending = fetchLyrics(query, { onPartial: result => partials.push(result), providers: [
      slow,
      provider('fast', false, async () => [answer('fast', unsynced, { id: 'f' })]),
      provider('broken', false, async () => { throw new Error('503'); })
    ] });
    await until(() => partials.length === 2);
    expect(partials.map(result => result.best?.provider)).to.deep.equal(['fast', 'fast']);
    expect(partials[1].errors).to.deep.equal([{ provider: 'broken', message: '503' }]);
    release();
    const result = await pending;
    expect(result.best?.provider).to.equal('slow');
    expect(partials).to.have.length(2);

    // Nothing passing yet, or every candidate asked for: nothing early
    const none: LyricsResult[] = [];
    const empty = provider('empty', false, async () => []);
    await fetchLyrics(query, { onPartial: result => none.push(result), providers: [empty, provider('other', false, async () => [answer('other', synced)])] });
    await fetchLyrics(query, { all: true, onPartial: result => none.push(result), providers: [provider('a', false, async () => [answer('a', synced)]), empty] });
    expect(none).to.deep.equal([]);
  });

  it('keeps going when a provider fails or hangs, reporting each', async () => {
    const result = await fetchLyrics(query, { timeoutMs: 50, providers: [
      provider('broken', false, async () => { throw new Error('connection refused'); }),
      provider('stuck', false, () => new Promise(() => {})),
      provider('working', false, async () => [answer('working', synced)])
    ] });
    expect(result.best?.provider).to.equal('working');
    expect(result.errors).to.deep.equal([{ provider: 'broken', message: 'connection refused' }, { provider: 'stuck', message: 'timed out' }]);
  });

  it('ranks the length most candidates share first when the query has none', async () => {
    const at = (id: string, durationMs: number): Candidate => ({ ...answer('p', synced), id, track: { artist: 'Artist', title: 'Song', durationMs } });
    // The live one has more lines, which used to decide among equal scores
    const live = { ...at('live', 328_000), lyrics: { ...synced, lines: [...synced.lines, { time: 2000, text: 'more' }] } };
    const result = await fetchLyrics({ artist: 'Artist', title: 'Song' }, { providers: [provider('p', false, async () => [live, at('a', 251_000), at('b', 251_500)])] });
    expect(result.candidates.map(candidate => candidate.id)).to.deep.equal(['a', 'b', 'live']);
  });

  it('rejects candidates under the threshold but returns them', async () => {
    const result = await fetchLyrics(query, { providers: [
      provider('online', false, async () => [answer('online', synced, { track: { artist: 'Artist', title: 'Song', durationMs: 260_000 } })])
    ] });
    expect(result.best).to.equal(null);
    expect(result.candidates).to.deep.equal([]);
    expect(result.rejected.map(item => item.provider)).to.deep.equal(['online']);
  });

  it('reads a file\'s tags once for every provider', async () => {
    let reads = 0;
    const tags: TagReader = { read: async () => { reads++; return { lyrics: [] }; } };
    const reading = (name: string) => provider(name, true, async (q, context) => { await context.tags.read(q.path!); return []; });
    await fetchLyrics(query, { tags, providers: [reading('one'), reading('two')] });
    expect(reads).to.equal(1);
  });

  describe('with a cache', () => {
    let cache: LyricsCache, asked: string[];
    beforeEach(() => {
      cache = new LyricsCache(':memory:');
      asked = [];
    });
    afterEach(() => cache.close());

    const online = (name: string, result: () => Promise<Candidate[]>) => provider(name, false, async () => { asked.push(name); return result(); });

    it('stores online answers, found or not, and serves them instead of asking again', async () => {
      const providers = [online('found', async () => [answer('found', synced)]), online('empty', async () => [])];
      await fetchLyrics(query, { providers, cache });
      const again = await fetchLyrics(query, { providers, cache });
      expect(asked).to.deep.equal(['found', 'empty']);
      expect(again.best?.provider).to.equal('found');
      expect(again.best?.cachedAt).to.be.a('number');
    });

    it('holds answers to Latin script, stored ones included, and keeps what the provider said in the cache', async () => {
      const chinese: Lyrics = { synced: true, instrumental: false, lines: [{ time: 0, text: '你好' }] };
      const mixed: Lyrics = { synced: true, instrumental: false, lines: [1, 2, 3, 4, 5].map(n => ({ time: n * 1000, text: `line ${n}` })).concat({ time: 9000, text: '作词 : Someone' }) };
      const providers = [online('mixed', async () => [answer('mixed', mixed)]), online('chinese', async () => [answer('chinese', chinese)])];
      const first = await fetchLyrics(query, { providers, cache });
      const again = await fetchLyrics(query, { providers, cache });
      for (const result of [first, again]) {
        expect(result.candidates.map(item => item.provider)).to.deep.equal(['mixed']);
        expect(result.best!.lyrics.lines).to.have.length(5);
      }
      expect(cache.get('chinese', query)!.candidates[0].lyrics.lines[0].text).to.equal('你好');
    });

    it('asks again with refresh and replaces the stored answer', async () => {
      let lyrics = unsynced;
      const providers = [online('changing', async () => [answer('changing', lyrics)])];
      await fetchLyrics(query, { providers, cache });
      lyrics = synced;
      const refreshed = await fetchLyrics(query, { providers, cache, refresh: true });
      expect(refreshed.best?.lyrics.synced).to.equal(true);
      expect(refreshed.best?.cachedAt).to.equal(undefined);
      expect((await fetchLyrics(query, { providers, cache })).best?.lyrics.synced).to.equal(true);
      expect(asked).to.have.length(2);
    });

    it('does not store failures or local answers', async () => {
      const providers = [
        provider('sidecar', true, async () => [answer('sidecar', unsynced, { exact: true })]),
        online('broken', async () => { throw new Error('503'); })
      ];
      await fetchLyrics(query, { providers, cache });
      expect(cache.stats().answers).to.equal(0);
    });

    it('reports a cache that fails and still answers', async () => {
      const failing = { get: () => { throw new Error('database is locked'); }, put: () => { throw new Error('database is locked'); } } as unknown as LyricsCache;
      const result = await fetchLyrics(query, { providers: [online('found', async () => [answer('found', synced)])], cache: failing });
      expect(result.best?.provider).to.equal('found');
      expect(result.errors).to.deep.equal([{ provider: 'cache', message: 'database is locked' }, { provider: 'cache', message: 'database is locked' }]);
    });
  });
});

describe('fetchLyrics with prefs', () => {
  let prefs: TrackPrefs, asked: string[];
  beforeEach(() => {
    prefs = new TrackPrefs(':memory:');
    asked = [];
  });
  afterEach(() => prefs.close());

  const good = answer('good', synced, { id: 'g1' });
  // Wrong length, so it scores under the threshold
  const off = answer('off', { ...synced, lines: [{ time: 5000, text: 'other' }] }, { id: 'o1', track: { artist: 'Artist', title: 'Song', durationMs: 260_000 } });
  const online = (item: Candidate) => provider(item.provider, false, async () => { asked.push(item.provider); return [item]; });

  it('answers with an online pick, even one under the threshold, without asking anyone', async () => {
    prefs.setPick(query, off);
    const result = await fetchLyrics(query, { prefs, providers: [online(good), online(off)] });
    expect(asked).to.deep.equal([]);
    expect(result.best).to.deep.include({ provider: 'off', id: 'o1' });
    expect(result.best!.score).to.be.below(0.6);
    expect(result).to.deep.include({ pinned: true, offsetMs: 0, rejected: [], errors: [] });
  });

  it('puts the pick first among every candidate with all', async () => {
    prefs.setPick(query, off);
    const result = await fetchLyrics(query, { prefs, all: true, providers: [online(good), online(off)] });
    expect(asked).to.deep.equal(['good', 'off']);
    expect(result.candidates.map(item => item.provider)).to.deep.equal(['off', 'good']);
    expect(result.rejected).to.deep.equal([]);
    expect(result.pinned).to.equal(true);
  });

  it('answers a marked track with nothing, asking nobody, the file included; all still lists what there is', async () => {
    const prefs = new TrackPrefs(':memory:');
    const asked: string[] = [];
    const providers = [
      provider('embedded', true, async () => { asked.push('embedded'); return [answer('embedded', synced, { id: 'e', exact: true })]; }),
      provider('online', false, async () => { asked.push('online'); return [answer('online', synced, { id: 'o' })]; })
    ];
    prefs.setMark(query, 'none');
    const result = await fetchLyrics(query, { providers, prefs });
    expect(asked).to.deep.equal([]);
    expect(result).to.deep.include({ best: null, marked: 'none', pinned: true, offsetMs: 0 });
    const everything = await fetchLyrics(query, { providers, prefs, all: true });
    expect(everything).to.deep.include({ best: null, marked: 'none', pinned: true });
    expect(everything.candidates.map(item => item.provider)).to.deep.equal(['embedded', 'online']);
    prefs.setPick(query, everything.candidates[1]);
    const picked = await fetchLyrics(query, { providers, prefs });
    expect(picked.best?.provider).to.equal('online');
    expect(picked.marked).to.equal(undefined);
    prefs.close();
  });

  it('ignores a pick in another alphabet', async () => {
    const prefs = new TrackPrefs(':memory:');
    prefs.setPick(query, answer('far', { synced: true, instrumental: false, lines: [{ time: 0, text: '你好' }] }, { id: '9' }));
    const result = await fetchLyrics(query, { providers: [provider('far', false, async () => [answer('far', synced, { id: '1' })])], prefs });
    expect(result.pinned).to.equal(false);
    expect(result.best?.id).to.equal('1');
    prefs.close();
  });

  it('ignores a pick whose provider is not asked', async () => {
    prefs.setPick(query, off);
    const result = await fetchLyrics(query, { prefs, providers: [online(good)] });
    expect(result).to.deep.include({ pinned: false });
    expect(result.best?.provider).to.equal('good');
  });

  it('reads a local pick again, and ranks as usual when it is gone', async () => {
    let text = 'first';
    const sidecar = provider('sidecar', true, async () => text ? [answer('sidecar', { ...synced, lines: [{ time: 0, text }] }, { id: '/m/song.lrc', exact: true })] : []);
    const providers = [sidecar, online(good)];
    prefs.setPick(query, answer('sidecar', synced, { id: '/m/song.lrc' }));
    text = 'edited';
    const edited = await fetchLyrics(query, { prefs, providers });
    expect(edited.best?.lyrics.lines[0].text).to.equal('edited');
    expect(edited.pinned).to.equal(true);
    expect(asked).to.deep.equal([]);

    text = '';
    const gone = await fetchLyrics(query, { prefs, providers });
    expect(gone).to.deep.include({ pinned: false });
    expect(gone.best?.provider).to.equal('good');
    expect(gone.errors).to.deep.equal([{ provider: 'prefs', message: 'picked sidecar:/m/song.lrc is no longer there; ranking as usual' }]);
  });

  it('gives the offset only for the candidate it was set against', async () => {
    prefs.setOffset(query, 250, good);
    expect((await fetchLyrics(query, { prefs, providers: [online(good)] })).offsetMs).to.equal(250);
    const result = await fetchLyrics(query, { prefs, providers: [online(good)] });
    expect(result.best?.lyrics.lines[0].time).to.equal(1000);
    prefs.setPick(query, answer('other', synced, { id: 'x' }));
    expect((await fetchLyrics(query, { prefs, providers: [online(good), online(answer('other', synced, { id: 'x' }))] })).offsetMs).to.equal(0);
  });

  it('reports prefs that cannot be read and answers anyway', async () => {
    const failing = { get: () => { throw new Error('database is locked'); } } as unknown as TrackPrefs;
    const result = await fetchLyrics(query, { prefs: failing, providers: [online(good)] });
    expect(result.best?.provider).to.equal('good');
    expect(result.errors).to.deep.equal([{ provider: 'prefs', message: 'database is locked' }]);
  });
});

describe('queryForFile', () => {
  const reader = (tags: Partial<FileTags>): TagReader => ({ read: async () => ({ lyrics: [], ...tags }) });

  it('takes the file\'s tags, its measured duration over Spotify\'s, and lets the caller override', async () => {
    const tags = reader({ artist: 'A', title: 'T', album: 'Al', durationMs: 180_500, spotifyDurationMs: 181_000, isrc: 'ISRC1', spotifyId: 'sp1' });
    expect(await queryForFile('/m/a.mp3', {}, tags)).to.deep.equal({
      artist: 'A', title: 'T', album: 'Al', durationMs: 180_500, isrc: 'ISRC1', spotifyId: 'sp1', path: '/m/a.mp3'
    });
    expect(await queryForFile('/m/a.mp3', { title: 'Other', durationMs: 1000 }, tags)).to.deep.include({ title: 'Other', durationMs: 1000 });
    expect(await queryForFile('/m/a.mp3', {}, reader({ artist: 'A', title: 'T', spotifyDurationMs: 181_000 }))).to.deep.include({ durationMs: 181_000 });
  });

  it('needs an artist and a title from somewhere', async () => {
    const error = await queryForFile('/m/a.mp3', {}, reader({ title: 'T' })).catch(caught => caught);
    expect(error.message).to.equal('/m/a.mp3 has no artist or title tag; pass --artist and --title');
  });
});
