import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LivePrinter, nowCommand } from '../../src/cli/now.ts';
import { lineAt } from '../../src/now/lines.ts';
import type { Io } from '../../src/cli/lyrics.ts';
import type { NowState } from '../../src/now/session.ts';
import type { Playback } from '../../src/players/types.ts';
import { fakeFetch, fixture } from '../helpers/fetch.ts';
import { fakePlayer } from '../helpers/players.ts';

const deathCab: Playback = {
  player: 'spotify', state: 'playing', positionMs: 20_000, at: 0, rate: 1, changedAt: 0,
  track: { key: 'dc', artist: 'Death Cab for Cutie', title: 'Death of an Interior Decorator', durationMs: 177_000 }
};

describe('sleeve now', () => {
  let out: string[], err: string[], io: Io, dir: string, savedData: string | undefined;
  beforeEach(async () => {
    out = []; err = [];
    io = { out: text => out.push(text), err: text => err.push(text) };
    dir = await mkdtemp(path.join(os.tmpdir(), 'sleeve-now-cli-'));
    savedData = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(dir, 'data');
  });
  afterEach(async () => {
    process.env.XDG_DATA_HOME = savedData;
    await rm(dir, { recursive: true, force: true });
  });

  it('prints the track, the source and the current line with --once, and all of it with --json', async () => {
    const fake = fakeFetch([{ match: /\/api\/get\?/, body: fixture('lrclib/get-death-cab-interior-decorator.json') }]);
    const deps = { players: [fakePlayer('spotify', { playback: deathCab })], musicman: () => null, now: () => 1000, fetch: fake.fetch };
    expect(await nowCommand({ once: true, providers: 'lrclib' }, io, deps)).to.equal(0);
    expect(out).to.deep.equal([
      'spotify playing 0:21/2:57 Death Cab for Cutie - Death of an Interior Decorator',
      'lrclib: Death Cab for Cutie - Death of an Interior Decorator (Transatlanticism) 2:57, synced, 21 lines, score 1.00',
      '> You were the mother of three girls so sweet'
    ]);
    expect(await nowCommand({ once: true, json: true, providers: 'lrclib' }, io, deps)).to.equal(0);
    const json = JSON.parse(out.at(-1)!);
    expect(json).to.deep.include({ player: 'spotify', state: 'playing', positionMs: 21_000, problems: [] });
    expect(json.line).to.deep.equal({ index: 0, timeMs: 18_730, text: 'You were the mother of three girls so sweet' });
    expect(json.lyrics.best.provider).to.equal('lrclib');
  });

  it('says nothing plays, with why the players cannot be reached', async () => {
    const players = [fakePlayer('mpd', { problem: 'connect ECONNREFUSED' }), fakePlayer('spotify')];
    expect(await nowCommand({ once: true }, io, { players, musicman: () => null })).to.equal(1);
    expect(out).to.deep.equal(['Nothing playing']);
    expect(err).to.deep.equal(['  mpd: connect ECONNREFUSED']);
  });

  it('reports a broken musicman contract and goes on without it', async () => {
    const players = [fakePlayer('spotify')];
    await nowCommand({ once: true }, io, { players, musicman: () => { throw new Error('paths.json is version 2'); } });
    expect(err[0]).to.equal('musicman: paths.json is version 2');
    await nowCommand({ once: true }, io, {
      players, musicman: () => ({ mpd: { host: 'h', port: 1, baseDirectory: '/m' }, db: { path: '/m/db' } }),
      openLibrary: () => { throw new Error('/m/db has no spotify_track_files view'); }
    });
    expect(err).to.include('musicman: /m/db has no spotify_track_files view');
  });

  it('refuses proxies as MPRIS players, --json without --once, and no players at all', async () => {
    const refused = async (options: Parameters<typeof nowCommand>[0]) => (await nowCommand(options, io, { musicman: () => null }).catch(error => error)).message;
    expect(await refused({ mpris: 'spotify,playerctld' })).to.equal('Not an MPRIS player of its own: playerctld (MPD is read directly; leave out playerctld)');
    expect(await refused({ json: true })).to.equal('--json needs --once');
    expect(await refused({ mpd: false, mpris: false, once: true })).to.equal('No players: leave MPD or MPRIS on');
  });
});

describe('LivePrinter', () => {
  it('prints the track, its source, pauses and each line once as it comes due', () => {
    const out: string[] = [];
    const printer = new LivePrinter({ out: text => out.push(text), err: () => {} });
    const best = {
      provider: 'lrclib', id: '1', track: { artist: 'A', title: 'T', durationMs: 60_000 }, score: 1, detail: { title: 1, artist: 1, album: null, duration: null },
      lyrics: { synced: true, instrumental: false, lines: [{ time: 1000, text: 'one' }, { time: 2000, text: '' }, { time: 3000, text: 'three' }] }
    };
    const playback: Playback = { player: 'mpd', state: 'playing', positionMs: 0, at: 0, rate: 1, changedAt: 0, track: { key: 'k', artist: 'A', title: 'T' } };
    let state: NowState = { playback, query: { artist: 'A', title: 'T' }, result: null, loading: true, error: null };
    let position = 0;
    const session = { current: () => state, line: () => {
      const lines = best.lyrics.lines;
      let index = -1;
      lines.forEach((line, at) => { if (line.time + (state.result?.offsetMs ?? 0) <= position) index = at; });
      return index < 0 ? { index, line: null, time: null } : { index, line: lines[index], time: lines[index].time + (state.result?.offsetMs ?? 0) };
    } };

    printer.render(session);
    state = { ...state, loading: false, result: { best, candidates: [best], rejected: [], errors: [], pinned: true, offsetMs: 0 } };
    printer.render(session);
    for (position of [500, 1000, 1500, 2000, 3000, 3100]) printer.render(session);
    state = { ...state, playback: { ...playback, state: 'paused' } };
    printer.render(session);
    position = 1000;
    state = { ...state, playback };
    printer.render(session);
    state = { ...state, playback: null, query: null, result: null };
    printer.render(session);
    expect(out).to.deep.equal([
      '\n== A - T [mpd]',
      '-- lrclib: A - T 1:00, synced, 3 lines, score 1.00, pinned',
      '[0:01] one',
      '[0:03] three',
      '-- paused',
      '-- playing',
      '[0:01] one',
      '\n== Nothing playing'
    ]);
  });

  it('shows unsynced lyrics whole and says why there are none', () => {
    const out: string[] = [];
    const printer = new LivePrinter({ out: text => out.push(text), err: () => {} });
    const playback: Playback = { player: 'spotify', state: 'playing', positionMs: 0, at: 0, rate: 1, changedAt: 0, track: { key: 'k', artist: '', title: 'T' } };
    const unsynced = {
      provider: 'lrclib', id: '1', track: { artist: 'A', title: 'T' }, score: 1, detail: { title: 1, artist: 1, album: null, duration: null },
      lyrics: { synced: false, instrumental: false, lines: [{ time: null, text: 'la' }, { time: null, text: 'di' }] }
    };
    const line = () => ({ index: -1, line: null, time: null });
    printer.render({ current: () => ({ playback, query: null, result: null, loading: false, error: null }), line });
    const other = { ...playback, track: { key: 'j', artist: 'A', title: 'U' } };
    printer.render({ current: () => ({ playback: other, query: { artist: 'A', title: 'U' }, result: { best: unsynced, candidates: [], rejected: [], errors: [], pinned: false, offsetMs: 0 }, loading: false, error: null }), line });
    const third = { ...playback, track: { key: 'i', artist: 'A', title: 'V' } };
    printer.render({ current: () => ({ playback: third, query: { artist: 'A', title: 'V' }, result: { best: null, candidates: [], rejected: [], errors: [{ provider: 'lrclib', message: 'timed out' }], pinned: false, offsetMs: 0 }, loading: false, error: null }), line });
    expect(out).to.deep.equal([
      '\n== T [spotify]', '-- no artist or title to look up',
      '\n== A - U [spotify]', '-- lrclib: A - T ?:??, unsynced, 2 lines, score 1.00', 'la', 'di',
      '\n== A - V [spotify]', '-- no lyrics found', '-- lrclib failed: timed out'
    ]);
  });

  describe('drawing a line in place', () => {
    // A line with word times, one without, and a last one
    const lines = [
      { time: 1000, text: 'Hello there', words: [{ time: 1000, text: 'Hello ' }, { time: 1500, text: 'there' }] },
      { time: 3000, text: 'no times here' },
      { time: 6000, text: 'end' }
    ];
    const best = {
      provider: 'lrclib', id: '1', track: { artist: 'A', title: 'T', durationMs: 60_000 }, score: 1, detail: { title: 1, artist: 1, album: null, duration: null },
      lyrics: { synced: true, instrumental: false, lines }
    };
    const playback: Playback = { player: 'mpd', state: 'playing', positionMs: 0, at: 0, rate: 1, changedAt: 0, track: { key: 'k', artist: 'A', title: 'T' } };
    const result = { best, candidates: [best], rejected: [], errors: [], pinned: false, offsetMs: 0 };

    const run = (estimateWords: boolean, positions: number[], between?: (printer: LivePrinter) => void) => {
      const out: string[] = [];
      const written: string[] = [];
      const printer = new LivePrinter({ out: text => out.push(text), err: () => {} }, { write: text => written.push(text), estimateWords });
      let position = 0;
      const session = {
        current: (): NowState => ({ playback, query: { artist: 'A', title: 'T' }, result, loading: false, error: null }),
        line: () => lineAt(result, position),
        position: () => position
      };
      for (position of positions) printer.render(session);
      between?.(printer);
      printer.close();
      return { out, written };
    };

    it('fills a line with word times as it is sung, the rest dim, and leaves it whole when the next starts', () => {
      const { out, written } = run(false, [1000, 1100, 1500, 3000]);
      expect(written).to.deep.equal([
        '\r\u001b[2K[0:01] Hello \u001b[2mthere\u001b[22m',
        '\r\u001b[2K[0:01] Hello there',
        '\r\u001b[2K[0:01] Hello there\n'
      ]);
      // A line without word times is printed as before, unless estimates are asked for
      expect(out.slice(-1)).to.deep.equal(['[0:03] no times here']);
    });

    it('estimates word times for every line when asked', () => {
      const { written } = run(true, [3000, 4000]);
      expect(written[0]).to.equal('\r\u001b[2K[0:03] no \u001b[2mtimes here\u001b[22m');
      expect(written.at(-1)).to.equal('\r\u001b[2K[0:03] no times here\n');
    });

    it('ends the line in place before printing anything else', () => {
      const { out, written } = run(false, [1000], printer => printer.say('-- offset +100ms'));
      expect(written.at(-1)).to.equal('\r\u001b[2K[0:01] Hello there\n');
      expect(out.at(-1)).to.equal('-- offset +100ms');
      expect(written).to.have.length(2);
    });
  });
});
