import { expect } from 'chai';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SleeveDatabase } from '../../src/core/db.ts';
import { TrackPrefs } from '../../src/core/prefs.ts';
import type { Provider } from '../../src/core/providers/provider.ts';
import { FALLBACK_AFTER_MS, FALLBACK_ATTEMPTS, gaveUp, RETRY_BACKOFF_MS, TagFallbacks, TagRetries } from '../../src/core/retries.ts';
import { queryForFile } from '../../src/core/fetchLyrics.ts';
import { listMp3s, tagFiles, type TagReport } from '../../src/core/tagger.ts';
import { parseId3 } from '../../src/core/tags/id3.ts';
import { FileChangedError, readLyricsTag, writeLyricsTag } from '../../src/core/tags/lyricsTag.ts';
import { musicMetadataReader } from '../../src/core/tags/musicMetadata.ts';
import type { Candidate, Lyrics } from '../../src/core/types.ts';
import { SILENCE, writeTaggedMp3 } from '../helpers/id3.ts';

const synced: Lyrics = {
  synced: true, instrumental: false,
  lines: [{ time: 1000, text: 'Hello there', words: [{ time: 1000, text: 'Hello ' }, { time: 1500, text: 'there' }] }, { time: 2500, text: 'Bye' }]
};
const LRC = '[00:01.00]Hello there\n[00:02.50]Bye';

function online(name: string, answer: (title: string) => Candidate[] | Error): Provider & { asked: string[] } {
  const asked: string[] = [];
  return {
    name, local: false, asked,
    async search(query) {
      asked.push(query.title);
      const result = answer(query.title);
      if (result instanceof Error) throw result;
      return result;
    }
  };
}

const candidate = (lyrics: Lyrics, id = '1'): Candidate => ({ provider: 'fake', id, track: { artist: 'Artist', title: 'Song', durationMs: 3000 }, lyrics });

const readQuery = (file: string) => queryForFile(file, {}, musicMetadataReader);

describe('sleeve tag', () => {
  let dir: string;
  let database: SleeveDatabase;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sleeve-tag-'));
    database = new SleeveDatabase(':memory:');
  });
  afterEach(async () => {
    database.close();
    await rm(dir, { recursive: true, force: true });
  });
  const mp3 = (name: string, extra: Parameters<typeof writeTaggedMp3>[1] = {}) =>
    writeTaggedMp3(path.join(dir, name), { artist: 'Artist', title: 'Song', custom: { sp_track_id: 'keep-me' }, ...extra });

  describe('writing the lyrics frame', () => {
    it('writes the USLT, leaving the other frames and the audio as they were, readable by music-metadata', async () => {
      const file = await mp3('a.mp3', { unsynced: '' });
      const before = await readFile(file);
      const tag = await readLyricsTag(file);
      expect(tag).to.deep.include({ version: 3, usltCount: 1 });
      await writeLyricsTag(tag, LRC);
      const after = await readFile(file);
      const old = parseId3(before)!, now = parseId3(after)!;
      expect(after.subarray(now.size).equals(before.subarray(old.size))).to.equal(true);
      for (const index of [0, 1, 2]) {
        expect(after.subarray(now.frames[index].start, now.frames[index].end).equals(before.subarray(old.frames[index].start, old.frames[index].end))).to.equal(true);
      }
      const read = await musicMetadataReader.read(file);
      expect(read).to.deep.include({ artist: 'Artist', title: 'Song', spotifyId: 'keep-me' });
      expect(read.lyrics.map(item => item.text)).to.deep.equal([LRC]);
      expect((await readLyricsTag(file)).uslt).to.deep.equal({ language: 'eng', description: '', text: LRC });
      // No temporary file left behind
      expect((await listMp3s([dir])).map(item => path.basename(item))).to.deep.equal(['a.mp3']);
    });

    it('gives a file without a tag one, and writes through a symlink to the file', async () => {
      const bare = path.join(dir, 'bare.mp3');
      await writeFile(bare, await readFile(SILENCE));
      await writeLyricsTag(await readLyricsTag(bare), LRC);
      expect((await readLyricsTag(bare)).uslt?.text).to.equal(LRC);

      const target = await mp3('target.mp3');
      const link = path.join(dir, 'link.mp3');
      await symlink(target, link);
      await writeLyricsTag(await readLyricsTag(link), LRC);
      expect((await readLyricsTag(target)).uslt?.text).to.equal(LRC);
    });

    it('leaves a file alone that changed after it was read', async () => {
      const file = await mp3('a.mp3');
      const tag = await readLyricsTag(file);
      await utimes(file, new Date(), new Date(Date.now() + 5000));
      const before = await readFile(file);
      await writeLyricsTag(tag, LRC).then(() => expect.fail('wrote'), error => expect(error).to.be.instanceOf(FileChangedError));
      expect((await readFile(file)).equals(before)).to.equal(true);
    });
  });

  describe('retries', () => {
    it('waits longer after each failure in a row, and forgets a file once cleared', () => {
      let clock = 1000;
      const retries = new TagRetries(database, { now: () => clock });
      expect(retries.defer('/a.mp3', 'lrclib: 503').nextAt).to.equal(1000 + RETRY_BACKOFF_MS[0]);
      clock = 2000;
      expect(retries.defer('/a.mp3', 'lrclib: 503')).to.deep.equal({ attempts: 2, nextAt: 2000 + RETRY_BACKOFF_MS[1], error: 'lrclib: 503', firstAt: 1000 });
      for (let count = 0; count < 5; count++) retries.defer('/a.mp3', 'x');
      expect(retries.get('/a.mp3')!.nextAt).to.equal(2000 + RETRY_BACKOFF_MS.at(-1)!);
      retries.clear('/a.mp3');
      expect(retries.get('/a.mp3')).to.equal(null);
      expect(retries.count()).to.equal(0);
    });

    it('gives up waiting after a day and three failures, both', () => {
      const retry = (attempts: number, firstAt: number) => ({ attempts, nextAt: 0, error: 'x', firstAt });
      expect(gaveUp(null, FALLBACK_AFTER_MS)).to.equal(false);
      expect(gaveUp(retry(FALLBACK_ATTEMPTS, 0), FALLBACK_AFTER_MS)).to.equal(true);
      expect(gaveUp(retry(FALLBACK_ATTEMPTS - 1, 0), FALLBACK_AFTER_MS * 2)).to.equal(false);
      expect(gaveUp(retry(10, 1), FALLBACK_AFTER_MS)).to.equal(false);
    });
  });

  describe('tagFiles', () => {
    const run = async (files: string[], options: Parameters<typeof tagFiles>[1]) => {
      const reports: TagReport[] = [];
      const counts = await tagFiles(files, { cache: undefined, sleep: async () => {}, ...options, onFile: report => reports.push(report) });
      return { counts, reports, status: reports.map(report => `${path.basename(report.file)}: ${report.status}`) };
    };

    it('previews without --write, then writes LRC without word times, the user\'s offset applied', async () => {
      const file = await mp3('a.mp3');
      const provider = online('fake', () => [candidate(synced)]);
      const prefs = new TrackPrefs(database);
      prefs.setOffset({ artist: 'Artist', title: 'Song', durationMs: 3000 }, 500, candidate(synced));
      const preview = await run([file], { providers: [provider], prefs });
      expect(preview.status).to.deep.equal(['a.mp3: would write']);
      expect(preview.reports[0].detail).to.equal('fake:1, synced, 2 lines, offset +500ms');
      expect((await readLyricsTag(file)).uslt).to.equal(null);

      const wrote = await run([file], { providers: [provider], prefs, write: true });
      expect(wrote.status).to.deep.equal(['a.mp3: written']);
      expect((await readLyricsTag(file)).uslt?.text).to.equal('[00:01.50]Hello there\n[00:03.00]Bye');
      expect((await run([file], { providers: [provider], prefs, write: true, force: true })).status).to.deep.equal(['a.mp3: unchanged']);
    });

    it('replaces unsynced lyrics (beets\') with synced ones, keeps synced lyrics unless forced, and fills an empty USLT', async () => {
      const beets = await mp3('beets.mp3', { unsynced: 'Plain words from beets' });
      const lrc = await mp3('lrc.mp3', { unsynced: '[00:05.00]Already synced' });
      const empty = await mp3('empty.mp3', { unsynced: '  ' });
      const provider = online('fake', () => [candidate(synced)]);
      const first = await run([beets, lrc, empty], { providers: [provider], write: true });
      expect(first.status).to.deep.equal(['beets.mp3: written', 'lrc.mp3: has lyrics', 'empty.mp3: written']);
      expect(first.reports[0].detail).to.include('replacing unsynced lyrics');
      expect(provider.asked).to.deep.equal(['Song', 'Song']);
      expect((await readLyricsTag(beets)).uslt?.text).to.equal(LRC);
      expect((await run([lrc], { providers: [provider], write: true, force: true })).status).to.deep.equal(['lrc.mp3: written']);
      expect((await readLyricsTag(lrc)).uslt?.text).to.equal(LRC);
    });

    it('keeps unsynced lyrics when only unsynced ones are found, unless forced', async () => {
      const beets = await mp3('beets.mp3', { unsynced: 'Plain words from beets' });
      const plain: Lyrics = { synced: false, instrumental: false, lines: [{ time: null, text: 'Other plain words' }] };
      const provider = online('fake', () => [candidate(plain)]);
      const kept = await run([beets], { providers: [provider], write: true, unsynced: true });
      expect(kept.status).to.deep.equal(['beets.mp3: has lyrics']);
      expect((await readLyricsTag(beets)).uslt?.text).to.equal('Plain words from beets');
      expect((await run([beets], { providers: [provider], write: true, unsynced: true, force: true })).status).to.deep.equal(['beets.mp3: written']);
    });

    it('skips instrumentals, writes unsynced lyrics only when asked, and says when nothing was found', async () => {
      const files = await Promise.all(['instrumental', 'plain', 'missing'].map(name => mp3(`${name}.mp3`, { title: name })));
      const unsynced: Lyrics = { synced: false, instrumental: false, lines: [{ time: null, text: 'Plain words' }] };
      const provider = online('fake', title => title === 'instrumental'
        ? [{ ...candidate({ synced: false, instrumental: true, lines: [] }), track: { artist: 'Artist', title } }]
        : title === 'plain' ? [{ ...candidate(unsynced), track: { artist: 'Artist', title } }] : []);
      const first = await run(files, { providers: [provider], write: true });
      expect(first.status).to.deep.equal(['instrumental.mp3: instrumental', 'plain.mp3: not found', 'missing.mp3: not found']);
      expect(first.reports[1].detail).to.include('--unsynced');
      expect((await run([files[1]], { providers: [provider], write: true, unsynced: true })).status).to.deep.equal(['plain.mp3: written']);
      expect((await readLyricsTag(files[1])).uslt?.text).to.equal('Plain words');
    });

    it('defers a file a provider failed for, waits out its pause, and clears it once answered', async () => {
      let clock = 0;
      const now = () => clock;
      const retries = new TagRetries(database, { now });
      const file = await mp3('a.mp3');
      let down = true;
      const provider = online('lrclib', () => down ? new Error('LRCLIB answered 503') : [candidate(synced)]);
      const deferred = await run([file], { providers: [provider], retries, now, write: true });
      expect(deferred.status).to.deep.equal(['a.mp3: deferred']);
      expect(retries.get((await readLyricsTag(file)).file)?.error).to.equal('lrclib: LRCLIB answered 503');

      down = false;
      expect((await run([file], { providers: [provider], retries, now, write: true })).status).to.deep.equal(['a.mp3: waiting']);
      expect(provider.asked).to.have.length(1);
      clock = RETRY_BACKOFF_MS[0] + 1;
      expect((await run([file], { providers: [provider], retries, now, write: true })).status).to.deep.equal(['a.mp3: written']);
      expect(retries.count()).to.equal(0);

      // --retry-now does not wait
      const other = await mp3('b.mp3');
      down = true;
      await run([other], { providers: [provider], retries, now, write: true });
      down = false;
      expect((await run([other], { providers: [provider], retries, now, write: true, retryNow: true })).status).to.deep.equal(['b.mp3: written']);
    });

    describe('lyrics that do not fit the file', () => {
      // The test mp3 plays about 3 seconds
      const at = (...times: number[]): Lyrics => ({ synced: true, instrumental: false, lines: times.map((time, index) => ({ time, text: `line ${index}` })) });
      const fake = (candidates: Candidate[]) => online('fake', () => candidates);

      it('are doubtful when their length is more than 4 seconds off, or they end too early or too late', async () => {
        const files = await Promise.all(['long', 'early', 'late', 'close'].map(name => mp3(`${name}.mp3`)));
        const answers: Record<string, Candidate> = {
          long: { ...candidate(synced), track: { artist: 'Artist', title: 'Song', durationMs: 9000 } },
          early: candidate(at(100, 200)),
          late: candidate(at(1000, 3500)),
          close: { ...candidate(synced), track: { artist: 'Artist', title: 'Song', durationMs: 6000 } }
        };
        const reports: string[] = [];
        for (const file of files) {
          const result = await run([file], { providers: [fake([answers[path.basename(file, '.mp3')]])] });
          reports.push(`${result.status[0]} ${result.reports[0].detail ?? ''}`);
        }
        expect(reports).to.deep.equal([
          'long.mp3: doubtful fake:1 is 6 s longer than the file',
          'early.mp3: doubtful fake:1 ends 7% of the way through',
          'late.mp3: doubtful fake:1 runs past the end of the file',
          'close.mp3: would write fake:1, synced, 2 lines'
        ]);
      });

      it('give way to the next lyrics that fit, and to the user\'s pick', async () => {
        const file = await mp3('a.mp3');
        // Ranked first (same score, more lines), but over in a fifth of a second
        const short = candidate(at(100, 150, 200), 'short');
        const provider = fake([short, candidate(synced, 'good')]);
        const first = await run([file], { providers: [provider] });
        expect(first.reports[0].detail).to.equal('fake:good, synced, 2 lines');
        const prefs = new TrackPrefs(database);
        prefs.setPick({ artist: 'Artist', title: 'Song', durationMs: 3056 }, short);
        const picked = await run([file], { providers: [provider], prefs });
        expect(picked.reports[0].detail).to.equal('fake:short, synced, 3 lines');
      });
    });

    it('holds lyrics from a later provider while an earlier one fails, and writes an earlier one\'s whatever a later one says', async () => {
      const retries = new TagRetries(database);
      const files = await Promise.all(['a', 'b'].map(name => mp3(`${name}.mp3`, { title: name })));
      const song = (title: string, provider: string): Candidate[] => [{ ...candidate(synced), provider, track: { artist: 'Artist', title } }];
      const first = online('first', title => title === 'a' ? new Error('busy') : song(title, 'first'));
      const second = online('second', title => title === 'b' ? new Error('busy') : song(title, 'second'));
      const result = await run(files, { providers: [first, second], retries, jobs: 1 });
      expect(result.status).to.deep.equal(['a.mp3: deferred', 'b.mp3: would write']);
      expect(result.reports[0].detail).to.match(/^first failed; second has lyrics, held until then; again after /);
      expect(result.reports[1].detail).to.equal('first:1, synced, 2 lines');
      // Instrumental by a later provider's word waits too
      const third = online('third', () => [{ ...candidate({ synced: false, instrumental: true, lines: [] }), provider: 'third', track: { artist: 'Artist', title: 'a' } }]);
      const held = await run([files[0]], { providers: [first, third], retryNow: true, retries });
      expect(held.status).to.deep.equal(['a.mp3: deferred']);
      expect(held.reports[0].detail).to.match(/third has it as instrumental, held until then/);
    });

    it('takes a later provider\'s lyrics once the file has waited a day and three tries for an earlier one', async () => {
      let clock = 0;
      const now = () => clock;
      const retries = new TagRetries(database, { now });
      const file = await mp3('a.mp3');
      const first = online('first', () => new Error('busy'));
      const second = online('second', () => [{ ...candidate(synced), provider: 'second' }]);
      const nobody = online('second', () => []);
      const options = { retries, now, retryNow: true, write: true };
      for (let attempt = 1; attempt <= FALLBACK_ATTEMPTS; attempt++) {
        expect((await run([file], { providers: [first, second], ...options })).status).to.deep.equal(['a.mp3: deferred']);
        clock += FALLBACK_AFTER_MS / 2;
      }
      // Nothing to take: still waiting for the first
      expect((await run([file], { providers: [first, nobody], ...options })).status).to.deep.equal(['a.mp3: deferred']);
      const result = await run([file], { providers: [first, second], ...options });
      expect(result.status).to.deep.equal(['a.mp3: written']);
      expect(result.reports[0].detail).to.match(/^second:1, synced, 2 lines; first failing since /);
      expect(retries.count()).to.equal(0);
    });

    describe('fallbacks', () => {
      const better: Lyrics = { synced: true, instrumental: false, lines: [{ time: 1000, text: 'Better' }, { time: 2500, text: 'Words' }] };
      const first = (answer: () => Candidate[] | Error) => online('first', answer);
      const from = (lyrics: Lyrics, provider: string) => ({ ...candidate(lyrics), provider });
      // A file written from second after first kept failing
      const fellBack = async (name: string) => {
        let clock = 0;
        const now = () => clock;
        const retries = new TagRetries(database, { now });
        const fallbacks = new TagFallbacks(database, { now });
        const file = await mp3(name);
        const busy = first(() => new Error('busy'));
        const second = online('second', () => [from(synced, 'second')]);
        const options = { retries, fallbacks, now, retryNow: true, write: true, providers: [busy, second] };
        for (let attempt = 1; attempt <= FALLBACK_ATTEMPTS; attempt++) {
          await run([file], options);
          clock += FALLBACK_AFTER_MS / 2;
        }
        expect((await run([file], options)).status).to.deep.equal([`${name}: written`]);
        return { file, fallbacks };
      };

      it('records only what a write gave up for', async () => {
        const { file, fallbacks } = await fellBack('a.mp3');
        expect(fallbacks.get(path.resolve(file))).to.deep.include({ provider: 'second', waitedFor: ['first'] });
        const plain = await mp3('b.mp3');
        await run([plain], { fallbacks, write: true, providers: [online('second', () => [from(synced, 'second')])] });
        expect(fallbacks.get(path.resolve(plain))).to.equal(null);
        expect(fallbacks.count()).to.equal(1);
      });

      it('replaces the lyrics with the waited-for provider\'s, previewing first, and asks only that provider', async () => {
        const { file, fallbacks } = await fellBack('a.mp3');
        const answered = first(() => [from(better, 'first')]);
        const second = online('second', () => [from(synced, 'second')]);
        const options = { fallbacks, recheck: true, providers: [answered, second] };
        const preview = await run([file], options);
        expect(preview.status).to.deep.equal(['a.mp3: would write']);
        expect((await readLyricsTag(file)).uslt?.text).to.equal(LRC);
        expect(fallbacks.count()).to.equal(1);
        const result = await run([file], { ...options, write: true });
        expect(result.status).to.deep.equal(['a.mp3: written']);
        expect(result.reports[0].detail).to.equal('first:1, synced, 2 lines, replacing second\'s lyrics');
        expect((await readLyricsTag(file)).uslt?.text).to.equal('[00:01.00]Better\n[00:02.50]Words');
        expect(second.asked).to.deep.equal([]);
        expect(fallbacks.count()).to.equal(0);
      });

      it('keeps the record when the provider fails again, and drops it when it has nothing that fits', async () => {
        const { file, fallbacks } = await fellBack('a.mp3');
        const options = { fallbacks, recheck: true, write: true };
        expect((await run([file], { ...options, providers: [first(() => new Error('busy'))] })).status).to.deep.equal(['a.mp3: deferred']);
        expect(fallbacks.count()).to.equal(1);
        const tooShort: Lyrics = { synced: true, instrumental: false, lines: [{ time: 100, text: 'Once' }] };
        const result = await run([file], { ...options, providers: [first(() => [from(tooShort, 'first')])] });
        expect(result.status).to.deep.equal(['a.mp3: has lyrics']);
        expect(result.reports[0].detail).to.equal('first has nothing that fits; second\'s lyrics stay');
        expect((await readLyricsTag(file)).uslt?.text).to.equal(LRC);
        expect(fallbacks.count()).to.equal(0);
      });

      it('leaves lyrics changed since alone, and a track picked or marked since', async () => {
        const changed = await fellBack('a.mp3');
        await writeLyricsTag(await readLyricsTag(changed.file), '[00:01.00]Mine');
        const asked = first(() => [from(better, 'first')]);
        const options = { fallbacks: changed.fallbacks, recheck: true, write: true, providers: [asked] };
        const result = await run([changed.file], options);
        expect(result.reports[0]).to.deep.include({ status: 'has lyrics', detail: 'changed since the fallback; left alone' });
        expect((await readLyricsTag(changed.file)).uslt?.text).to.equal('[00:01.00]Mine');

        const marked = await fellBack('b.mp3');
        const prefs = new TrackPrefs(database);
        prefs.setMark(await readQuery(marked.file), 'none');
        const second = await run([marked.file], { ...options, prefs });
        expect(second.reports[0]).to.deep.include({ status: 'has lyrics', detail: 'picked or marked since the fallback; left alone' });
        expect(asked.asked).to.deep.equal([]);
        expect(changed.fallbacks.count()).to.equal(0);
      });

      it('skips a file with no record, or when the provider is not among those asked', async () => {
        const { file, fallbacks } = await fellBack('a.mp3');
        const other = await mp3('b.mp3');
        const options = { fallbacks, recheck: true, write: true, providers: [online('second', () => [])] };
        const result = await run([file, other], options);
        expect(result.reports.map(report => report.detail)).to.deep.equal(['first not among the providers', 'no fallback recorded']);
        expect(fallbacks.count()).to.equal(1);
      });
    });

    it('writes nothing for a marked track, forced or not, and says so when the file still has lyrics', async () => {
      const prefs = new TrackPrefs(database);
      const empty = await mp3('a.mp3', { title: 'Empty' });
      const full = await mp3('b.mp3', { title: 'Full', unsynced: LRC });
      const silent = await mp3('c.mp3', { title: 'Silent' });
      prefs.setMark({ artist: 'Artist', title: 'Empty', durationMs: (await readQuery(empty)).durationMs }, 'none');
      prefs.setMark({ artist: 'Artist', title: 'Full', durationMs: (await readQuery(full)).durationMs }, 'none');
      prefs.setMark({ artist: 'Artist', title: 'Silent', durationMs: (await readQuery(silent)).durationMs }, 'instrumental');
      const asked = online('fake', () => [candidate(synced)]);
      const before = await readFile(full);
      const result = await run([empty, full, silent], { providers: [asked], prefs, write: true, force: true });
      expect(result.status).to.deep.equal(['a.mp3: not found', 'b.mp3: not found', 'c.mp3: instrumental']);
      expect(result.reports.map(report => report.detail)).to.deep.equal(['marked by you', 'marked by you; the file still has lyrics', 'marked by you']);
      expect(asked.asked).to.deep.equal([]);
      expect((await readFile(full)).equals(before)).to.equal(true);
      expect((await readLyricsTag(empty)).uslt).to.equal(null);
    });

    it('spaces requests to a service, not files, stops at the limit, and skips what it cannot tag', async () => {
      const files = await Promise.all(['a', 'b', 'c', 'd'].map(name => mp3(`${name}.mp3`, { title: name })));
      const pauses: number[] = [];
      const asked: string[] = [];
      const provider: Provider = {
        name: 'fake', local: false,
        async search(query, context) {
          asked.push(query.title);
          if (query.title !== 'b') await context.fetch('https://example.invalid/');
          return [{ ...candidate(synced), track: { artist: 'Artist', title: query.title } }];
        }
      };
      const fetch = (async () => new Response('')) as typeof globalThis.fetch;
      const result = await run(files, { providers: [provider], fetch, delayMs: 7, now: () => 0, sleep: async ms => { pauses.push(ms); }, limit: 3 });
      expect(result.status).to.deep.equal(['a.mp3: would write', 'b.mp3: would write', 'c.mp3: would write']);
      // a or c goes at once and the other waits its gap, b sends nothing; the limit leaves d unasked
      expect(pauses).to.deep.equal([7]);
      expect(asked).to.have.members(['a', 'b', 'c']);

      const text = path.join(dir, 'notes.txt');
      await writeFile(text, 'x');
      const damaged = path.join(dir, 'damaged.mp3');
      await writeFile(damaged, Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 3, 0, 0x80, 0, 0, 0, 0]), await readFile(SILENCE)]));
      const untitled = await writeTaggedMp3(path.join(dir, 'untitled.mp3'), {});
      const skipped = await run([text, damaged, untitled], { providers: [provider], fetch });
      expect(skipped.status).to.deep.equal(['notes.txt: skipped', 'damaged.mp3: skipped', 'untitled.mp3: skipped']);
      expect(skipped.reports[1].detail).to.equal('unsynchronised tag');
    });

    describe('with several files at once', () => {
      // A provider each lookup of which waits until the test lets it answer
      const held = () => {
        const waiting = new Map<string, () => void>();
        let underWay = 0;
        let most = 0;
        const provider: Provider & { release: (title: string) => void; most: () => number; waiting: () => string[] } = {
          name: 'fake', local: false,
          async search(query) {
            most = Math.max(most, ++underWay);
            await new Promise<void>(resolve => waiting.set(query.title, resolve));
            underWay--;
            return [{ ...candidate(synced), track: { artist: 'Artist', title: query.title } }];
          },
          release: title => { waiting.get(title)!(); waiting.delete(title); },
          most: () => most,
          waiting: () => [...waiting.keys()]
        };
        return provider;
      };
      // Until the lookups waiting are these (a moment more, to see that nothing else starts)
      const until = async (provider: ReturnType<typeof held>, titles: string[]) => {
        for (let tries = 0; tries < 200 && [...provider.waiting()].sort().join() !== [...titles].sort().join(); tries++) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(provider.waiting()).to.have.members(titles);
      };

      it('looks up as many files as jobs at once and reports them in the files\' order', async () => {
        const files = await Promise.all(['a', 'b', 'c', 'd'].map(name => mp3(`${name}.mp3`, { title: name })));
        const provider = held();
        const reports: string[] = [];
        const running = tagFiles(files, { providers: [provider], jobs: 3, sleep: async () => {}, onFile: report => reports.push(path.basename(report.file)) });
        await until(provider, ['a', 'b', 'c']);
        provider.release('c');
        provider.release('b');
        await until(provider, ['a', 'd']);
        // b and c are done, but wait for a
        expect(reports).to.deep.equal([]);
        provider.release('a');
        while (reports.length < 3) await new Promise(resolve => setTimeout(resolve, 5));
        expect(reports).to.deep.equal(['a.mp3', 'b.mp3', 'c.mp3']);
        provider.release('d');
        const counts = await running;
        expect(reports).to.deep.equal(['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3']);
        expect(counts['would write']).to.equal(4);
        expect(provider.most()).to.equal(3);
      });

      it('never goes over the limit, counting the files under way', async () => {
        const files = await Promise.all(['a', 'b', 'c'].map(name => mp3(`${name}.mp3`, { title: name })));
        const provider = held();
        const running = tagFiles(files, { providers: [provider], jobs: 3, limit: 2, sleep: async () => {} });
        await until(provider, ['a', 'b']);
        provider.release('a');
        provider.release('b');
        expect((await running)['would write']).to.equal(2);
      });

      it('starts nothing once stopped, and leaves out the lookups it cut short', async () => {
        const files = await Promise.all(['a', 'b', 'c'].map(name => mp3(`${name}.mp3`, { title: name })));
        const provider = held();
        const controller = new AbortController();
        const reports: TagReport[] = [];
        const running = tagFiles(files, { providers: [provider], jobs: 2, signal: controller.signal, write: true, sleep: async () => {}, onFile: report => reports.push(report) });
        await until(provider, ['a', 'b']);
        provider.release('a');
        await until(provider, ['b', 'c']);
        controller.abort();
        provider.release('b');
        provider.release('c');
        const counts = await running;
        // a was written before the stop; b and c are cut short (the run's signal ends their lookups)
        expect(reports.map(report => `${path.basename(report.file)}: ${report.status}`)).to.deep.equal(['a.mp3: written']);
        expect(counts.written).to.equal(1);
        expect((await readLyricsTag(files[1])).uslt).to.equal(null);
      });
    });

    it('lists mp3s under directories in name order, without hidden files or directories', async () => {
      await mkdir(path.join(dir, 'sub'));
      await mkdir(path.join(dir, '.musicman', 'trash'), { recursive: true });
      await Promise.all([mp3('b.mp3'), mp3('a.MP3'), mp3('sub/c.mp3'), mp3('.a.mp3.sleeve-1.tmp.mp3'), mp3('.musicman/trash/d.mp3')]);
      await writeFile(path.join(dir, 'cover.jpg'), '');
      expect((await listMp3s([dir])).map(file => path.relative(dir, file))).to.deep.equal(['a.MP3', 'b.mp3', path.join('sub', 'c.mp3')]);
      // Named outright, a hidden directory is gone through
      expect((await listMp3s([path.join(dir, '.musicman')])).map(file => path.relative(dir, file))).to.deep.equal([path.join('.musicman', 'trash', 'd.mp3')]);
      expect((await stat(dir)).isDirectory()).to.equal(true);
    });
  });
});
