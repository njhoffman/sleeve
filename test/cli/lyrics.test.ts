import { expect } from 'chai';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../src/cli/index.ts';
import { lyricsCommand, parseDuration, type Io } from '../../src/cli/lyrics.ts';
import { fakeFetch, fixture } from '../helpers/fetch.ts';
import { writeTaggedMp3 } from '../helpers/id3.ts';

describe('sleeve lyrics', () => {
  let out: string[], err: string[], io: Io, dir: string, savedData: string | undefined;
  beforeEach(async () => {
    out = []; err = [];
    io = { out: text => out.push(text), err: text => err.push(text) };
    dir = await mkdtemp(path.join(os.tmpdir(), 'sleeve-cli-'));
    // Each test gets its own database, so stored answers never leak between tests
    savedData = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(dir, 'data');
  });
  afterEach(async () => {
    process.env.XDG_DATA_HOME = savedData;
    await rm(dir, { recursive: true, force: true });
  });

  const lrclib = (routes: Parameters<typeof fakeFetch>[0]) => fakeFetch(routes);
  const deathCab = fixture('lrclib/get-death-cab-interior-decorator.json');

  it('parses durations in seconds or m:ss', () => {
    expect(parseDuration('177')).to.equal(177000);
    expect(parseDuration('2:57.5')).to.equal(177500);
    expect(() => parseDuration('soon')).to.throw('Invalid duration: soon');
  });

  it('prints the best LRC to stdout and its source to stderr', async () => {
    const fake = lrclib([{ match: /\/api\/get\?/, body: deathCab }]);
    const code = await lyricsCommand(undefined, { artist: 'Death Cab for Cutie', title: 'Death of an Interior Decorator', duration: '2:57' }, io, { fetch: fake.fetch });
    expect(code).to.equal(0);
    expect(err).to.deep.equal(['lrclib: Death Cab for Cutie - Death of an Interior Decorator (Transatlanticism) 2:57, synced, 21 lines, score 1.00']);
    expect(out[0].split('\n')[0]).to.equal('[00:18.73]You were the mother of three girls so sweet');
  });

  it('prints plain text, every candidate, or JSON', async () => {
    const fake = lrclib([{ match: /\/api\/get\?/, body: deathCab }]);
    const options = { artist: 'Death Cab for Cutie', title: 'Death of an Interior Decorator', duration: '177' };
    await lyricsCommand(undefined, { ...options, format: 'plain' }, io, { fetch: fake.fetch });
    expect(out.at(-1)!.split('\n')[0]).to.equal('You were the mother of three girls so sweet');
    await lyricsCommand(undefined, { ...options, all: true }, io, { fetch: fake.fetch });
    expect(out.at(-1)).to.match(/^lrclib: Death Cab for Cutie .* score 1\.00, cached$/);
    await lyricsCommand(undefined, { ...options, json: true }, io, { fetch: fake.fetch });
    const json = JSON.parse(out.at(-1)!);
    expect(json.query).to.deep.equal({ artist: 'Death Cab for Cutie', title: 'Death of an Interior Decorator', durationMs: 177000 });
    expect(json.best.provider).to.equal('lrclib');
  });

  it('uses a file\'s tags and prefers its own synced lyrics without going online', async () => {
    const file = await writeTaggedMp3(path.join(dir, 'song.mp3'), { artist: 'A', title: 'T', synced: [{ time: 1000, text: 'Mine' }] });
    const fake = lrclib([]);
    expect(await lyricsCommand(file, {}, io, { fetch: fake.fetch })).to.equal(0);
    expect(out).to.deep.equal(['[00:01.00]Mine']);
    expect(err[0]).to.match(/^embedded: A - T 0:03, synced, 1 line, score 1\.00$/);
    expect(fake.calls).to.deep.equal([]);
  });

  it('reads a sidecar .lrc, and limits the providers to the ones named', async () => {
    const file = await writeTaggedMp3(path.join(dir, 'song.mp3'), { artist: 'A', title: 'T' });
    await writeFile(path.join(dir, 'song.lrc'), '[00:02.00]Sidecar');
    const fake = lrclib([]);
    await lyricsCommand(file, { providers: 'sidecar' }, io, { fetch: fake.fetch });
    expect(out).to.deep.equal(['[00:02.00]Sidecar']);
    const error = await lyricsCommand(file, { providers: 'sidecar,spotify' }, io).catch(caught => caught);
    expect(error.message).to.equal('Unknown provider: spotify (known: sidecar, embedded, lrclib, netease)');
  });

  it('exits 1 with the reasons when nothing matches', async () => {
    const fake = lrclib([{ match: /lrclib/, status: 503, body: fixture('lrclib/overloaded.json') }]);
    const code = await lyricsCommand(undefined, { artist: 'Nobody', title: 'Nothing', providers: 'lrclib', timeout: '0.05' }, io, { fetch: fake.fetch });
    expect(code).to.equal(1);
    expect(err[0]).to.equal('No lyrics found for Nobody - Nothing');
    expect(err[1]).to.match(/^ {2}lrclib failed: (timed out|LRCLIB answered 503)/);
  });

  it('stores online answers in the user\'s database, and skips it with --no-cache or asks again with --refresh', async () => {
    const fake = lrclib([{ match: /\/api\/get\?/, body: deathCab }]);
    const options = { artist: 'Death Cab for Cutie', title: 'Death of an Interior Decorator', duration: '177', providers: 'lrclib' };
    await lyricsCommand(undefined, options, io, { fetch: fake.fetch });
    await lyricsCommand(undefined, options, io, { fetch: fake.fetch });
    expect(fake.calls).to.have.length(1);
    expect(err.at(-1)).to.match(/score 1\.00, cached$/);

    await lyricsCommand(undefined, { ...options, cache: false }, io, { fetch: fake.fetch });
    await lyricsCommand(undefined, { ...options, refresh: true }, io, { fetch: fake.fetch });
    expect(fake.calls).to.have.length(3);
    expect(err.at(-1)).to.match(/score 1\.00$/);

    expect(await main(['cache'], io)).to.equal(0);
    expect(out.at(-2)).to.equal(`${path.join(dir, 'data', 'sleeve', 'sleeve.db')}: 1 answers, 1 with lyrics, 0 without`);
    expect(out.at(-1)).to.equal('  lrclib: 1 with lyrics, 0 without');
    expect(await main(['cache', '--json'], io)).to.equal(0);
    expect(JSON.parse(out.at(-1)!)).to.include({ answers: 1, found: 1, notFound: 0 });
    expect(await main(['cache', 'clear', '--not-found'], io)).to.equal(0);
    expect(out.at(-1)).to.equal('Removed 0 "none" answers');
    expect(await main(['cache', 'clear', '-p', 'LRCLIB'], io)).to.equal(0);
    expect(out.at(-1)).to.equal('Removed 1 answers from lrclib');
  });

  it('reports bad usage through main with an exit code', async () => {
    expect(await main(['lyrics'], io)).to.equal(2);
    expect(err.at(-1)).to.equal('Error: Give a file, or --artist and --title');
    expect(await main(['lyrics', '-a', 'A', '-t', 'T', '--format', 'xml'], io)).to.equal(2);
    expect(err.at(-1)).to.equal('Error: Invalid format: xml (use lrc or plain)');
    expect(await main(['--version'], io)).to.equal(0);
    expect(out.at(-1)).to.match(/^\d+\.\d+\.\d+$/);
    expect(await main(['nope'], io)).to.equal(1);
  });
});
