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
import { fakePlayer } from '../helpers/players.ts';

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
  let daemon: SleeveDaemon | null = null, session: NowPlaying | null = null;

  async function startDaemon(position = 0) {
    session = new NowPlaying(new PlayerHub([fakePlayer('mpd', { playback: playing(position) })]), { lookup: async () => result });
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

  const start = () => {
    running = lineCommand({ socket: socketPath }, { out: text => out.push(text), err: text => err.push(text) }, { signal: stopped.signal, reconnectMs: 10 });
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
    await until(() => out.includes('third'));
    expect(out).to.deep.equal(['first', 'second', 'third']);
    stopped.abort();
    expect(await running).to.equal(0);
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
