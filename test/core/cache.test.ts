import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultDatabasePath, FOUND_TTL_MS, LyricsCache, NOT_FOUND_TTL_MS } from '../../src/core/cache.ts';
import type { Candidate } from '../../src/core/types.ts';

const candidate: Candidate = {
  provider: 'lrclib', id: '1', track: { artist: 'Radiohead', title: 'Airbag', durationMs: 284_000 },
  lyrics: { synced: true, instrumental: false, lines: [{ time: 1000, text: 'In the next world war' }] }
};

describe('LyricsCache', () => {
  let time: number, cache: LyricsCache;
  beforeEach(() => {
    time = 1_000_000;
    cache = new LyricsCache(':memory:', { now: () => time });
  });
  afterEach(() => cache.close());

  const query = { artist: 'Radiohead', title: 'Airbag', durationMs: 284_400 };

  it('returns a stored answer for the same track: normalized names, a duration within 2 seconds', () => {
    cache.put('lrclib', query, [candidate]);
    expect(cache.get('lrclib', { artist: 'radiohead', title: 'Airbag (Remastered)', durationMs: 286_000 })).to.deep.equal({ candidates: [candidate], fetchedAt: 1_000_000 });
    expect(cache.get('lrclib', { ...query, durationMs: 287_000 })).to.equal(null);
    expect(cache.get('lrclib', { artist: 'Radiohead', title: 'Airbag' })).to.equal(null);
    expect(cache.get('other', query)).to.equal(null);
  });

  it('keeps durationless answers apart from timed ones', () => {
    cache.put('lrclib', { artist: 'Radiohead', title: 'Airbag' }, [candidate]);
    expect(cache.get('lrclib', { artist: 'Radiohead', title: 'Airbag' })?.candidates).to.have.length(1);
    expect(cache.get('lrclib', query)).to.equal(null);
  });

  it('expires "none" answers after a week and found ones after half a year', () => {
    cache.put('lrclib', query, []);
    cache.put('other', query, [candidate]);
    time += NOT_FOUND_TTL_MS;
    expect(cache.get('lrclib', query)).to.deep.equal({ candidates: [], fetchedAt: 1_000_000 });
    time += 1;
    expect(cache.get('lrclib', query)).to.equal(null);
    expect(cache.get('other', query)).to.not.equal(null);
    time = 1_000_000 + FOUND_TTL_MS + 1;
    expect(cache.get('other', query)).to.equal(null);
  });

  it('replaces an earlier answer for the same track', () => {
    cache.put('lrclib', query, []);
    time += 10;
    cache.put('lrclib', { ...query, durationMs: 284_000 }, [candidate]);
    expect(cache.get('lrclib', query)?.candidates).to.deep.equal([candidate]);
    expect(cache.stats().answers).to.equal(1);
  });

  it('counts and clears answers, by provider or only those without lyrics', () => {
    cache.put('lrclib', query, [candidate]);
    cache.put('lrclib', { ...query, title: 'Lucky' }, []);
    cache.put('netease', query, []);
    expect(cache.stats()).to.deep.equal({
      file: ':memory:', answers: 3, found: 1, notFound: 2,
      byProvider: { lrclib: { found: 1, notFound: 1 }, netease: { found: 0, notFound: 1 } }
    });
    expect(cache.clear({ provider: 'lrclib', notFoundOnly: true })).to.equal(1);
    expect(cache.clear({ notFoundOnly: true })).to.equal(1);
    expect(cache.clear()).to.equal(1);
    expect(cache.stats().answers).to.equal(0);
  });

  it('lives in $XDG_DATA_HOME/sleeve and creates its directory, keeping answers across opens', async () => {
    expect(defaultDatabasePath({ XDG_DATA_HOME: '/x' })).to.equal('/x/sleeve/sleeve.db');
    expect(defaultDatabasePath({ HOME: os.homedir() })).to.equal(path.join(os.homedir(), '.local/share/sleeve/sleeve.db'));
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sleeve-cache-'));
    try {
      const file = path.join(dir, 'nested', 'sleeve.db');
      const first = new LyricsCache(file);
      first.put('lrclib', query, [candidate]);
      first.close();
      const second = new LyricsCache(file);
      expect(second.get('lrclib', query)?.candidates).to.deep.equal([candidate]);
      second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
