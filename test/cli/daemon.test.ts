import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { daemonCommand } from '../../src/cli/daemon.ts';
import type { Io } from '../../src/cli/lyrics.ts';
import { ctlCommand } from '../../src/cli/ctl.ts';
import { nowCommand } from '../../src/cli/now.ts';
import { shapesSession } from '../../src/cli/session.ts';
import type { SleeveDaemon } from '../../src/daemon/server.ts';
import type { Playback } from '../../src/players/types.ts';
import { until } from '../helpers/fakeMpd.ts';
import { fakeFetch, fixture } from '../helpers/fetch.ts';
import { fakePlayer } from '../helpers/players.ts';
import { wsClient } from '../helpers/ws.ts';

// Paused, so the position stays where it is whatever the clock
const deathCab: Playback = {
  player: 'spotify', state: 'paused', positionMs: 20_000, at: 0, rate: 1, changedAt: 0,
  track: { key: 'dc', artist: 'Death Cab for Cutie', title: 'Death of an Interior Decorator', durationMs: 177_000 }
};

describe('sleeve daemon', () => {
  let out: string[], err: string[], io: Io, dir: string, socket: string;
  let stop: () => void, running: Promise<number>, daemon: SleeveDaemon | null, savedData: string | undefined;

  async function startDaemon(options: Parameters<typeof daemonCommand>[0] = {}) {
    const fake = fakeFetch([{ match: /\/api\/get\?/, body: fixture('lrclib/get-death-cab-interior-decorator.json') }]);
    const stopped = new Promise<void>(resolve => { stop = resolve; });
    running = daemonCommand({ socket, port: '0', providers: 'lrclib', ...options }, io, {
      players: [fakePlayer('spotify', { playback: deathCab })], musicman: () => null, fetch: fake.fetch,
      stop: stopped, listening: started => { daemon = started; }
    });
    await until(() => daemon !== null || err.some(line => line.startsWith('Error')));
  }

  beforeEach(async () => {
    out = []; err = [];
    io = { out: text => out.push(text), err: text => err.push(text) };
    dir = await mkdtemp(path.join(os.tmpdir(), 'sleeve-daemon-cli-'));
    socket = path.join(dir, 'd.sock');
    daemon = null;
    // A database of its own, so no test finds an answer another stored
    savedData = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(dir, 'data');
  });
  afterEach(async () => {
    stop?.();
    await running?.catch(() => {});
    process.env.XDG_DATA_HOME = savedData;
    await rm(dir, { recursive: true, force: true });
  });

  it('serves the session until stopped, logging to stderr', async () => {
    await startDaemon();
    expect(err).to.include(`listening on ${socket}`);
    expect(err.some(line => /^listening on ws:\/\/127\.0\.0\.1:(\d+)\/ws, renderer at http:\/\/127\.0\.0\.1:\1\/$/.test(line))).to.equal(true);
    const client = await wsClient(`ws://127.0.0.1:${daemon!.port}/ws`);
    const lyrics = await client.next(message => message.type === 'lyrics' && !message.loading);
    expect(lyrics).to.deep.include({ key: 'spotify:dc' });
    client.close();
    stop();
    expect(await running).to.equal(0);
    expect(err.at(-1)).to.equal('stopping');
  });

  it('refuses to listen on nothing and bad ports', async () => {
    const refused = async (options: Parameters<typeof daemonCommand>[0]) =>
      (await daemonCommand(options, io, { players: [fakePlayer('spotify')], musicman: () => null, stop: Promise.resolve() }).catch(error => error)).message;
    expect(await refused({ websocket: false, socket: false })).to.equal('Nothing to listen on: leave the WebSocket or the socket on');
    expect(await refused({ port: '70000' })).to.equal('Invalid port: 70000');
    expect(await refused({ port: 'http' })).to.equal('Invalid port: http');
  });

  describe('sleeve now through it', () => {
    it('prints --once and --json from the daemon\'s session', async () => {
      await startDaemon();
      expect(await nowCommand({ once: true, socket }, io)).to.equal(0);
      expect(out).to.deep.equal([
        'spotify paused 0:20/2:57 Death Cab for Cutie - Death of an Interior Decorator',
        'lrclib: Death Cab for Cutie - Death of an Interior Decorator (Transatlanticism) 2:57, synced, 21 lines, score 1.00',
        '> You were the mother of three girls so sweet'
      ]);
      expect(await nowCommand({ once: true, json: true, daemon: true, socket }, io)).to.equal(0);
      const json = JSON.parse(out.at(-1)!);
      expect(json).to.deep.include({ player: 'spotify', state: 'paused', positionMs: 20_000, problems: [] });
      expect(json.line).to.deep.equal({ index: 0, timeMs: 18_730, text: 'You were the mother of three girls so sweet' });
    });

    it('follows it live and stops when the daemon does', async () => {
      await startDaemon();
      const following = nowCommand({ socket }, io, { tickMs: 10 });
      await until(() => out.includes('[0:18] You were the mother of three girls so sweet'));
      expect(out.slice(0, 2)).to.deep.equal(['\n== Death Cab for Cutie - Death of an Interior Decorator [spotify]', '-- lrclib: Death Cab for Cutie - Death of an Interior Decorator (Transatlanticism) 2:57, synced, 21 lines, score 1.00']);
      expect(err).to.include(`-- following sleeved (${socket})`);
      stop();
      expect(await following).to.equal(1);
      expect(err.at(-1)).to.equal('-- sleeved stopped');
    });

    it('insists on the daemon with --daemon, and on its own session when options shape one', async () => {
      const failure = async (options: Parameters<typeof nowCommand>[0]) => (await nowCommand(options, io).catch(error => error)).message;
      expect(await failure({ once: true, daemon: true, socket })).to.equal(`sleeved is not running (nothing answers at ${socket})`);
      expect(await failure({ once: true, daemon: true, providers: 'lrclib', socket })).to.equal('--daemon takes no player, provider or store options: sleeved has its own');
      expect(shapesSession({})).to.equal(false);
      expect(shapesSession({ cache: true, prefs: true })).to.equal(false);
      for (const options of [{ mpd: false }, { mpris: 'vlc' }, { musicDir: '/m' }, { providers: 'lrclib' }, { timeout: '5' }, { cache: false }, { prefs: false }]) {
        expect(shapesSession(options), JSON.stringify(options)).to.equal(true);
      }
    });
  });

  describe('sleeve ctl', () => {
    it('nudges, sets and removes the offset, and lists and picks candidates', async () => {
      await startDaemon();
      expect(await ctlCommand('nudge', ['+100'], { socket }, io)).to.equal(0);
      expect(await ctlCommand('nudge', ['-250'], { socket }, io)).to.equal(0);
      expect(await ctlCommand('offset', ['0'], { socket }, io)).to.equal(0);
      expect(out).to.deep.equal(['Offset +100ms', 'Offset -150ms', 'Offset removed']);
      out.length = 0;
      expect(await ctlCommand('candidates', [], { socket }, io)).to.equal(0);
      expect(out[0]).to.match(/^\*\s*1\. lrclib:\d+  lrclib: Death Cab for Cutie - Death of an Interior Decorator/);
      out.length = 0;
      expect(await ctlCommand('pick', ['1'], { socket }, io)).to.equal(0);
      expect(out[0]).to.match(/^Picked lrclib:\d+$/);
      expect(await ctlCommand('unpick', [], { socket }, io)).to.equal(0);
      expect(out.at(-1)).to.equal('Removed the pick');
      expect(await ctlCommand('mark', ['none'], { socket }, io)).to.equal(0);
      expect(out.at(-1)).to.equal('Marked: no correct lyrics');
      expect(await ctlCommand('unpick', [], { socket }, io)).to.equal(0);
      expect(out.at(-1)).to.equal('Removed the pick');
      await ctlCommand('mark', ['nope'], { socket }, io).then(() => expect.fail('marked'), error => expect(error.message).to.equal('Invalid mark: nope (none or instrumental)'));
      expect(await ctlCommand('pick', ['9'], { socket }, io)).to.equal(1);
      expect(err.at(-1)).to.equal('No candidate 9; list them with sleeve ctl candidates');
      expect(await ctlCommand('pick', ['nope:1'], { socket }, io)).to.equal(1);
      expect(err.at(-1)).to.match(/^No candidate nope:1 for /);
    });

    it('says when there is nothing to move, and refuses bad usage and a missing daemon', async () => {
      const failure = async (action: string, args: string[]) => (await ctlCommand(action, args, { socket }, io).catch(error => error)).message;
      expect(await failure('nudge', ['+100'])).to.equal(`sleeved is not running (nothing answers at ${socket})`);
      expect(await failure('jump', [])).to.equal('Unknown action: jump (nudge, offset, pick, mark, unpick, refresh, candidates, display)');
      expect(await failure('nudge', [])).to.equal('Usage: sleeve ctl nudge <ms>');
      expect(await failure('refresh', ['x'])).to.equal('Usage: sleeve ctl refresh');
      expect(await failure('offset', ['soon'])).to.match(/^Invalid offset: soon/);
      expect(await failure('pick', ['?'])).to.match(/^Invalid candidate: \?/);
    });
  });
});
