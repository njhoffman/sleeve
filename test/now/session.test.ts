import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TrackPrefs } from '../../src/core/prefs.ts';
import type { LyricsResult, ScoredCandidate, TrackQuery } from '../../src/core/types.ts';
import { lineAt, NowPlaying, queryForPlayback, takeLater, type NowState } from '../../src/now/session.ts';
import { PlayerHub } from '../../src/players/hub.ts';
import type { MusicmanLibrary } from '../../src/players/musicman.ts';
import type { Playback, PlayingTrack } from '../../src/players/types.ts';
import { until } from '../helpers/fakeMpd.ts';
import { writeTaggedMp3 } from '../helpers/id3.ts';
import { fakePlayer } from '../helpers/players.ts';

const best: ScoredCandidate = {
  provider: 'lrclib', id: '1', track: { artist: 'A', title: 'T' }, score: 1, detail: { title: 1, artist: 1, album: null, duration: null },
  lyrics: { synced: true, instrumental: false, lines: [{ time: 1000, text: 'one' }, { time: 3000, text: 'two' }] }
};
const result = (offsetMs = 0): LyricsResult => ({ best, candidates: [best], rejected: [], errors: [], pinned: false, offsetMs });
const spotifyTrack: PlayingTrack = { key: 'sp1', artist: 'A', title: 'T', album: 'Al', durationMs: 200_000, spotifyId: 'sp1' };
const library = (durationMs?: number) => ({ fileFor: (id: string) => id === 'sp1' ? { file: '/nowhere/a.mp3', ...(durationMs ? { durationMs } : {}) } : null }) as unknown as MusicmanLibrary;

describe('queryForPlayback', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'sleeve-now-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('asks for a local file by its own tags and length', async () => {
    const file = await writeTaggedMp3(path.join(dir, 'a.mp3'), { artist: 'Tagged', title: 'Song', isrc: 'X1' });
    const query = await queryForPlayback({ key: file, artist: 'MPD says', title: 'other', file });
    expect(query).to.deep.include({ artist: 'Tagged', title: 'Song', isrc: 'X1', path: file });
    expect(query!.durationMs).to.be.within(2900, 3100);
  });

  it('falls back to what the player says when the file cannot be read', async () => {
    expect(await queryForPlayback({ key: 'k', artist: 'A', title: 'T', durationMs: 1000, file: '/nowhere/a.mp3' }))
      .to.deep.equal({ artist: 'A', title: 'T', durationMs: 1000, path: '/nowhere/a.mp3' });
    expect(await queryForPlayback({ key: 'k', artist: '', title: 'T', file: '/nowhere/a.mp3' })).to.equal(null);
    expect(await queryForPlayback({ key: 'k', artist: '', title: 'T' })).to.equal(null);
  });

  it('gives a Spotify track its library file only when the lengths agree', async () => {
    const plain = { artist: 'A', title: 'T', album: 'Al', durationMs: 200_000, spotifyId: 'sp1' };
    expect(await queryForPlayback(spotifyTrack)).to.deep.equal(plain);
    expect(await queryForPlayback(spotifyTrack, { library: library(201_500) })).to.deep.equal({ ...plain, path: '/nowhere/a.mp3' });
    expect(await queryForPlayback(spotifyTrack, { library: library(203_000) })).to.deep.equal(plain);
    expect(await queryForPlayback(spotifyTrack, { library: library() })).to.deep.equal({ ...plain, path: '/nowhere/a.mp3' });
  });
});

describe('lineAt', () => {
  it('finds the line playing, shifted by the offset', () => {
    expect(lineAt(result(), 500)).to.deep.equal({ index: -1, line: null, time: null });
    expect(lineAt(result(), 1000)).to.deep.include({ index: 0, time: 1000 });
    expect(lineAt(result(), 9000)).to.deep.include({ index: 1, time: 3000 });
    expect(lineAt(result(500), 1200)).to.deep.equal({ index: -1, line: null, time: null });
    expect(lineAt(result(-500), 2600)).to.deep.include({ index: 1, time: 2500 });
    expect(lineAt(null, 1000).index).to.equal(-1);
    expect(lineAt({ ...result(), best: { ...best, lyrics: { ...best.lyrics, synced: false } } }, 5000).index).to.equal(-1);
  });
});

describe('NowPlaying', () => {
  const playing = (track: PlayingTrack, positionMs = 0): Playback => ({ player: 'spotify', state: 'playing', track, positionMs, at: 0, rate: 1, changedAt: 0 });

  it('looks lyrics up once per track and drops a lookup overtaken by the next track', async () => {
    const player = fakePlayer('spotify');
    const hub = new PlayerHub([player]);
    hub.start();
    const asked: TrackQuery[] = [];
    let release: () => void = () => {};
    const lookup = async (query: TrackQuery) => {
      asked.push(query);
      if (query.title === 'Slow') await new Promise<void>(resolve => { release = resolve; });
      return result();
    };
    const session = new NowPlaying(hub, { lookup });
    session.start();
    expect(session.current()).to.deep.include({ playback: null, loading: false });

    player.set(playing({ ...spotifyTrack, key: 'slow', title: 'Slow' }));
    await until(() => asked.length === 1);
    player.set(playing({ ...spotifyTrack, key: 'fast', title: 'Fast' }));
    const state = await session.settled();
    expect(state).to.deep.include({ loading: false, result: result() });
    expect(state.query?.title).to.equal('Fast');
    release();
    await new Promise(resolve => setImmediate(resolve));
    expect(session.current().query?.title).to.equal('Fast');

    player.set(playing({ ...spotifyTrack, key: 'fast', title: 'Fast' }, 5000));
    expect(asked).to.have.length(2);
    expect(session.position(1000)).to.equal(6000);
    expect(session.line(0).index).to.equal(1);

    player.set(null);
    expect(session.current()).to.deep.include({ playback: null, query: null, result: null });
    session.close();
  });

  it('nudges the offset for the track and remembers it', async () => {
    const prefs = new TrackPrefs(':memory:');
    const player = fakePlayer('spotify', { playback: playing(spotifyTrack) });
    const hub = new PlayerHub([player]);
    hub.start();
    const session = new NowPlaying(hub, { lookup: async () => result(), prefs });
    session.start();
    await session.settled();
    expect(session.nudge(100)).to.equal(100);
    expect(session.nudge(100)).to.equal(200);
    expect(prefs.get(spotifyTrack as unknown as TrackQuery)?.offset).to.deep.equal({ ms: 200, provider: 'lrclib', id: '1' });
    expect(session.line(0).index).to.equal(-1);
    session.nudge(-200);
    expect(prefs.get(spotifyTrack as unknown as TrackQuery)).to.equal(null);

    player.set(playing({ ...spotifyTrack, key: 'x', artist: '' }));
    await session.settled();
    expect(session.nudge(100)).to.equal(null);
    prefs.close();
  });

  it('keeps a failed lookup as an error', async () => {
    const player = fakePlayer('spotify', { playback: playing(spotifyTrack) });
    const session = new NowPlaying(new PlayerHub([player]), { lookup: async () => { throw new Error('disk full'); } });
    session.start();
    expect(await session.settled()).to.deep.include({ error: 'disk full', loading: false, result: null });
  });
});

describe('NowPlaying seek', () => {
  const playback = (player: string, state: Playback['state']): Playback => ({ player, state, track: spotifyTrack, positionMs: 0, at: 0, rate: 1, changedAt: 0 });

  it('seeks in the active player, kept within the track', async () => {
    const mpd = fakePlayer('mpd', { playback: playback('mpd', 'paused') });
    const spotify = fakePlayer('spotify', { playback: playback('spotify', 'playing') });
    const session = new NowPlaying(new PlayerHub([mpd, spotify]), { lookup: async () => result() });
    session.start();
    await session.settled();
    expect(await session.seek(61_500)).to.equal(61_500);
    expect(await session.seek(999_000)).to.equal(200_000);
    expect(spotify.seeks).to.deep.equal([61_500, 200_000]);
    expect(mpd.seeks).to.deep.equal([]);
    session.close();
  });

  it('refuses when nothing plays, and passes on a player\'s refusal', async () => {
    const player = fakePlayer('spotify');
    const session = new NowPlaying(new PlayerHub([player]), { lookup: async () => result() });
    session.start();
    await session.settled();
    const refusal = () => session.seek(1000).then(() => '', error => String(error));
    expect(await refusal()).to.include('Nothing playing');
    player.seek = async () => { throw new Error('spotify cannot seek in this track'); };
    (session as unknown as { state: NowState }).state = { ...session.current(), playback: playback('spotify', 'playing') };
    player.current = () => playback('spotify', 'playing');
    expect(await refusal()).to.include('cannot seek');
    session.close();
  });
});

describe('NowPlaying commands', () => {
  const playing = (track: PlayingTrack): Playback => ({ player: 'spotify', state: 'playing', track, positionMs: 0, at: 0, rate: 1, changedAt: 0 });
  const other: ScoredCandidate = { ...best, provider: 'netease', id: '9', score: 0.4 };
  let prefs: TrackPrefs;
  let calls: Array<{ all?: boolean; refresh?: boolean }>;
  // Answers as fetchLyrics would: the pick first when there is one, every candidate with all
  const lookup = async (query: TrackQuery, options: { all?: boolean; refresh?: boolean } = {}): Promise<LyricsResult> => {
    calls.push({ ...(options.all ? { all: true } : {}), ...(options.refresh ? { refresh: true } : {}) });
    const pick = prefs.get(query)?.pick;
    if (pick) return { ...result(), best: { ...other, ...pick }, pinned: true };
    return options.all ? { ...result(), rejected: [other] } : result();
  };
  const started = async (options: { prefs?: TrackPrefs | null } = {}) => {
    const session = new NowPlaying(new PlayerHub([fakePlayer('spotify', { playback: playing(spotifyTrack) })]), {
      lookup: lookup as never, ...(options.prefs === null ? {} : { prefs })
    });
    session.start();
    await session.settled();
    return session;
  };
  beforeEach(() => {
    prefs = new TrackPrefs(':memory:');
    calls = [];
  });
  afterEach(() => prefs.close());

  it('refreshes, keeping the lyrics shown until the new answer is in', async () => {
    const session = await started();
    const states: NowState[] = [];
    session.onChange(state => states.push(state));
    await session.refresh();
    expect(calls).to.deep.equal([{}, { refresh: true }]);
    expect(states[0]).to.deep.include({ loading: true, result: result() });
    expect(session.current()).to.deep.include({ loading: false, result: result() });
  });

  it('lists every candidate without changing what is shown', async () => {
    const session = await started();
    const all = await session.candidates();
    expect(all.rejected).to.deep.equal([other]);
    expect(calls.at(-1)).to.deep.equal({ all: true });
    expect(session.current().result).to.deep.equal(result());
  });

  it('picks a candidate, asking every provider when it is not among those shown, and forgets the pick', async () => {
    const session = await started();
    const picked = await session.pick({ provider: 'netease', id: '9' });
    expect(picked.provider).to.equal('netease');
    expect(calls).to.deep.equal([{}, { all: true }, {}]);
    expect(session.current().result).to.deep.include({ pinned: true });
    expect(session.current().result!.best!.provider).to.equal('netease');
    expect(prefs.get(spotifyTrack as unknown as TrackQuery)!.pick!.id).to.equal('9');

    // Shown now, so no second lookup with all
    await session.pick({ provider: 'netease', id: '9' });
    expect(calls).to.have.length(4);

    await session.pick({ provider: 'lrclib', id: 'nope' }).then(() => expect.fail('picked'), error => {
      expect(error.message).to.equal('No candidate lrclib:nope for A - T');
    });
    expect(await session.unpick()).to.equal(true);
    expect(session.current().result).to.deep.include({ pinned: false });
    expect(await session.unpick()).to.equal(false);

    await session.mark('none');
    expect(prefs.get(spotifyTrack as unknown as TrackQuery)!.mark).to.equal('none');
    expect(await session.unpick()).to.equal(true);
    expect(prefs.get(spotifyTrack as unknown as TrackQuery)).to.equal(null);
  });

  it('refuses picks without prefs and odd offsets, and removes an offset set to 0', async () => {
    const session = await started({ prefs: null });
    await session.pick({ provider: 'lrclib', id: '1' }).then(() => expect.fail('picked'), error => {
      expect(error.message).to.equal('Picks are off (--no-prefs)');
    });
    expect(() => session.setOffset(1.5)).to.throw('Offset must be whole milliseconds: 1.5');

    const saved = await started();
    expect(saved.setOffset(-300)).to.equal(-300);
    expect(prefs.get(spotifyTrack as unknown as TrackQuery)!.offset!.ms).to.equal(-300);
    expect(saved.setOffset(0)).to.equal(0);
    expect(prefs.get(spotifyTrack as unknown as TrackQuery)).to.equal(null);
  });

  it('says nothing plays when there is no track', async () => {
    const session = new NowPlaying(new PlayerHub([fakePlayer('spotify')]), { lookup: lookup as never, prefs });
    session.start();
    for (const command of [() => session.refresh(), () => session.candidates(), () => session.pick({ provider: 'a', id: 'b' }), () => session.unpick()]) {
      await command().then(() => expect.fail('ran'), error => expect(error.message).to.equal('Nothing playing'));
    }
  });
});

describe('NowPlaying prefetch', () => {
  const trackA: PlayingTrack = { key: 'a', artist: 'A', title: 'First' };
  const trackB: PlayingTrack = { key: 'b', artist: 'B', title: 'Second' };
  const trackC: PlayingTrack = { key: 'c', artist: 'C', title: 'Third' };
  const started = (player: ReturnType<typeof fakePlayer>) => {
    const hub = new PlayerHub([player]);
    hub.start();
    return hub;
  };
  const at = (track: PlayingTrack, next: PlayingTrack | null): Playback => ({ player: 'mpd', state: 'playing', track, next, positionMs: 0, at: 0, rate: 1, changedAt: 0 });

  // Records each lookup by title; titles in `hold` wait until released, those in `fail` throw
  function lookups() {
    const asked: string[] = [];
    const aborted: string[] = [];
    const held = new Map<string, () => void>();
    const hold = new Set<string>();
    const fail = new Set<string>();
    const lookup = async (query: TrackQuery, options: { signal?: AbortSignal } = {}) => {
      asked.push(query.title);
      if (options.signal?.aborted) aborted.push(query.title);
      options.signal?.addEventListener('abort', () => aborted.push(query.title));
      if (hold.has(query.title)) await new Promise<void>(resolve => held.set(query.title, resolve));
      if (fail.has(query.title)) throw new Error(`${query.title} failed`);
      return result();
    };
    return { asked, aborted, held, hold, fail, lookup: lookup as never };
  }

  it('looks the next track up once the current one is settled, and uses it when that track starts', async () => {
    const calls = lookups();
    const player = fakePlayer('mpd', { playback: at(trackA, trackB) });
    const session = new NowPlaying(started(player), { lookup: calls.lookup });
    session.start();
    await session.settled();
    await until(() => calls.asked.length === 2);
    expect(calls.asked).to.deep.equal(['First', 'Second']);
    expect(session.prefetching()).to.equal('mpd:b');

    const states: NowState[] = [];
    session.onChange(state => states.push(state));
    player.set(at(trackB, trackC));
    await session.settled();
    // Second was not asked again; Third is now ahead
    await until(() => calls.asked.length === 3);
    expect(calls.asked).to.deep.equal(['First', 'Second', 'Third']);
    expect(session.current()).to.deep.include({ loading: false, result: result() });
    expect(session.current().query?.title).to.equal('Second');
    expect(states[0]).to.deep.include({ loading: true, result: null });
    session.close();
    expect(calls.aborted).to.include('Third');
  });

  it('adopts a prefetch still running when its track starts, rather than asking twice', async () => {
    const calls = lookups();
    calls.hold.add('Second');
    const player = fakePlayer('mpd', { playback: at(trackA, trackB) });
    const session = new NowPlaying(started(player), { lookup: calls.lookup });
    session.start();
    await until(() => calls.asked.includes('Second'));
    player.set(at(trackB, null));
    expect(session.current().loading).to.equal(true);
    calls.held.get('Second')!();
    await session.settled();
    expect(calls.asked).to.deep.equal(['First', 'Second']);
    expect(session.current()).to.deep.include({ loading: false, result: result() });
    expect(calls.aborted).to.not.include('Second');
    session.close();
  });

  it('drops a prefetch when the queue changes, and asks again when one failed', async () => {
    const calls = lookups();
    calls.hold.add('Second');
    const player = fakePlayer('mpd', { playback: at(trackA, trackB) });
    const session = new NowPlaying(started(player), { lookup: calls.lookup });
    session.start();
    await until(() => calls.asked.includes('Second'));
    player.set(at(trackA, trackC));
    expect(calls.aborted).to.deep.equal(['Second']);
    expect(session.prefetching()).to.equal('mpd:c');

    calls.fail.add('Third');
    await until(() => calls.asked.includes('Third'));
    await new Promise(resolve => setImmediate(resolve));
    calls.fail.delete('Third');
    player.set(at(trackC, null));
    await session.settled();
    expect(calls.asked.filter(title => title === 'Third')).to.have.length(2);
    expect(session.current()).to.deep.include({ error: null, result: result() });
    expect(session.prefetching()).to.equal(null);
    session.close();
  });

  it('prefetches nothing when turned off, when nothing is queued, or when the current track repeats', async () => {
    const off = lookups();
    const quiet = new NowPlaying(started(fakePlayer('mpd', { playback: at(trackA, trackB) })), { lookup: off.lookup, prefetch: false });
    quiet.start();
    await quiet.settled();
    expect(off.asked).to.deep.equal(['First']);
    quiet.close();

    const repeat = lookups();
    const looping = new NowPlaying(started(fakePlayer('mpd', { playback: at(trackA, trackA) })), { lookup: repeat.lookup });
    looping.start();
    await looping.settled();
    expect(repeat.asked).to.deep.equal(['First']);
    expect(looping.prefetching()).to.equal(null);
    looping.close();
  });
});

describe('takeLater', () => {
  const other: ScoredCandidate = { ...best, provider: 'netease', id: '9' };
  const plain: ScoredCandidate = { ...other, lyrics: { synced: false, instrumental: false, lines: [{ time: null, text: 'one' }] } };
  const shown = (candidate: ScoredCandidate, extra: Partial<LyricsResult> = {}): LyricsResult =>
    ({ best: candidate, candidates: [candidate], rejected: [], errors: [], pinned: false, offsetMs: 0, ...extra });
  const later = shown(best, { errors: [{ provider: 'x', message: 'down' }] });

  it('takes the later answer when nothing is shown, or only unsynced lyrics', () => {
    expect(takeLater(null, later, 0)).to.equal(later);
    expect(takeLater(shown(plain), later, 190_000, 200_000)).to.equal(later);
  });

  it('replaces synced lyrics only in the first fifth of the track, or its first 30 s without a length', () => {
    expect(takeLater(shown(other), later, 39_000, 200_000)).to.equal(later);
    expect(takeLater(shown(other), later, 29_000)).to.equal(later);
    const kept = takeLater(shown(other, { offsetMs: 300 }), later, 41_000, 200_000);
    expect(kept).to.deep.include({ best: other, offsetMs: 300, errors: later.errors, candidates: later.candidates });
    expect(takeLater(shown(other), later, 31_000).best).to.equal(other);
  });

  it('keeps the lyrics and offset shown when the later answer has the same or none, and always a pick', () => {
    expect(takeLater(shown(best, { offsetMs: -200 }), later, 0)).to.deep.include({ best, offsetMs: -200, errors: later.errors });
    expect(takeLater(shown(other), { ...later, best: null }, 0).best).to.equal(other);
    const picked = shown(other, { pinned: true });
    expect(takeLater(picked, later, 0)).to.equal(picked);
  });
});

describe('NowPlaying retries', () => {
  const track: PlayingTrack = { key: 'r', artist: 'A', title: 'Retry', durationMs: 200_000 };
  const paused = (positionMs: number): Playback => ({ player: 'mpd', state: 'paused', track, positionMs, at: 0, rate: 1, changedAt: 0 });
  const other: ScoredCandidate = { ...best, provider: 'netease', id: '9' };
  const failing: LyricsResult = { best: other, candidates: [other], rejected: [], errors: [{ provider: 'lrclib', message: 'LRCLIB answered 503' }], pinned: false, offsetMs: 0 };
  const start = (player: ReturnType<typeof fakePlayer>, lookup: unknown, extra: object = {}) => {
    const hub = new PlayerHub([player]);
    hub.start();
    const session = new NowPlaying(hub, { lookup: lookup as never, retryDelaysMs: [5, 5, 5], prefetch: false, ...extra });
    session.start();
    return session;
  };

  it('asks again while an online provider fails, and switches early in the track', async () => {
    const answers = [failing, failing, result()];
    let asked = 0;
    const session = start(fakePlayer('mpd', { playback: paused(1000) }), async () => answers[Math.min(asked++, answers.length - 1)]);
    await session.settled();
    expect(session.current().result?.best?.provider).to.equal('netease');
    expect(session.retrying()).to.equal(true);
    await until(() => asked === 3);
    await until(() => !session.retrying());
    expect(session.current().result).to.deep.include({ best, errors: [] });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(asked).to.equal(3);
    session.close();
  });

  it('keeps the synced lyrics shown late in the track, gives up after the last pause, and stops on a new track', async () => {
    let asked = 0;
    const late = start(fakePlayer('mpd', { playback: paused(150_000) }), async () => {
      asked++;
      return asked === 1 ? failing : { ...result(), errors: failing.errors };
    });
    await late.settled();
    await until(() => asked === 4 && !late.retrying());
    expect(late.current().result?.best?.provider).to.equal('netease');
    late.close();

    let more = 0;
    const player = fakePlayer('mpd', { playback: paused(0) });
    const moving = start(player, async () => { more++; return failing; }, { retryDelaysMs: [30] });
    await moving.settled();
    player.set(null);
    expect(moving.retrying()).to.equal(false);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(more).to.equal(1);
    moving.close();
  });

  it('does not ask again for a pick, a local provider or the cache failing', async () => {
    for (const answer of [
      { ...failing, pinned: true },
      { ...failing, errors: [{ provider: 'sidecar', message: 'EACCES' }, { provider: 'cache', message: 'locked' }] }
    ]) {
      const session = start(fakePlayer('mpd', { playback: paused(0) }), async () => answer);
      await session.settled();
      expect(session.retrying()).to.equal(false);
      session.close();
    }
  });

  it('shows what the first providers found while the rest are still out', async () => {
    let release: () => void = () => {};
    const session = start(fakePlayer('mpd', { playback: paused(0) }), async (_query: TrackQuery, options: { onPartial?: (result: LyricsResult) => void }) => {
      options.onPartial?.({ ...failing, errors: [] });
      await new Promise<void>(resolve => { release = resolve; });
      return result();
    });
    await until(() => session.current().result?.best?.provider === 'netease');
    expect(session.current().loading).to.equal(true);
    release();
    await session.settled();
    expect(session.current()).to.deep.include({ loading: false });
    expect(session.current().result?.best).to.equal(best);
    session.close();
  });
});
