import { expect } from 'chai';
import { MprisPlayer, spotifyIdOf, trackFromMetadata, type MprisBus, type MprisProxy, type Properties } from '../../src/players/mpris.ts';
import type { Playback } from '../../src/players/types.ts';
import { until } from '../helpers/fakeMpd.ts';

const metadata = (id: string, title = 'California') => ({
  'mpris:trackid': `/com/spotify/track/${id}`, 'mpris:length': 258_004_000, 'xesam:album': 'California',
  'xesam:artist': ['The Lagoons'], 'xesam:title': title, 'xesam:url': `https://open.spotify.com/track/${id}`
});
const ID1 = '68Ipi52o5m2zBeQVn9Tezf';
const ID2 = '08OTqB3xjsLa5EZb9Fu2Lw';

// A session bus with one player whose properties, position and name owner the test controls
function fakeBus(initial: Properties) {
  let owned = true;
  let positionUs = Number(initial.Position ?? 0);
  const props: Properties = { ...initial };
  let nameListener: (owned: boolean) => void = () => {};
  const changed: Array<(changed: Properties) => void> = [];
  const seeked: Array<(positionUs: number) => void> = [];
  const bus: MprisBus = {
    async watchName(_name, listener) { nameListener = listener; return owned; },
    async open(): Promise<MprisProxy> {
      return {
        properties: async () => ({ ...props, Position: positionUs }),
        position: async () => positionUs,
        onChanged: listener => { changed.push(listener); },
        onSeeked: listener => { seeked.push(listener); },
        close: () => { changed.length = 0; seeked.length = 0; }
      };
    },
    close() {}
  };
  return {
    bus,
    setPosition(us: number) { positionUs = us; },
    change(values: Properties) { Object.assign(props, values); for (const listener of changed) listener(values); },
    seek(us: number) { positionUs = us; for (const listener of seeked) listener(us); },
    owner(now: boolean) { owned = now; nameListener(now); }
  };
}

describe('MprisPlayer', () => {
  let time: number, player: MprisPlayer;
  beforeEach(() => { time = 100; });
  afterEach(async () => { await player?.close(); });

  const open = async (bus: MprisBus) => {
    player = new MprisPlayer(bus, 'spotify', { now: () => time, resyncMs: 0, settleMs: 0 });
    player.start();
    await player.ready();
    await until(() => player.current() !== null);
  };

  it('reads the track, state and position of a running player', async () => {
    const fake = fakeBus({ PlaybackStatus: 'Playing', Rate: 1, Metadata: metadata(ID1), Position: 121_644_000 });
    await open(fake.bus);
    expect(player.current()).to.deep.equal({
      player: 'spotify', state: 'playing', positionMs: 121_644, at: 100, rate: 1, changedAt: 100,
      track: { key: `/com/spotify/track/${ID1}`, artist: 'The Lagoons', title: 'California', album: 'California', durationMs: 258_004, spotifyId: ID1 }
    });
  });

  it('follows seeks, pauses and new tracks, reading the position again', async () => {
    const fake = fakeBus({ PlaybackStatus: 'Playing', Rate: 1, Metadata: metadata(ID1), Position: 1_000_000 });
    await open(fake.bus);
    const seen: Array<Playback | null> = [];
    player.onChange(playback => seen.push(playback));
    time = 200;
    fake.seek(90_000_000);
    expect(seen.at(-1)).to.deep.include({ positionMs: 90_000, at: 200, changedAt: 100 });

    time = 300;
    fake.setPosition(95_000_000);
    fake.change({ PlaybackStatus: 'Paused' });
    await until(() => seen.at(-1)?.positionMs === 95_000);
    expect(seen.at(-1)).to.deep.include({ state: 'paused', changedAt: 300 });

    time = 400;
    fake.setPosition(0);
    fake.change({ PlaybackStatus: 'Playing', Metadata: metadata(ID2, 'Hot Blur') });
    await until(() => seen.at(-1)?.track?.spotifyId === ID2);
    expect(seen.at(-1)).to.deep.include({ state: 'playing', positionMs: 0, changedAt: 400 });
  });

  it('has no playback while the player is not running, and picks it up when it starts', async () => {
    const fake = fakeBus({ PlaybackStatus: 'Playing', Metadata: metadata(ID1) });
    fake.owner(false);
    player = new MprisPlayer(fake.bus, 'spotify', { now: () => time, resyncMs: 0, settleMs: 0 });
    player.start();
    await player.ready();
    expect(player.current()).to.equal(null);
    expect(player.problem()).to.equal('spotify is not running');
    fake.owner(true);
    await until(() => player.current() !== null);
    expect(player.problem()).to.equal(null);
    fake.owner(false);
    expect(player.current()).to.equal(null);
  });

  it('reports a bus it cannot reach', async () => {
    const bus = { watchName: async () => { throw new Error('no session bus'); } } as unknown as MprisBus;
    player = new MprisPlayer(bus, 'spotify');
    player.start();
    await player.ready();
    expect(player.problem()).to.equal('no session bus');
  });

  it('gives what plays next with the playback once asked, once per track, and drops an answer for a track gone', async () => {
    const fake = fakeBus({ PlaybackStatus: 'Playing', Rate: 1, Metadata: metadata(ID1), Position: 0 });
    const asked: string[] = [];
    const answers = new Map<string, (track: { key: string; artist: string; title: string } | null) => void>();
    player = new MprisPlayer(fake.bus, 'spotify', {
      now: () => time, resyncMs: 0, settleMs: 0,
      next: track => { asked.push(track.key); return new Promise(resolve => answers.set(track.key, resolve)); }
    });
    player.start();
    await player.ready();
    await until(() => answers.has(`/com/spotify/track/${ID1}`));
    expect(player.current()!.next).to.equal(undefined);
    answers.get(`/com/spotify/track/${ID1}`)!({ key: `/com/spotify/track/${ID2}`, artist: 'A', title: 'Next' });
    await until(() => player.current()?.next?.title === 'Next');
    // A change that is not a new track keeps it, and does not ask again
    fake.change({ PlaybackStatus: 'Paused' });
    await until(() => player.current()?.state === 'paused');
    expect(player.current()!.next?.title).to.equal('Next');
    expect(asked).to.have.length(1);

    // The next track: asked again; the old answer, coming late, is dropped
    fake.change({ PlaybackStatus: 'Playing', Metadata: metadata(ID2, 'Other') });
    await until(() => answers.has(`/com/spotify/track/${ID2}`));
    expect(player.current()!.next).to.equal(undefined);
    answers.get(`/com/spotify/track/${ID1}`)!({ key: 'late', artist: 'A', title: 'Late' });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(player.current()!.next).to.equal(undefined);
    expect(asked).to.deep.equal([`/com/spotify/track/${ID1}`, `/com/spotify/track/${ID2}`]);
  });

  it('reads metadata from other players: local files, missing fields', () => {
    expect(trackFromMetadata({ 'xesam:url': 'file:///music/a%20b.flac', 'xesam:title': 'AB', 'xesam:artist': ['X', 'Y'] }))
      .to.deep.equal({ key: 'file:///music/a%20b.flac', artist: 'X, Y', title: 'AB', file: '/music/a b.flac' });
    expect(trackFromMetadata({})).to.equal(null);
    expect(trackFromMetadata(null)).to.equal(null);
    // The cover, when the player names one over https or as a file
    expect(trackFromMetadata({ 'xesam:title': 'T', 'mpris:artUrl': 'https://i.scdn.co/image/ab67' })!.artUrl).to.equal('https://i.scdn.co/image/ab67');
    expect(trackFromMetadata({ 'xesam:title': 'T', 'mpris:artUrl': 'file:///tmp/cover.png' })!.artUrl).to.equal('file:///tmp/cover.png');
    expect(trackFromMetadata({ 'xesam:title': 'T', 'mpris:artUrl': 'http://example.com/a.jpg' })!.artUrl).to.equal(undefined);
    expect(spotifyIdOf(`spotify:track:${ID1}`)).to.equal(ID1);
    expect(spotifyIdOf('/org/mpris/MediaPlayer2/TrackList/NoTrack')).to.equal(undefined);
  });
});
