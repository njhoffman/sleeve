import { expect } from 'chai';
import { MpdPlayer, quoteArgument, trackOf } from '../../src/players/mpd.ts';
import type { Playback } from '../../src/players/types.ts';
import { fakeMpd, until, type FakeMpd } from '../helpers/fakeMpd.ts';

describe('MpdPlayer', () => {
  let server: FakeMpd, player: MpdPlayer, time: number;
  const playing = {
    status: { state: 'play', elapsed: '12.345', duration: '201.500' },
    song: { file: 'Rock/A - T.mp3', Artist: 'A', Title: 'T', Album: 'Al', duration: '201.493', Id: '7' }
  };
  beforeEach(async () => {
    time = 1000;
    server = await fakeMpd(structuredClone(playing));
  });
  afterEach(async () => {
    await player?.close();
    await server.close();
  });

  const open = (options = {}) => {
    player = new MpdPlayer({ host: '127.0.0.1', port: server.port, musicDirectory: '/music', now: () => time, retryMs: [20], ...options });
    player.start();
    return player.ready().then(() => server.idling());
  };

  it('reads the song and the exact elapsed time once connected', async () => {
    await open();
    expect(player.current()).to.deep.equal({
      player: 'mpd', state: 'playing', positionMs: 12_345, at: 1000, rate: 1, changedAt: 1000, next: null,
      track: { key: 'Rock/A - T.mp3', artist: 'A', title: 'T', album: 'Al', durationMs: 201_500, file: '/music/Rock/A - T.mp3' }
    });
    expect(server.commands).to.deep.equal(['status', 'currentsong', 'idle player playlist options']);
  });

  it('reads the song queued next, and goes on when it is gone', async () => {
    server.state.status.nextsongid = '8';
    server.state.queue = { 8: { file: 'Rock/B - U.mp3', Artist: 'B', Title: 'U', duration: '180.2', Id: '8' } };
    await open();
    expect(player.current()!.next).to.deep.equal({ key: 'Rock/B - U.mp3', artist: 'B', title: 'U', durationMs: 180_200, file: '/music/Rock/B - U.mp3' });
    expect(server.commands).to.deep.equal(['status', 'currentsong', 'playlistid 8', 'idle player playlist options']);

    // Removed from the queue between status and playlistid: unknown, and the connection carries on
    const seen: Array<Playback | null> = [];
    player.onChange(playback => seen.push(playback));
    server.state.status.nextsongid = '9';
    server.change();
    await until(() => seen.length === 1);
    expect(seen[0]).to.deep.include({ state: 'playing', next: null });
    await server.idling();
    expect(server.commands.filter(command => command === 'status')).to.have.length(2);
  });

  it('reads again on every player change, keeping changedAt across seeks', async () => {
    await open();
    const seen: Array<Playback | null> = [];
    player.onChange(playback => seen.push(playback));
    time = 5000;
    server.state.status.elapsed = '60';
    server.change();
    await until(() => seen.length === 1);
    expect(seen[0]).to.deep.include({ positionMs: 60_000, at: 5000, changedAt: 1000 });
    await server.idling();
    time = 6000;
    server.state.status.state = 'pause';
    server.change();
    await until(() => seen.length === 2);
    expect(seen[1]).to.deep.include({ state: 'paused', changedAt: 6000 });
    await server.idling();
    server.state.status = { state: 'stop' };
    server.change();
    await until(() => seen.length === 3);
    expect(seen[2]).to.deep.include({ state: 'stopped', track: null });
  });

  it('seeks on a connection of its own, leaving idle alone, and the new position comes as a change', async () => {
    await open();
    await player.seek(61_500);
    expect(server.commands).to.include('seekcur 61.500');
    await until(() => player.current()!.positionMs === 61_500);
    await server.idling();
  });

  it('sends the password before seeking, and rejects when MPD refuses', async () => {
    await server.close();
    server = await fakeMpd(structuredClone(playing), { password: 'pw' });
    await open({ password: 'pw' });
    server.commands.length = 0;
    await player.seek(1000);
    expect(server.commands.slice(0, 2)).to.deep.equal(['password "pw"', 'seekcur 1.000']);
    server.state.status.state = 'stop';
    let failure: unknown;
    await player.seek(1000).catch(error => { failure = error; });
    expect(String(failure)).to.include('Not playing');
  });

  it('reports a lost connection as no playback and reconnects', async () => {
    await open();
    const seen: Array<Playback | null> = [];
    player.onChange(playback => seen.push(playback));
    server.drop();
    await until(() => seen.length >= 2);
    expect(seen[0]).to.equal(null);
    expect(seen.at(-1)?.track?.title).to.equal('T');
    expect(player.problem()).to.equal(null);
  });

  it('says why it cannot connect, and sends the password first', async () => {
    const closed = await fakeMpd(structuredClone(playing));
    const port = closed.port;
    await closed.close();
    player = new MpdPlayer({ host: '127.0.0.1', port, retryMs: [1000] });
    player.start();
    await player.ready();
    expect(player.current()).to.equal(null);
    expect(player.problem()).to.match(/ECONNREFUSED/);
    await player.close();

    await server.close();
    server = await fakeMpd(structuredClone(playing), { password: 'se"cret' });
    await open({ password: 'se"cret' });
    expect(server.commands[0]).to.equal('password "se\\"cret"');
    expect(player.current()?.state).to.equal('playing');
  });

  it('turns songs into tracks: relative and absolute files, streams, missing tags', () => {
    const song = (fields: Record<string, string>) => new Map(Object.entries(fields));
    expect(trackOf(song({ file: '/abs/x.flac', Time: '61' }), undefined)).to.deep.equal({ key: '/abs/x.flac', artist: '', title: 'x', durationMs: 61_000, file: '/abs/x.flac' });
    expect(trackOf(song({ file: 'rel/x.mp3' }), undefined)).to.deep.equal({ key: 'rel/x.mp3', artist: '', title: 'x' });
    expect(trackOf(song({ file: 'https://radio/stream', Title: 'Live' }), '/music')).to.deep.equal({ key: 'https://radio/stream', artist: '', title: 'Live' });
    expect(trackOf(song({}), '/music')).to.equal(null);
    expect(quoteArgument('a\\b"c')).to.equal('"a\\\\b\\"c"');
  });
});
