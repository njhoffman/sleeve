import { expect } from 'chai';
import { LyricsCache } from '../../src/core/cache.ts';
import { fetchLyrics, queryForFile } from '../../src/core/fetchLyrics.ts';
import type { Provider } from '../../src/core/providers/provider.ts';
import type { FileTags, TagReader } from '../../src/core/tags/reader.ts';
import type { Candidate, Lyrics } from '../../src/core/types.ts';

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

  it('keeps going when a provider fails or hangs, reporting each', async () => {
    const result = await fetchLyrics(query, { timeoutMs: 50, providers: [
      provider('broken', false, async () => { throw new Error('connection refused'); }),
      provider('stuck', false, () => new Promise(() => {})),
      provider('working', false, async () => [answer('working', synced)])
    ] });
    expect(result.best?.provider).to.equal('working');
    expect(result.errors).to.deep.equal([{ provider: 'broken', message: 'connection refused' }, { provider: 'stuck', message: 'timed out' }]);
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
