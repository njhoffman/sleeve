import { expect } from 'chai';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { embedded, sidecar, sidecarPath } from '../../src/core/providers/local.ts';
import type { ProviderContext } from '../../src/core/providers/provider.ts';
import type { FileTags } from '../../src/core/tags/reader.ts';

describe('local providers', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'sleeve-local-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const context = (tags: Partial<FileTags>): ProviderContext => ({
    fetch: (async () => { throw new Error('no network'); }) as typeof fetch,
    signal: new AbortController().signal, userAgent: 'test',
    tags: { read: async () => ({ lyrics: [], ...tags }) }
  });
  const query = (file: string) => ({ artist: 'A', title: 'T', durationMs: 3000, path: file });

  it('reads the .lrc next to the file as an exact candidate', async () => {
    const song = path.join(dir, '01 - Song.mp3');
    expect(sidecarPath(song)).to.equal(path.join(dir, '01 - Song.lrc'));
    await writeFile(path.join(dir, '01 - Song.lrc'), '[ti:T]\n[00:01.00]Hello\n');
    const [candidate] = await sidecar.search(query(song), context({}));
    expect(candidate).to.deep.include({ provider: 'sidecar', exact: true, track: { artist: 'A', title: 'T', durationMs: 3000 } });
    expect(candidate.lyrics.lines).to.deep.equal([{ time: 1000, text: 'Hello' }]);
  });

  it('has nothing without a path or without the .lrc', async () => {
    expect(await sidecar.search({ artist: 'A', title: 'T' }, context({}))).to.deep.equal([]);
    expect(await sidecar.search(query(path.join(dir, 'missing.mp3')), context({}))).to.deep.equal([]);
  });

  it('reads lyrics from the file\'s tags: SYLT as synced, LRC in USLT as synced, plain USLT as unsynced', async () => {
    const candidates = await embedded.search(query(path.join(dir, 'x.mp3')), context({
      lyrics: [
        { frame: 'SYLT', synced: true, text: '', lines: [{ time: 500, text: 'Synced' }] },
        { frame: 'USLT', synced: false, text: '[00:02.00]From LRC', lines: [] },
        { frame: 'USLT', synced: false, text: 'Plain one\n\nPlain two', lines: [] }
      ]
    }));
    expect(candidates.map(item => [item.lyrics.synced, item.lyrics.lines.map(line => line.text)])).to.deep.equal([
      [true, ['Synced']], [true, ['From LRC']], [false, ['Plain one', 'Plain two']]
    ]);
    expect(candidates.every(item => item.exact)).to.equal(true);
  });
});
