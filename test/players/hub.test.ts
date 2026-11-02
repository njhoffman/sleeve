import { expect } from 'chai';
import { positionAt, clockTime } from '../../src/players/clock.ts';
import { choosePlayback, PlayerHub } from '../../src/players/hub.ts';
import type { Playback } from '../../src/players/types.ts';
import { fakePlayer } from '../helpers/players.ts';

const playback = (player: string, state: Playback['state'], changedAt = 0): Playback => ({
  player, state, changedAt, positionMs: 1000, at: 0, rate: 1, track: { key: player, artist: 'A', title: 'T', durationMs: 5000 }
});

describe('choosePlayback', () => {
  it('takes the one playing, Spotify when several are', () => {
    expect(choosePlayback([playback('mpd', 'playing'), playback('spotify', 'playing')])?.player).to.equal('spotify');
    expect(choosePlayback([playback('mpd', 'playing'), playback('spotify', 'paused', 9)])?.player).to.equal('mpd');
  });

  it('else the one paused most recently, never a stopped one or one without a track', () => {
    expect(choosePlayback([playback('mpd', 'paused', 5), playback('spotify', 'paused', 3)])?.player).to.equal('mpd');
    expect(choosePlayback([playback('mpd', 'stopped'), null])).to.equal(null);
    expect(choosePlayback([{ ...playback('mpd', 'playing'), track: null }])).to.equal(null);
  });
});

describe('PlayerHub', () => {
  it('passes on every change with the active playback and lists problems', async () => {
    const mpd = fakePlayer('mpd');
    const spotify = fakePlayer('spotify', { problem: 'spotify is not running' });
    const hub = new PlayerHub([mpd, spotify]);
    const seen: Array<string | null> = [];
    hub.onChange(active => seen.push(active?.player ?? null));
    hub.start();
    await hub.ready();
    mpd.set(playback('mpd', 'paused'));
    spotify.set(playback('spotify', 'playing'));
    spotify.set(null);
    expect(seen).to.deep.equal(['mpd', 'spotify', 'mpd']);
    expect(hub.problems()).to.deep.equal([{ player: 'spotify', problem: 'spotify is not running' }]);
    await hub.close();
    expect(mpd.closed && spotify.closed).to.equal(true);
  });
});

describe('positionAt', () => {
  it('runs on at the rate while playing, stays put otherwise, within the track', () => {
    expect(positionAt(playback('mpd', 'playing'), 500)).to.equal(1500);
    expect(positionAt({ ...playback('mpd', 'playing'), rate: 2 }, 500)).to.equal(2000);
    expect(positionAt(playback('mpd', 'paused'), 500)).to.equal(1000);
    expect(positionAt(playback('mpd', 'playing'), 60_000)).to.equal(5000);
    expect(clockTime(65_999)).to.equal('1:05');
  });
});
