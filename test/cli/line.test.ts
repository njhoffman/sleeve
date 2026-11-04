import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LyricsResult, ScoredCandidate } from '../../src/core/types.ts';
import { lineCommand } from '../../src/cli/line.ts';
import { SleeveDaemon } from '../../src/daemon/server.ts';
import { NowPlaying } from '../../src/now/session.ts';
import { monotonic } from '../../src/players/clock.ts';
import { PlayerHub } from '../../src/players/hub.ts';
import type { Playback } from '../../src/players/types.ts';
import { until } from '../helpers/fakeMpd.ts';
import { fakePlayer, type FakePlayer } from '../helpers/players.ts';

const candidate: ScoredCandidate = {
  provider: 'fake', id: '1', track: { artist: 'A', title: 'T' }, score: 1, detail: { title: 1, artist: 1, album: null, duration: null },
  lyrics: { synced: true, instrumental: false, lines: [{ time: 0, text: 'first' }, { time: 60, text: 'second' }, { time: 120, text: 'second' }, { time: 180, text: 'third' }] }
};
const result: LyricsResult = { best: candidate, candidates: [candidate], rejected: [], errors: [], pinned: false, offsetMs: 0 };
const playing = (positionMs: number): Playback => ({
  player: 'mpd', state: 'playing', positionMs, at: monotonic(), rate: 1, changedAt: 0, track: { key: 'k', artist: 'A', title: 'T', durationMs: 200_000 }
});

describe('sleeve line', () => {
  let folder: string, socketPath: string, stopped: AbortController, out: string[], err: string[], running: Promise<number>;
  let daemon: SleeveDaemon | null = null, session: NowPlaying | null = null, player: FakePlayer;

  // Paused unless at the end: the lines must not run before the client is connected, however busy the machine
  async function startDaemon(position = 0, answer = result) {
    player = fakePlayer('mpd', { playback: { ...playing(position), state: 'paused' } });
    const hub = new PlayerHub([player]);
    hub.start();
    session = new NowPlaying(hub, { lookup: async () => answer });
    session.start();
    daemon = new SleeveDaemon(session, { port: null, socketPath });
    await daemon.listen();
    await session.settled();
  }

  async function stopDaemon() {
    await daemon?.close();
    session?.close();
    daemon = session = null;
  }

  const start = (between?: string) => {
    running = lineCommand({ socket: socketPath, ...(between === undefined ? {} : { between }) }, { out: text => out.push(text), err: text => err.push(text) }, { signal: stopped.signal, reconnectMs: 10 });
  };

  beforeEach(async () => {
    folder = await mkdtemp(path.join(os.tmpdir(), 'sleeve-line-'));
    socketPath = path.join(folder, 'sleeved.sock');
    stopped = new AbortController();
    out = [];
    err = [];
  });

  afterEach(async () => {
    stopped.abort();
    await running;
    await stopDaemon();
    await rm(folder, { recursive: true, force: true });
  });

  it('prints each line as it starts, a repeated line once, and ends with the signal', async () => {
    await startDaemon();
    start();
    await until(() => out.includes('first'));
    player.set(playing(0));
    await until(() => out.includes('third'));
    expect(out).to.deep.equal(['first', 'second', 'third']);
    stopped.abort();
    expect(await running).to.equal(0);
  });

  describe('with --between', () => {
    const later = (lines: ScoredCandidate['lyrics']['lines'], synced = true): LyricsResult => {
      const best = { ...candidate, lyrics: { synced, instrumental: false, lines } };
      return { ...result, best, candidates: [best] };
    };

    it('prints it before the first line of synced lyrics', async () => {
      await startDaemon(0, later([{ time: 60_000, text: 'much later' }]));
      start('~');
      await until(() => out.length > 0);
      expect(out).to.deep.equal(['~']);
    });

    it('prints it for a blank line, and the lines around it as usual', async () => {
      await startDaemon(0, later([{ time: 0, text: 'first' }, { time: 50, text: ' ' }, { time: 100, text: 'second' }]));
      start('~');
      await until(() => out.includes('first'));
      player.set(playing(0));
      await until(() => out.includes('second'));
      expect(out).to.deep.equal(['first', '~', 'second']);
    });

    it('prints an empty line for unsynced lyrics and for none', async () => {
      await startDaemon(0, later([{ time: null, text: 'plain' }], false));
      start('~');
      await until(() => out.length > 0);
      expect(out).to.deep.equal(['']);
      await stopDaemon();
      await startDaemon(0, { ...result, best: null, candidates: [] });
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(out).to.deep.equal(['']);
    });

    it('prints an empty line without it, as ever', async () => {
      await startDaemon(0, later([{ time: 60_000, text: 'much later' }]));
      start();
      await until(() => out.length > 0);
      expect(out).to.deep.equal(['']);
    });
  });

  it('waits for sleeved, saying so once, and clears the line when it goes away and follows it back', async () => {
    start();
    await until(() => err.length > 0);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(err).to.have.length(1);
    expect(err[0]).to.include(socketPath);
    expect(out).to.deep.equal([]);

    await startDaemon(190);
    await until(() => out.includes('third'));
    await stopDaemon();
    await until(() => out.at(-1) === '');

    await startDaemon(190);
    await until(() => out.at(-1) === 'third');
  });
});
