import { expect } from 'chai';
import { LyricsCache } from '../../src/core/cache.ts';
import { fetchLyrics } from '../../src/core/fetchLyrics.ts';
import { TrackPrefs } from '../../src/core/prefs.ts';
import type { Provider } from '../../src/core/providers/provider.ts';
import { asUntimed, reportFor, wordsHash, type LyricsReport } from '../../src/core/reports.ts';
import type { Candidate, Lyrics, ScoredCandidate } from '../../src/core/types.ts';

const timed = (words: string[], start = 1000): Lyrics => ({ synced: true, instrumental: false, lines: words.map((text, index) => ({ time: start + index * 2000, text })) });
const plain: Lyrics = { synced: false, instrumental: false, lines: [{ time: null, text: 'Plain words' }] };
const rightWords = timed(['Right words', 'Second line']);
const otherWords = timed(['Another song', 'Altogether']);
const query = { artist: 'Artist', title: 'Song', durationMs: 200_000, path: '/m/song.mp3' };
const answer = (provider: string, id: string, lyrics: Lyrics, extra: Partial<Candidate> = {}): Candidate => ({ provider, id, track: { artist: 'Artist', title: 'Song', durationMs: 200_000 }, lyrics, ...extra });
const source = (name: string, local: boolean, candidates: Candidate[], asked: string[] = []): Provider => ({
  name, local, search: async () => { asked.push(name); return candidates; }
});
const report = (kind: LyricsReport['kind'], candidate: Candidate): LyricsReport => {
  const prefs = new TrackPrefs(':memory:');
  prefs.addReport(query, kind, candidate);
  const [made] = prefs.get(query)!.reports!;
  prefs.close();
  return made;
};

describe('reportFor', () => {
  const online = answer('lrclib', '1', otherWords);

  it('catches a candidate by its id, and the same words from anyone once they are wrong', () => {
    const wrong = report('wrong', online);
    expect(reportFor(online, [wrong], false)).to.equal('wrong');
    expect(reportFor(answer('embedded', '/m/song.mp3#USLT', timed(['ANOTHER song ', 'altogether'], 9000)), [wrong], true)).to.equal('wrong');
    expect(reportFor(answer('netease', '2', rightWords), [wrong], false)).to.equal(null);
  });

  it('catches the same times from anyone once they are mistimed, but not the same words at other times', () => {
    const mistimed = report('mistimed', online);
    expect(reportFor(answer('embedded', 'f#USLT', timed(['Another song', 'Altogether'], 1100)), [mistimed], true)).to.equal('mistimed');
    expect(reportFor(answer('netease', '2', timed(['Another song', 'Altogether'], 5000)), [mistimed], false)).to.equal(null);
    expect(reportFor(online, [mistimed, report('wrong', online)], false)).to.equal('wrong');
  });

  it('holds a local candidate by what it says, since its id names a file whose lyrics may be replaced', () => {
    const local = answer('embedded', '/m/song.mp3#USLT', otherWords);
    expect(reportFor(answer('embedded', '/m/song.mp3#USLT', rightWords), [report('wrong', local)], true)).to.equal(null);
  });

  it('never matches lyrics without words by their words', () => {
    const none: Lyrics = { synced: false, instrumental: true, lines: [] };
    expect(wordsHash(none)).to.equal('');
    const flagged = report('wrong', answer('lrclib', '1', none));
    expect(reportFor(answer('netease', '2', none), [flagged], false)).to.equal(null);
    expect(reportFor(answer('lrclib', '1', none), [flagged], false)).to.equal('wrong');
  });

  it('gives the words without times', () => {
    const scored = { ...answer('a', '1', { synced: true, instrumental: false, lines: [{ time: 5, text: 'x', words: [{ time: 5, text: 'x' }], translation: 'y' }] }), score: 1, detail: { title: 1, artist: 1, album: null, duration: null } } as ScoredCandidate;
    expect(asUntimed(scored).lyrics).to.deep.equal({ synced: false, instrumental: false, lines: [{ time: null, text: 'x', translation: 'y' }] });
    expect(asUntimed(scored).reported).to.equal('mistimed');
  });
});

describe('fetchLyrics with reports', () => {
  let prefs: TrackPrefs;
  beforeEach(() => { prefs = new TrackPrefs(':memory:'); });
  afterEach(() => prefs.close());

  const wrong = answer('lrclib', '1', otherWords);
  const right = answer('netease', '2', rightWords);

  it('shows the next best, listing what was reported with the rejected', async () => {
    prefs.addReport(query, 'wrong', wrong);
    const result = await fetchLyrics(query, { prefs, providers: [source('lrclib', false, [wrong]), source('netease', false, [right])] });
    expect(result.best!.provider).to.equal('netease');
    expect(result.candidates.map(item => item.provider)).to.deep.equal(['netease']);
    expect(result.rejected.map(item => [item.provider, item.reported])).to.deep.equal([['lrclib', 'wrong']]);
  });

  it('asks online when the lyrics in the file are the ones reported, and passes over the copy online too', async () => {
    const asked: string[] = [];
    const inFile = answer('embedded', '/m/song.mp3#USLT', otherWords, { exact: true });
    prefs.addReport(query, 'wrong', inFile);
    const providers = [source('embedded', true, [inFile]), source('lrclib', false, [wrong], asked), source('netease', false, [right], asked)];
    const result = await fetchLyrics(query, { prefs, providers });
    expect(asked).to.have.members(['lrclib', 'netease']);
    expect(result.best!.provider).to.equal('netease');
  });

  it('shows nothing, without marking, when nothing else is found', async () => {
    prefs.addReport(query, 'wrong', wrong);
    const result = await fetchLyrics(query, { prefs, providers: [source('lrclib', false, [wrong])] });
    expect(result).to.deep.include({ best: null, pinned: false });
    expect(result.marked).to.equal(undefined);
    expect(prefs.get(query)!.mark).to.equal(undefined);
  });

  it('prefers other timing of the words, then any other lyrics, then the words without times', async () => {
    prefs.addReport(query, 'mistimed', wrong);
    const elsewhere = answer('netease', '2', timed(['Another song', 'Altogether'], 7000));
    const retimed = await fetchLyrics(query, { prefs, providers: [source('lrclib', false, [wrong]), source('netease', false, [elsewhere])] });
    expect(retimed.best!.provider).to.equal('netease');
    expect(retimed.best!.lyrics.synced).to.equal(true);

    const unsynced = await fetchLyrics(query, { prefs, providers: [source('lrclib', false, [wrong]), source('netease', false, [answer('netease', '3', plain)])] });
    expect(unsynced.best!.id).to.equal('3');

    const alone = await fetchLyrics(query, { prefs, providers: [source('lrclib', false, [wrong])] });
    expect(alone.best).to.deep.include({ provider: 'lrclib', id: '1', reported: 'mistimed' });
    expect(alone.best!.lyrics.synced).to.equal(false);
    expect(alone.best!.lyrics.lines.map(line => line.time)).to.deep.equal([null, null]);
    expect(alone.candidates).to.deep.equal([]);
    expect(alone.rejected[0].lyrics.synced).to.equal(true);
  });

  it('does not offer what was reported in a partial answer', async () => {
    prefs.addReport(query, 'wrong', wrong);
    const partials: Array<string | undefined> = [];
    let release!: () => void;
    const slow: Provider = { name: 'slow', local: false, search: () => new Promise(resolve => { release = () => resolve([]); }) };
    const pending = fetchLyrics(query, { prefs, providers: [source('lrclib', false, [wrong]), slow], onPartial: result => partials.push(result.best?.provider) });
    await new Promise(resolve => setTimeout(resolve, 5));
    release();
    await pending;
    expect(partials).to.deep.equal([]);
  });

  it('keeps the cache as the provider said it, and lists reports with all', async () => {
    const cache = new LyricsCache(':memory:');
    prefs.addReport(query, 'wrong', wrong);
    const providers = [source('lrclib', false, [wrong])];
    await fetchLyrics(query, { prefs, cache, providers });
    expect(cache.get('lrclib', query)!.candidates).to.have.length(1);
    const all = await fetchLyrics(query, { prefs, cache, providers, all: true });
    expect(all.rejected[0]).to.deep.include({ id: '1', reported: 'wrong' });
    cache.close();
  });

  it('ignores reports with --no-prefs', async () => {
    prefs.addReport(query, 'wrong', wrong);
    expect((await fetchLyrics(query, { providers: [source('lrclib', false, [wrong])] })).best!.id).to.equal('1');
  });
});
