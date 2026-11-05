import { expect } from 'chai';
import { reportsCommand } from '../../src/cli/reports.ts';
import { TrackPrefs } from '../../src/core/prefs.ts';
import type { Candidate } from '../../src/core/types.ts';

const shown: Candidate = {
  provider: 'lrclib', id: '12', track: { artist: 'A', title: 'T' },
  lyrics: { synced: true, instrumental: false, lines: [{ time: 1000, text: 'words' }] }
};

describe('sleeve reports', () => {
  let prefs: TrackPrefs, out: string[], err: string[];
  const io = { out: (text: string) => out.push(text), err: (text: string) => err.push(text) };
  const failure = (file: string | undefined, options: object) => reportsCommand(file, options, io, { prefs }).then(() => expect.fail('ran'), error => error.message);
  beforeEach(() => {
    prefs = new TrackPrefs(':memory:');
    out = [];
    err = [];
  });
  afterEach(() => prefs.close());

  it('lists what was reported, and says how files catch up', async () => {
    expect(await reportsCommand(undefined, {}, io, { prefs })).to.equal(0);
    expect(out).to.deep.equal(['Nothing reported']);
    out.length = 0;
    prefs.addReport({ artist: 'A', title: 'T', durationMs: 1000 }, 'wrong', shown);
    expect(await reportsCommand(undefined, {}, io, { prefs })).to.equal(0);
    expect(out[0]).to.match(/^wrong {4}A - T {2}lrclib:12 {2}/);
    expect(err[0]).to.contain('--fix-reported');
    out.length = 0;
    await reportsCommand(undefined, { json: true }, io, { prefs });
    expect(JSON.parse(out[0])[0]).to.deep.include({ kind: 'wrong', artist: 'A', id: '12' });
  });

  it('forgets a track\'s, or every track\'s with --all', async () => {
    prefs.addReport({ artist: 'A', title: 'T' }, 'wrong', shown);
    prefs.addReport({ artist: 'B', title: 'U' }, 'mistimed', shown);
    await reportsCommand(undefined, { reset: true, artist: 'A', title: 'T' }, io, { prefs });
    expect(out.at(-1)).to.equal('Forgot the reports of A - T');
    await reportsCommand(undefined, { reset: true, artist: 'A', title: 'T' }, io, { prefs });
    expect(out.at(-1)).to.equal('Nothing reported for A - T');
    await reportsCommand(undefined, { reset: true, all: true }, io, { prefs });
    expect(out.at(-1)).to.equal('Forgot the reports of 1 track');
    expect(prefs.reportCount()).to.equal(0);
  });

  it('refuses a reset with no track or both, and a track without one', async () => {
    expect(await failure(undefined, { reset: true })).to.contain('--reset needs a track');
    expect(await failure('a.mp3', { reset: true, all: true })).to.contain('--reset needs a track');
    expect(await failure('a.mp3', {})).to.equal('A track or --all goes with --reset');
  });
});
