import { expect } from 'chai';
import { bestSongs, isPureMusic, netease, stripCredits, trackOf, type NeteaseSong } from '../../src/core/providers/netease.ts';
import type { ProviderContext } from '../../src/core/providers/provider.ts';
import { fakeFetch, fixture, type Route } from '../helpers/fetch.ts';

const deathCabSearch = fixture('netease/search-death-cab-interior-decorator.json');
const radioheadSearch = fixture('netease/search-radiohead-right-place.json') as { result: { songs: NeteaseSong[] } };
const deathCabLyric = fixture('netease/lyric-17286440.json');
const radioheadLyric = fixture('netease/lyric-22559034.json');

describe('NetEase provider', () => {
  function context(routes: Route[]) {
    const fake = fakeFetch(routes);
    const value: ProviderContext = {
      fetch: fake.fetch, signal: new AbortController().signal, userAgent: 'sleeve-test',
      tags: { read: async () => { throw new Error('not used'); } }
    };
    return { context: value, calls: fake.calls };
  }

  const deathCab = { artist: 'Death Cab for Cutie', title: 'Death of an Interior Decorator', durationMs: 176_600 };

  it('searches title and artist, fetches lyrics only for the best-scored songs, and drops credit lines', async () => {
    const { context: ctx, calls } = context([
      { match: /\/api\/search\/get\?/, body: deathCabSearch },
      { match: /\/api\/song\/lyric\?id=17286440&/, body: deathCabLyric },
      { match: /\/api\/song\/lyric\?/, body: { code: 200, nolyric: true } }
    ]);
    const candidates = await netease.search(deathCab, ctx);
    const search = new URL(calls[0].url);
    expect(Object.fromEntries(search.searchParams)).to.deep.equal({ s: 'Death of an Interior Decorator Death Cab for Cutie', type: '1', limit: '20', offset: '0' });
    expect(calls[0].headers['User-Agent']).to.equal('sleeve-test');
    // Two lyric fetches, for the two songs that match the title, artist and length; demos and covers are left out
    const fetched = calls.slice(1).map(call => new URL(call.url).searchParams.get('id'));
    expect(fetched).to.have.length(2);
    expect(fetched).to.include('17286440');
    const found = candidates.find(candidate => candidate.id === '17286440')!;
    expect(found.track).to.deep.equal({ artist: 'Death Cab for Cutie', title: 'Death Of An Interior Decorator', album: 'Transatlanticism', durationMs: 176626 });
    expect(found.lyrics.synced).to.equal(true);
    expect(found.lyrics.lines[0]).to.deep.equal({ time: 20570, text: 'You were the mother of three girls so sweet' });
  });

  it('picks the album version by length among live recordings', () => {
    const songs = bestSongs({ artist: 'Radiohead', title: 'Everything In Its Right Place', durationMs: 251_000 }, radioheadSearch.result.songs, 20);
    expect(songs.length).to.be.greaterThan(0);
    expect(songs.every(song => Math.abs((song.duration ?? 0) - 251_000) < 10_000)).to.equal(true);
    expect(songs.map(song => song.album?.name)).to.include('Kid A').and.not.include('Live at Bonnaroo 2006');
  });

  it('strips Chinese and English credit lines but keeps lyrics', async () => {
    const { context: ctx } = context([
      { match: /\/api\/search\/get\?/, body: radioheadSearch },
      { match: /\/api\/song\/lyric\?/, body: radioheadLyric }
    ]);
    const [candidate] = await netease.search({ artist: 'Radiohead', title: 'Everything In Its Right Place', durationMs: 251_000 }, ctx);
    expect(candidate.lyrics.lines.slice(0, 2).map(line => line.text)).to.deep.equal(['Kid A  Kid A', 'Kid A  Kid A']);
    const lines = stripCredits({ synced: true, instrumental: false, lines: [
      { time: 0, text: '作词 : Someone' }, { time: 1, text: '作曲：Someone' }, { time: 2, text: 'Composer: X' }, { time: 3, text: 'Producer: the words' }, { time: 4, text: 'Real line' }
    ] }).lines;
    expect(lines.map(line => line.text)).to.deep.equal(['Real line']);
  });

  it('marks songs NetEase says have no lyrics as instrumental, and skips empty ones', async () => {
    const song = radioheadSearch.result.songs[0];
    const { context: ctx } = context([
      { match: /\/api\/search\/get\?/, body: { code: 200, result: { songs: [song, { ...song, id: 99 }] } } },
      { match: /\/api\/song\/lyric\?id=99&/, body: { code: 200, lrc: { lyric: '' } } },
      { match: /\/api\/song\/lyric\?/, body: { code: 200, nolyric: true } }
    ]);
    const candidates = await netease.search({ artist: 'Radiohead', title: 'Everything In Its Right Place', durationMs: 251_000 }, ctx);
    expect(candidates.map(candidate => [candidate.id, candidate.lyrics.instrumental])).to.deep.equal([[String(song.id), true]]);
  });

  it('makes a song instrumental when its only lyrics say it is pure music', async () => {
    const song = radioheadSearch.result.songs[0];
    const { context: ctx } = context([
      { match: /\/api\/search\/get\?/, body: { code: 200, result: { songs: [song] } } },
      { match: /\/api\/song\/lyric\?/, body: { code: 200, lrc: { lyric: '[00:00.00] 作曲 : Thom Yorke\n[00:05.00]纯音乐，请欣赏\n' } } }
    ]);
    const candidates = await netease.search({ artist: 'Radiohead', title: 'Everything In Its Right Place', durationMs: 251_000 }, ctx);
    expect(candidates.map(candidate => candidate.lyrics)).to.deep.equal([{ synced: false, instrumental: true, lines: [] }]);

    const lines = (...texts: string[]) => ({ synced: true, instrumental: false, lines: texts.map((text, index) => ({ time: index * 1000, text })) });
    expect(isPureMusic(lines('此歌曲为没有填词的纯音乐，请您欣赏'))).to.equal(true);
    expect(isPureMusic(lines('纯音乐, 请欣赏', ''))).to.equal(true);
    expect(isPureMusic({ synced: false, instrumental: false, lines: [{ time: null, text: '纯音乐' }] })).to.equal(true);
    // Real lyrics that mention it, or nothing at all, are not
    expect(isPureMusic(lines('纯音乐，请欣赏', 'Hello there'))).to.equal(false);
    expect(isPureMusic(lines('我喜欢纯音乐'))).to.equal(false);
    expect(isPureMusic(lines(''))).to.equal(false);
  });

  it('has nothing when the search finds nothing that could match', async () => {
    const { context: ctx, calls } = context([{ match: /\/api\/search\/get\?/, body: deathCabSearch }]);
    expect(await netease.search({ artist: 'Someone Else', title: 'Another Song', durationMs: 200_000 }, ctx)).to.deep.equal([]);
    expect(calls).to.have.length(1);
    const empty = context([{ match: /\/api\/search\/get\?/, body: { code: 200, result: {} } }]);
    expect(await netease.search(deathCab, empty.context)).to.deep.equal([]);
  });

  it('reports errors given as HTTP failures or as codes in the body', async () => {
    const refused = context([{ match: /\/api\/search\/get\?/, body: { code: -460, message: 'Cheating' } }]);
    expect((await netease.search(deathCab, refused.context).catch(error => error)).message).to.equal('NetEase answered -460: Cheating');
    const down = context([{ match: /\/api\/search\/get\?/, status: 502, body: 'Bad gateway' }]);
    expect((await netease.search(deathCab, down.context).catch(error => error)).message).to.equal('NetEase answered 502: Bad gateway');
  });

  it('joins several artists', () => {
    expect(trackOf({ id: 1, name: 'T', artists: [{ name: 'A' }, { name: 'B' }], album: null, duration: 1000 })).to.deep.equal({ artist: 'A, B', title: 'T', durationMs: 1000 });
  });
});
