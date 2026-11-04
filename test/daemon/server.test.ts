import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { TrackPrefs } from '../../src/core/prefs.ts';
import type { LyricsResult, ScoredCandidate, TrackQuery } from '../../src/core/types.ts';
import { DaemonClient } from '../../src/daemon/client.ts';
import { originAllowed, SleeveDaemon } from '../../src/daemon/server.ts';
import { NowPlaying } from '../../src/now/session.ts';
import { monotonic } from '../../src/players/clock.ts';
import { PlayerHub } from '../../src/players/hub.ts';
import type { Playback, PlayingTrack } from '../../src/players/types.ts';
import type { LineMessage, ServerMessage } from '../../src/protocol/messages.ts';
import { until } from '../helpers/fakeMpd.ts';
import { fakePlayer, type FakePlayer } from '../helpers/players.ts';
import { rawClient, wsClient } from '../helpers/ws.ts';

const lines = (...times: number[]) => times.map((time, index) => ({ time, text: `line ${index}` }));
const candidate = (provider: string, id: string, times: number[], score = 1): ScoredCandidate => ({
  provider, id, track: { artist: 'A', title: 'T' }, score, detail: { title: 1, artist: 1, album: null, duration: null },
  lyrics: { synced: true, instrumental: false, lines: lines(...times) }
});
const track: PlayingTrack = { key: 'k1', artist: 'A', title: 'T', durationMs: 200_000 };

describe('originAllowed', () => {
  it('lets in local pages, file:// and clients that send no Origin, and no one else unless allowed', () => {
    for (const origin of [undefined, 'http://localhost:3000', 'http://127.0.0.1', 'https://[::1]:8443', 'file://']) {
      expect(originAllowed(origin), String(origin)).to.equal(true);
    }
    for (const origin of ['https://evil.example', 'http://localhost.evil.example', 'null', 'chrome-extension://abc', 'garbage']) {
      expect(originAllowed(origin), origin).to.equal(false);
    }
    expect(originAllowed('https://mine.example', ['https://mine.example'])).to.equal(true);
    expect(originAllowed('null', ['*'])).to.equal(true);
  });
});

describe('sleeved', () => {
  let dir: string, prefs: TrackPrefs, player: FakePlayer, session: NowPlaying, daemon: SleeveDaemon;
  let answer: LyricsResult, problems: Array<{ player: string; problem: string }>;
  const sockets: Socket[] = [];
  const closers: Array<() => void> = [];

  const playing = (positionMs = 0, extra: Partial<Playback> = {}): Playback => ({
    player: 'spotify', state: 'playing', track, positionMs, at: monotonic(), rate: 1, changedAt: 0, ...extra
  });

  // When the playback in start() began: positions may run on from 150 s by as long as has passed since
  let startedAt = 0;
  // (plus 2 ms: the wire stamp is whole wall-clock milliseconds)
  const elapsed = () => Math.ceil(monotonic() - startedAt) + 2;

  async function start(options: ConstructorParameters<typeof SleeveDaemon>[1] = {}) {
    startedAt = monotonic();
    player = fakePlayer('spotify', { playback: playing(150_000) });
    const hub = new PlayerHub([player]);
    hub.start();
    session = new NowPlaying(hub, {
      prefs,
      lookup: async (query: TrackQuery, options = {}) => {
        const pick = prefs.get(query)?.pick;
        if (pick) return { ...answer, best: { ...candidate('netease', '9', [0]), ...pick }, pinned: true };
        return options.all ? { ...answer, rejected: [candidate('netease', '9', [0], 0.3)] } : answer;
      }
    });
    session.start();
    await session.settled();
    daemon = new SleeveDaemon(session, { port: 0, socketPath: path.join(dir, 'd.sock'), problems: () => problems, ...options });
    await daemon.listen();
  }

  // A Unix socket client keeping every message
  async function unixClient() {
    const socket = connect(daemon.socketPath!);
    sockets.push(socket);
    const messages: ServerMessage[] = [];
    let pending = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      pending += chunk;
      const parts = pending.split('\n');
      pending = parts.pop()!;
      for (const part of parts) messages.push(JSON.parse(part));
    });
    await new Promise(resolve => socket.once('connect', resolve));
    return { socket, messages, send: (value: unknown) => socket.write(`${JSON.stringify(value)}\n`) };
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sleeved-'));
    prefs = new TrackPrefs(':memory:');
    answer = { best: candidate('lrclib', '1', [1000, 2000]), candidates: [candidate('lrclib', '1', [1000, 2000])], rejected: [], errors: [], pinned: false, offsetMs: 0 };
    problems = [];
  });
  afterEach(async () => {
    for (const close of closers.splice(0)) close();
    for (const socket of sockets.splice(0)) socket.destroy();
    await daemon?.close();
    session?.close();
    prefs.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('greets a WebSocket client with the state, then sends what changes', async () => {
    await start();
    const before = Date.now();
    const client = await wsClient(`ws://127.0.0.1:${daemon.port}/ws`);
    closers.push(() => client.close());
    expect(await client.next()).to.deep.include({ type: 'hello', protocol: 1 });
    const first = await client.next();
    expect(first.type).to.equal('playback');
    const wire = (first as Extract<ServerMessage, { type: 'playback' }>).playback!;
    expect(wire).to.deep.include({ player: 'spotify', state: 'playing', rate: 1, track });
    expect(wire.positionMs).to.be.within(150_000, 150_000 + elapsed());
    expect(wire.at).to.be.within(before - 1, Date.now() + 1);
    expect(await client.next()).to.deep.include({ type: 'lyrics', key: 'spotify:k1', loading: false, error: null, result: answer });
    expect(await client.next()).to.deep.equal({ type: 'players', problems: [] });

    player.set(playing(10_000, { state: 'paused' }));
    const paused = await client.next();
    expect(paused).to.deep.include({ type: 'playback' });
    expect((paused as Extract<ServerMessage, { type: 'playback' }>).playback).to.deep.include({ state: 'paused', positionMs: 10_000 });
    // The same track: no lyrics message
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(client.messages).to.deep.equal([]);

    player.set(playing(0, { track: { ...track, key: 'k2', title: 'U' } }));
    await client.next(message => message.type === 'playback');
    expect(await client.next()).to.deep.include({ type: 'lyrics', key: 'spotify:k2', loading: true, result: null });
    expect(await client.next()).to.deep.include({ type: 'lyrics', key: 'spotify:k2', loading: false, result: answer });
  });

  it('answers commands, sending only the offset after a nudge', async () => {
    await start();
    const client = await wsClient(`ws://127.0.0.1:${daemon.port}/ws`);
    closers.push(() => client.close());
    await client.next(message => message.type === 'players');
    client.send({ type: 'nudge', ms: 100, id: 1 });
    expect(await client.next()).to.deep.equal({ type: 'offset', offsetMs: 100 });
    expect(await client.next()).to.deep.equal({ type: 'reply', id: 1, ok: true, data: { offsetMs: 100 } });
    client.send({ type: 'offset', ms: 0, id: 2 });
    expect(await client.next(message => message.type === 'reply')).to.deep.equal({ type: 'reply', id: 2, ok: true, data: { offsetMs: 0 } });
    client.send({ type: 'pick', ref: 'garbage', id: 3 });
    expect(await client.next(message => message.type === 'reply')).to.deep.equal({ type: 'reply', id: 3, ok: false, error: 'Invalid candidate: garbage (use provider:id)' });
    client.send('{"type":"teleport","id":4}');
    expect(await client.next(message => message.type === 'reply')).to.deep.equal({ type: 'reply', id: 4, ok: false, error: 'Unknown command: teleport' });
    client.send({ type: 'state', id: 5 });
    expect((await client.next()).type).to.equal('playback');
    expect((await client.next()).type).to.equal('lyrics');
    expect((await client.next()).type).to.equal('players');
    expect(await client.next()).to.deep.equal({ type: 'reply', id: 5, ok: true });
  });

  it('serves the same protocol on the Unix socket, picks included', async () => {
    await start();
    const client = await unixClient();
    await until(() => client.messages.some(message => message.type === 'players'));
    expect(client.messages.map(message => message.type)).to.deep.equal(['hello', 'playback', 'lyrics', 'players']);
    client.messages.length = 0;
    client.send({ type: 'candidates', id: 'c' });
    await until(() => client.messages.some(message => message.type === 'reply'));
    const listed = client.messages.find(message => message.type === 'reply') as Extract<ServerMessage, { type: 'reply' }>;
    expect((listed.data as LyricsResult).rejected[0]).to.deep.include({ provider: 'netease', id: '9' });

    client.messages.length = 0;
    client.send({ type: 'pick', ref: 'netease:9', id: 'p' });
    await until(() => client.messages.some(message => message.type === 'reply'));
    const lyrics = client.messages.filter(message => message.type === 'lyrics') as Array<Extract<ServerMessage, { type: 'lyrics' }>>;
    // Kept on screen while it reloads, then the pick
    expect(lyrics.map(message => [message.loading, message.result?.best?.provider])).to.deep.equal([[true, 'lrclib'], [false, 'netease']]);
    expect(client.messages.at(-1)).to.deep.equal({ type: 'reply', id: 'p', ok: true, data: { ref: 'netease:9' } });
  });

  it('seeks in the player for a client, and replies with the failure when it cannot', async () => {
    await start();
    const client = await unixClient();
    client.send({ type: 'seek', ms: 61_500, id: 1 });
    await until(() => client.messages.some(message => message.type === 'reply' && message.id === 1));
    expect(client.messages.find(message => message.type === 'reply' && message.id === 1)).to.deep.include({ ok: true, data: { positionMs: 61_500 } });
    expect(player.seeks).to.deep.equal([61_500]);
    player.seek = async () => { throw new Error('refused'); };
    client.send({ type: 'seek', ms: 1, id: 2 });
    await until(() => client.messages.some(message => message.type === 'reply' && message.id === 2));
    expect(client.messages.find(message => message.type === 'reply' && message.id === 2)).to.deep.include({ ok: false, error: 'refused' });
  });

  it('sends subscribers each line as it comes due, offset included', async () => {
    answer = { ...answer, best: candidate('lrclib', '1', [40, 80, 120]) };
    await start();
    // Subscribed while paused at the start, so every line is still to come when playback starts
    player.set(playing(0, { state: 'paused' }));
    await session.settled();
    const client = await unixClient();
    client.send({ type: 'subscribe', lines: true, id: 1 });
    await until(() => client.messages.some(message => message.type === 'reply' && message.id === 1));
    player.set(playing(0));
    const seen = () => (client.messages.filter(message => message.type === 'line') as LineMessage[]).map(message => message.line.index);
    await until(() => seen().includes(2), 2000);
    // In order, each once; a timer held up by a busy machine may skip a line that is already over
    const indexes = seen();
    expect(indexes[0]).to.equal(-1);
    expect(indexes.at(-1)).to.equal(2);
    expect(indexes.every((index, at) => at === 0 || index > indexes[at - 1])).to.equal(true);

    client.messages.length = 0;
    client.send({ type: 'offset', ms: 1000, id: 2 });
    await until(() => client.messages.some(message => message.type === 'line'));
    expect((client.messages.find(message => message.type === 'line') as LineMessage).line).to.deep.equal({ index: -1, text: null, timeMs: null });

    client.send({ type: 'subscribe', lines: false, id: 3 });
    client.messages.length = 0;
    client.send({ type: 'offset', ms: 0, id: 4 });
    await until(() => client.messages.some(message => message.type === 'reply' && message.id === 4));
    expect(client.messages.some(message => message.type === 'line')).to.equal(false);
  });

  it('sends the last line when it comes due between working out the line and the next one', async () => {
    answer = { ...answer, best: candidate('lrclib', '1', [40, 80, 120]) };
    let reads = -1;
    // Stands still until reads starts counting, then only the first read is before the last line
    await start({ monotonic: () => reads < 0 ? 1000 : reads++ === 0 ? 1119.9 : 1120.1 });
    const client = await unixClient();
    player.set(playing(0, { at: 1000 }));
    await session.settled();
    reads = 0;
    client.send({ type: 'subscribe', lines: true, id: 1 });
    await until(() => client.messages.some(message => message.type === 'line' && message.line.index === 2), 1000);
  });

  it('logs the track it looks up ahead', async () => {
    const logs: string[] = [];
    await start({ log: text => logs.push(text) });
    player.set(playing(1000, { next: { ...track, key: 'k9', title: 'Next' } }));
    await until(() => logs.includes('prefetch: spotify:k9'));
  });

  it('passes on player problems as they change', async () => {
    await start();
    const client = await unixClient();
    await until(() => client.messages.some(message => message.type === 'players'));
    problems = [{ player: 'mpd', problem: 'connect ECONNREFUSED' }];
    player.set(playing(1000));
    await until(() => client.messages.filter(message => message.type === 'players').length === 2);
    expect(client.messages.filter(message => message.type === 'players').at(-1)).to.deep.equal({ type: 'players', problems });
  });

  it('refuses WebSockets from other sites and on other paths', async () => {
    await start({ allowOrigins: ['https://mine.example'] });
    expect((await rawClient(daemon.port!, { headers: { Origin: 'https://evil.example' } })).response).to.match(/^HTTP\/1\.1 403/);
    expect((await rawClient(daemon.port!, { path: '/' })).response).to.match(/^HTTP\/1\.1 404/);
    const allowed = await rawClient(daemon.port!, { headers: { Origin: 'https://mine.example' } });
    expect(allowed.response).to.match(/^HTTP\/1\.1 101/);
    allowed.socket.destroy();
    const local = await wsClient(`ws://127.0.0.1:${daemon.port}/ws`, { origin: 'http://localhost:5173' });
    local.close();
  });

  it('will not start twice on one socket, nor on a path too long for one', async () => {
    await start();
    const second = new SleeveDaemon(session, { port: null, socketPath: daemon.socketPath! });
    await second.listen().then(() => expect.fail('started'), error => expect(error.message).to.match(/^sleeved is already running/));
    expect(existsSync(daemon.socketPath!)).to.equal(true);
    const long = new SleeveDaemon(session, { port: null, socketPath: path.join(dir, 'x'.repeat(120)) });
    await long.listen().then(() => expect.fail('started'), error => expect(error.message).to.match(/^Socket path too long/));
  });

  it('takes over a socket left behind, and removes its own on close', async () => {
    await start();
    const socketPath = daemon.socketPath!;
    await daemon.close();
    // A socket file nothing listens on, as a crash leaves it: a process killed while listening
    const script = `require('node:net').createServer().listen(${JSON.stringify(socketPath)}, () => process.kill(process.pid, 'SIGKILL'))`;
    spawnSync(process.execPath, ['-e', script]);
    expect(existsSync(socketPath)).to.equal(true);
    daemon = new SleeveDaemon(session, { port: null, socketPath });
    await daemon.listen();
    expect(await DaemonClient.connect(socketPath).then(client => { client?.close(); return !!client; })).to.equal(true);
    await daemon.close();
    expect(existsSync(socketPath)).to.equal(false);
  });

  it('mirrors the session for a DaemonClient and closes it when the daemon stops', async () => {
    await start();
    const client = (await DaemonClient.connect(daemon.socketPath!))!;
    expect(client.mirror.current().result).to.deep.equal(answer);
    expect(client.mirror.position()).to.be.within(150_000, 150_000 + elapsed());
    expect(await client.send({ type: 'nudge', ms: -50 })).to.deep.include({ ok: true, data: { offsetMs: -50 } });
    expect(client.mirror.current().result!.offsetMs).to.equal(-50);
    let closed = false;
    client.onClose(() => { closed = true; });
    await daemon.close();
    await until(() => closed);
    expect(await client.send({ type: 'state' })).to.deep.equal({ type: 'reply', ok: false, error: 'sleeved closed the connection' });
    expect(await DaemonClient.connect(path.join(dir, 'none.sock'))).to.equal(null);
  });
});
