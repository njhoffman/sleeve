import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TrackPrefs } from '../../src/core/prefs.ts';
import type { LyricsResult, ScoredCandidate, TrackQuery } from '../../src/core/types.ts';
import { lineAt, NowPlaying, queryForPlayback } from '../../src/now/session.ts';
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
