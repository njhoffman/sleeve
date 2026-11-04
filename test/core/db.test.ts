import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LyricsCache } from '../../src/core/cache.ts';
import { SCHEMA_VERSION, SleeveDatabase } from '../../src/core/db.ts';
import { TrackPrefs } from '../../src/core/prefs.ts';
import { TagRetries } from '../../src/core/retries.ts';

describe('SleeveDatabase', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'sleeve-db-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const query = { artist: 'Radiohead', title: 'Airbag', durationMs: 284_000 };

  it('upgrades a schema 1 database in place, keeping its answers', () => {
    const file = path.join(dir, 'sleeve.db');
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE answers (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, artist_key TEXT NOT NULL, title_key TEXT NOT NULL,
        duration_ms INTEGER, found INTEGER NOT NULL, candidates TEXT NOT NULL, fetched_at INTEGER NOT NULL);
      INSERT INTO answers (provider, artist_key, title_key, duration_ms, found, candidates, fetched_at)
        VALUES ('lrclib', 'radiohead', 'airbag', 284000, 0, '[]', ${Date.now()});
      PRAGMA user_version = 1;
    `);
    old.close();

    const database = new SleeveDatabase(file);
    const version = database.db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(version.user_version).to.equal(SCHEMA_VERSION);
    expect(new LyricsCache(database).get('lrclib', query)).to.deep.include({ candidates: [] });
    const prefs = new TrackPrefs(database);
    prefs.setOffset(query, 100, { provider: 'lrclib', id: '1', track: { artist: 'Radiohead', title: 'Airbag' }, lyrics: { synced: true, instrumental: false, lines: [] } });
    expect(prefs.get(query)?.offset?.ms).to.equal(100);
    database.close();
  });

  it('dates the deferred files of a schema 4 database from the upgrade', () => {
    const file = path.join(dir, 'sleeve.db');
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE tag_retries (path TEXT PRIMARY KEY, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, error TEXT NOT NULL);
      INSERT INTO tag_retries VALUES ('/a.mp3', 4, 5, 'lrclib: 503');
      CREATE TABLE track_prefs (id INTEGER PRIMARY KEY);
      PRAGMA user_version = 4;
    `);
    old.close();
    const before = Date.now() - 1000;
    const database = new SleeveDatabase(file);
    const retry = new TagRetries(database).get('/a.mp3')!;
    expect(retry).to.include({ attempts: 4, nextAt: 5, error: 'lrclib: 503' });
    expect(retry.firstAt).to.be.within(before, Date.now() + 1000);
    database.close();
  });

  it('refuses a database from a newer sleeve', () => {
    const file = path.join(dir, 'sleeve.db');
    const newer = new DatabaseSync(file);
    newer.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    newer.close();
    expect(() => new SleeveDatabase(file)).to.throw(`is from a newer sleeve (schema ${SCHEMA_VERSION + 1})`);
  });

  it('is shared by the stores and left open when they close', () => {
    const database = new SleeveDatabase(':memory:');
    const cache = new LyricsCache(database);
    const prefs = new TrackPrefs(database);
    cache.close();
    prefs.close();
    expect(cache.stats().answers).to.equal(0);
    expect(prefs.get(query)).to.equal(null);
    database.close();
  });
});
