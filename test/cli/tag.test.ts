import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Io } from '../../src/cli/lyrics.ts';
import { forBatch, tagCommand } from '../../src/cli/tag.ts';
import { SleeveDatabase } from '../../src/core/db.ts';
import { DEFAULT_PROVIDERS } from '../../src/core/fetchLyrics.ts';
import type { ProviderContext } from '../../src/core/providers/provider.ts';
import { musicMetadataReader } from '../../src/core/tags/musicMetadata.ts';
import { TagFallbacks } from '../../src/core/retries.ts';
import { readLyricsTag } from '../../src/core/tags/lyricsTag.ts';
import { fakeFetch, fixture } from '../helpers/fetch.ts';
import { writeTaggedMp3 } from '../helpers/id3.ts';

describe('sleeve tag providers', () => {
  it('asks LRCLIB once when it is overloaded, leaving the retry to a later run, and keeps the other providers', async () => {
    const providers = forBatch(DEFAULT_PROVIDERS);
    expect(providers.map(provider => provider.name)).to.deep.equal(DEFAULT_PROVIDERS.map(provider => provider.name));
    expect(providers.filter(provider => provider.name !== 'lrclib')).to.deep.equal(DEFAULT_PROVIDERS.filter(provider => provider.name !== 'lrclib'));

    const fake = fakeFetch([{ match: /\/api\/get\?/, status: 503, body: fixture('lrclib/overloaded.json') }]);
    const context: ProviderContext = { fetch: fake.fetch, signal: AbortSignal.timeout(5000), userAgent: 'test', tags: musicMetadataReader };
    const lrclib = providers.find(provider => provider.name === 'lrclib')!;
    let error: Error | null = null;
    await lrclib.search({ artist: 'Artist', title: 'Song', durationMs: 200_000 }, context).catch(caught => { error = caught; });
    expect(error!.message).to.include('503');
    expect(fake.calls).to.have.length(1);
  });

  it('keeps LRCLIB\'s rate limit on the batch provider: one request at a time, 700 ms apart', () => {
    expect(forBatch(DEFAULT_PROVIDERS).find(provider => provider.name === 'lrclib')!.rateLimit).to.deep.equal({ host: 'lrclib.net', gapMs: 700, serial: true });
  });
});

describe('sleeve tag --recheck-fallbacks', () => {
  let dir: string, database: SleeveDatabase, fallbacks: TagFallbacks, out: string[], err: string[], io: Io;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sleeve-recheck-'));
    database = new SleeveDatabase(':memory:');
    fallbacks = new TagFallbacks(database);
    out = []; err = [];
    io = { out: text => out.push(text), err: text => err.push(text) };
  });
  afterEach(async () => {
    database.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('goes only through the files with a record, and says so when there are none', async () => {
    const recorded = await writeTaggedMp3(path.join(dir, 'a.mp3'), { artist: 'A', title: 'T', unsynced: '[00:01.00]Old' });
    await writeTaggedMp3(path.join(dir, 'b.mp3'), { artist: 'A', title: 'U' });
    const options = { recheckFallbacks: true, write: true, verbose: true, cache: false, prefs: false, providers: 'lrclib' };
    const given = { fallbacks, fetch: fakeFetch([]).fetch };
    expect(await tagCommand([dir], options, io, given)).to.equal(0);
    expect(err.at(-1)).to.equal('no fallbacks recorded here');
    expect(out).to.deep.equal([]);

    fallbacks.record(path.resolve(recorded), 'netease', ['lrclib'], 'something else');
    expect(await tagCommand([dir], options, io, given)).to.equal(0);
    expect(out).to.deep.equal(['has lyrics   a.mp3  (changed since the fallback; left alone)']);
    expect((await readLyricsTag(recorded)).uslt?.text).to.equal('[00:01.00]Old');
    expect(fallbacks.count()).to.equal(0);
  });

  it('refuses --force with it', async () => {
    await tagCommand([dir], { recheckFallbacks: true, force: true }, io, { fallbacks }).then(() => expect.fail('ran'), error => {
      expect(error.message).to.equal('Give --recheck-fallbacks or --force, not both');
    });
  });
});
