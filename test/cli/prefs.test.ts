import { expect } from 'chai';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../src/cli/index.ts';
import { offsetCommand, parseOffset, pickCommand } from '../../src/cli/prefs.ts';
import type { Io } from '../../src/cli/lyrics.ts';
import { fakeFetch, fixture } from '../helpers/fetch.ts';
import { writeTaggedMp3 } from '../helpers/id3.ts';

describe('sleeve pick and sleeve offset', () => {
  let out: string[], err: string[], io: Io, dir: string, savedData: string | undefined, file: string;
  beforeEach(async () => {
    out = []; err = [];
    io = { out: text => out.push(text), err: text => err.push(text) };
    dir = await mkdtemp(path.join(os.tmpdir(), 'sleeve-prefs-'));
    savedData = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(dir, 'data');
    // Two local candidates: the sidecar (two lines) ranks over the embedded lyrics (one line)
    file = await writeTaggedMp3(path.join(dir, 'song.mp3'), { artist: 'A', title: 'T', synced: [{ time: 1000, text: 'Embedded' }] });
    await writeFile(path.join(dir, 'song.lrc'), '[00:02.00]Sidecar\n[00:04.00]Two');
  });
  afterEach(async () => {
    process.env.XDG_DATA_HOME = savedData;
    await rm(dir, { recursive: true, force: true });
  });

  const embeddedRef = () => `embedded:${file}#SYLT`;
  const local = ['-p', 'sidecar,embedded'];

  it('parses offsets in whole milliseconds', () => {
    expect(parseOffset('250')).to.equal(250);
    expect(parseOffset('+250ms')).to.equal(250);
    expect(parseOffset('-1200')).to.equal(-1200);
    expect(() => parseOffset('1.5s')).to.throw('Invalid offset: 1.5s');
  });

  it('numbers candidates in sleeve lyrics --all and picks one by number, then shows it from then on', async () => {
    expect(await main(['lyrics', file, '--all', ...local], io)).to.equal(0);
    expect(out[0]).to.match(new RegExp(`^1 sidecar:${dir}/song\\.lrc {2}sidecar: A - T`));
    expect(out[1]).to.equal(`2 ${embeddedRef()}  embedded: A - T 0:03, synced, 1 line, score 1.00`);

    expect(await main(['pick', file, '2', ...local], io)).to.equal(0);
    expect(out.at(-1)).to.equal(`Picked ${embeddedRef()} for A - T: embedded: A - T 0:03, synced, 1 line, score 1.00`);
    expect(await main(['lyrics', file, ...local], io)).to.equal(0);
    expect(out.at(-1)).to.equal('[00:01.00]Embedded');
    expect(err.at(-1)).to.equal('embedded: A - T 0:03, synced, 1 line, score 1.00, pinned');

    expect(await main(['lyrics', file, '--all', ...local], io)).to.equal(0);
    expect(out.at(-2)).to.equal(`1 ${embeddedRef()}  embedded: A - T 0:03, synced, 1 line, score 1.00, pinned`);

    expect(await main(['lyrics', file, '--no-prefs', ...local], io)).to.equal(0);
    expect(out.at(-1)).to.equal('[00:02.00]Sidecar\n[00:04.00]Two');

    expect(await main(['pick', '--reset', file], io)).to.equal(0);
    expect(out.at(-1)).to.equal('Removed the pick for A - T');
    expect(await main(['pick', '--reset', file], io)).to.equal(0);
    expect(out.at(-1)).to.equal('No pick for A - T');
  });

  it('picks by provider:id, and says when there is no such candidate', async () => {
    expect(await pickCommand([file, embeddedRef()], { providers: 'sidecar,embedded' }, io)).to.equal(0);
    expect(out.at(-1)).to.match(/^Picked embedded:/);
    expect(await pickCommand([file, 'lrclib:1'], { providers: 'sidecar,embedded' }, io)).to.equal(1);
    expect(err.at(-1)).to.equal('No candidate lrclib:1 for A - T; list them with sleeve lyrics --all');
    expect(await pickCommand([file, '9'], { providers: 'sidecar,embedded' }, io)).to.equal(1);
    const invalid = await pickCommand([file, 'nonsense'], {}, io).catch(caught => caught);
    expect(invalid.message).to.equal('Invalid candidate: nonsense (use provider:id, or a number from sleeve lyrics --all)');
    const missing = await pickCommand([], {}, io).catch(caught => caught);
    expect(missing.message).to.match(/^Give a candidate/);
  });

  it('pins an online candidate by its id, using the stored answer', async () => {
    const fake = fakeFetch([{ match: /\/api\/get\?/, body: fixture('lrclib/get-death-cab-interior-decorator.json') }]);
    const track = { artist: 'Death Cab for Cutie', title: 'Death of an Interior Decorator', duration: '177', providers: 'lrclib' };
    expect(await pickCommand(['lrclib:321980'], track, io, { fetch: fake.fetch })).to.equal(0);
    expect(out.at(-1)).to.match(/^Picked lrclib:321980 for Death Cab for Cutie - Death of an Interior Decorator: lrclib: /);
    expect(await main(['lyrics', '-a', track.artist, '-t', track.title, '-d', '177', '-p', 'lrclib'], io)).to.equal(0);
    expect(err.at(-1)).to.match(/, pinned$/);
    expect(fake.calls).to.have.length(1);
  });

  it('shifts the lyrics shown by an offset, for the candidate it was set against only', async () => {
    expect(await main(['offset', file, ...local], io)).to.equal(0);
    expect(out.at(-1)).to.equal('No offset for A - T');
    expect(await main(['offset', file, '-500', ...local], io)).to.equal(0);
    expect(out.at(-1)).to.equal(`Offset -500ms for sidecar:${dir}/song.lrc (A - T)`);
    expect(await main(['lyrics', file, ...local], io)).to.equal(0);
    expect(out.at(-1)).to.equal('[00:01.50]Sidecar\n[00:03.50]Two');
    expect(err.at(-1)).to.match(/score 1\.00, offset -500ms$/);
    expect(await main(['lyrics', file, '--format', 'plain', ...local], io)).to.equal(0);
    expect(out.at(-1)).to.equal('Sidecar\nTwo');
    expect(await main(['lyrics', file, '--json', ...local], io)).to.equal(0);
    const json = JSON.parse(out.at(-1)!);
    expect(json).to.deep.include({ offsetMs: -500, pinned: false });
    expect(json.best.lyrics.lines[0].time).to.equal(2000);

    expect(await main(['offset', file, ...local], io)).to.equal(0);
    expect(out.at(-1)).to.equal(`Offset -500ms for sidecar:${dir}/song.lrc (A - T)`);
    await main(['pick', file, '2', ...local], io);
    expect(await main(['lyrics', file, ...local], io)).to.equal(0);
    expect(out.at(-1)).to.equal('[00:01.00]Embedded');
    expect(await main(['offset', file, ...local], io)).to.equal(0);
    expect(out.at(-1)).to.equal(`Offset -500ms for sidecar:${dir}/song.lrc, which is not the lyrics shown now (${embeddedRef()}); not applied`);

    expect(await main(['offset', file, '+250', ...local], io)).to.equal(0);
    expect(out.at(-1)).to.equal(`Offset +250ms for ${embeddedRef()} (A - T)`);
    expect(await main(['offset', file, '0', ...local], io)).to.equal(0);
    expect(out.at(-1)).to.equal('Removed the offset for A - T');
    expect(await main(['offset', '--reset', file], io)).to.equal(0);
    expect(out.at(-1)).to.equal('No offset for A - T');
  });

  it('rejects offsets it cannot read and has nothing to offset without lyrics', async () => {
    const bad = await offsetCommand([file, 'soon'], {}, io).catch(caught => caught);
    expect(bad.message).to.equal('Invalid offset: soon (use whole milliseconds, like 250 or -1200)');
    const both = await offsetCommand([file, '100'], { reset: true }, io).catch(caught => caught);
    expect(both.message).to.equal('Give an offset or --reset, not both');
    const bare = await writeTaggedMp3(path.join(dir, 'bare.mp3'), { artist: 'B', title: 'U' });
    expect(await offsetCommand([bare, '100'], { providers: 'sidecar,embedded' }, io)).to.equal(1);
    expect(err.at(-1)).to.equal('No lyrics found for B - U, so nothing to offset');
  });
});
