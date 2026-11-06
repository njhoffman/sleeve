import { expect } from 'chai';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Io } from '../../src/cli/lyrics.ts';
import { reviewCommand, type Ask, type ReviewDeps } from '../../src/cli/review.ts';
import { LyricsCache } from '../../src/core/cache.ts';
import { queryForFile } from '../../src/core/fetchLyrics.ts';
import { musicMetadataReader } from '../../src/core/tags/musicMetadata.ts';
import { SleeveDatabase } from '../../src/core/db.ts';
import { TrackPrefs } from '../../src/core/prefs.ts';
import type { Provider } from '../../src/core/providers/provider.ts';
import { TagFallbacks, TagRetries } from '../../src/core/retries.ts';
import { readLyricsTag } from '../../src/core/tags/lyricsTag.ts';
import type { Candidate, Lyrics } from '../../src/core/types.ts';
import { writeTaggedMp3 } from '../helpers/id3.ts';

const lyrics: Lyrics = { synced: true, instrumental: false, lines: [{ time: 1000, text: 'Placeholder one' }, { time: 2000, text: 'Placeholder two' }] };
const candidate = (id: string, seconds: number, shape = lyrics): Candidate => ({ provider: 'fake', id, track: { artist: 'Artist', title: 'Song', durationMs: seconds * 1000 }, lyrics: shape });

describe('sleeve review', () => {
  let dir: string, database: SleeveDatabase, out: string[], err: string[], io: Io, prefs: TrackPrefs;
  // What each file's title gets from the provider
  let answers: Record<string, Candidate[]>;
  const provider: Provider = { name: 'fake', local: false, search: async query => (answers[query.title] ?? []).map(found => ({ ...found, track: { ...found.track, title: query.title } })) };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sleeve-review-'));
    database = new SleeveDatabase(':memory:');
    prefs = new TrackPrefs(database);
    out = [];
    err = [];
    io = { out: text => out.push(text), err: text => err.push(text) };
    answers = {};
  });
  afterEach(async () => {
    database.close();
    await rm(dir, { recursive: true, force: true });
  });

  const mp3 = (title: string) => writeTaggedMp3(path.join(dir, `${title}.mp3`), { artist: 'Artist', title });
  const keys = (...answers: string[]): { ask: Ask; prompts: string[] } => {
    const prompts: string[] = [];
    return { prompts, ask: async prompt => { prompts.push(prompt); return answers.shift() ?? 'q'; } };
  };
  const review = (deps: Partial<ReviewDeps> = {}, list = false) => reviewCommand([dir], { ...(list ? { list } : {}) }, io, {
    providers: [provider], cache: new LyricsCache(database), prefs, retries: new TagRetries(database), fallbacks: new TagFallbacks(database),
    input: { isTTY: false } as NodeJS.ReadStream, ...deps
  });
  const prefsOf = async (title: string) => prefs.get(await queryForFile(path.join(dir, `${title}.mp3`), {}, musicMetadataReader));
  const written = async (file: string) => (await readLyricsTag(file)).uslt?.text ?? null;

  it('says so when nothing is doubtful', async () => {
    await mp3('fits');
    answers.fits = [candidate('1', 3)];
    expect(await review({ ask: keys().ask })).to.equal(0);
    expect(out).to.deep.equal(['Nothing doubtful here']);
  });

  it('lists them closest first, and lyrics that stop early or run past the end last, without a terminal', async () => {
    for (const title of ['far', 'near', 'past']) await mp3(title);
    answers.far = [candidate('1', 12)];
    answers.near = [candidate('2', 9)];
    answers.past = [candidate('3', 3, { ...lyrics, lines: [{ time: 1000, text: 'x' }, { time: 3500, text: 'y' }] })];
    expect(await review()).to.equal(0);
    expect(out).to.deep.equal([
      'fake:2 is 6 s longer than the file  near.mp3', 'fake:1 is 9 s longer than the file  far.mp3', 'fake:3 runs past the end of the file  past.mp3'
    ]);
    expect(err).to.deep.equal(['3 doubtful']);
    expect((await review({ ask: keys().ask }, true))).to.equal(0);
    expect(await written(path.join(dir, 'near.mp3'))).to.equal(null);
  });

  it('writes what is accepted, pinned for every display, leaving the file\'s other frames', async () => {
    const file = await mp3('near');
    answers.near = [candidate('2', 9)];
    expect(await review({ ask: keys('a').ask })).to.equal(0);
    expect(await written(file)).to.include('Placeholder one');
    expect((await prefsOf('near'))?.pick).to.deep.include({ provider: 'fake', id: '2' });
    expect(err.at(-1)).to.equal('1 written · 0 marked · 0 skipped');
    expect(out.join('\n')).to.include('Written: fake:2');
    // Gone from the next review
    out.length = 0;
    await review({ ask: keys().ask });
    expect(out).to.deep.equal(['Nothing doubtful here']);
  });

  it('leaves a file alone when skipped, and offers it again next time', async () => {
    const file = await mp3('near');
    answers.near = [candidate('2', 9)];
    const before = (await stat(file)).mtimeMs;
    await review({ ask: keys('s').ask });
    expect((await stat(file)).mtimeMs).to.equal(before);
    expect((await prefsOf('near'))).to.equal(null);
    expect(err.at(-1)).to.equal('0 written · 0 marked · 1 skipped');
    const next = keys('q');
    await review({ ask: next.ask });
    expect(next.prompts).to.have.length(1);
  });

  it('marks a track, which then does not come back', async () => {
    for (const title of ['one', 'two']) await mp3(title);
    answers.one = [candidate('1', 9)];
    answers.two = [candidate('2', 9)];
    await review({ ask: keys('n', 'i').ask });
    expect((await prefsOf('one'))?.mark).to.equal('none');
    expect((await prefsOf('two'))?.mark).to.equal('instrumental');
    expect(await written(path.join(dir, 'one.mp3'))).to.equal(null);
    out.length = 0;
    await review({ ask: keys().ask });
    expect(out).to.deep.equal(['Nothing doubtful here']);
  });

  it('shows the lyrics\' start and end with their times, and goes on asking', async () => {
    const lines = Array.from({ length: 20 }, (_, at) => ({ time: at * 100, text: `Placeholder ${at + 1}` }));
    const file = await mp3('long');
    answers.long = [candidate('1', 9, { ...lyrics, lines })];
    await review({ ask: keys('p', 's').ask });
    const text = out.join('\n');
    expect(text).to.match(/\[0?0:00(\.00)?\] Placeholder 1\n/);
    expect(text).to.include('Placeholder 6\n');
    expect(text).to.include('... 11 more ...');
    expect(text).to.include('Placeholder 20');
    expect(text).to.not.include('Placeholder 7\n');
    expect(await written(file)).to.equal(null);
  });

  it('takes another candidate, which is what accepting then writes', async () => {
    const file = await mp3('two');
    const other: Lyrics = { ...lyrics, lines: [{ time: 1000, text: 'Other one' }, { time: 2000, text: 'Other two' }] };
    answers.two = [candidate('1', 9), candidate('2', 10, other)];
    const asked = keys('o', '2', 'a');
    await review({ ask: asked.ask });
    expect(await written(file)).to.include('Other one');
    expect((await prefsOf('two'))?.pick).to.deep.include({ id: '2' });
    expect(asked.prompts[0]).to.include('ther (1)');
  });

  it('keeps the candidate when asked to, and offers no others when there are none', async () => {
    const file = await mp3('two');
    answers.two = [candidate('1', 9), candidate('2', 10)];
    await review({ ask: keys('o', 'k', 'a').ask });
    expect((await prefsOf('two'))?.pick).to.deep.include({ id: '1' });
    expect(await written(file)).to.include('Placeholder one');
    await mp3('one');
    answers.one = [candidate('3', 9)];
    const asked = keys('q');
    await review({ ask: asked.ask });
    expect(asked.prompts[0]).to.not.include('ther (');
  });

  it('stops at quit, also from the list of others, and says how many were not reached', async () => {
    for (const title of ['a', 'b', 'c']) await mp3(title);
    for (const title of ['a', 'b', 'c']) answers[title] = [candidate(title, 9), candidate(`${title}2`, 10)];
    await review({ ask: keys('s', 'o', 'q').ask });
    expect(err.at(-1)).to.equal('0 written · 0 marked · 1 skipped · 2 not reached');
  });

  it('says so and exits 1 when a file cannot be written, the pick staying', async () => {
    const file = await mp3('near');
    answers.near = [candidate('2', 9)];
    const asked: Ask = async () => { await writeFile(file, 'not an mp3 any more'); return 'a'; };
    expect(await review({ ask: asked })).to.equal(1);
    expect(err.join('\n')).to.include('not written:');
    expect(err.at(-1)).to.equal('0 written · 0 marked · 0 skipped · 1 failed');
  });
});
