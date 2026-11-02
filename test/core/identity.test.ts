import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LyricsCache } from '../../src/core/cache.ts';
import { normalizeIsrc, normalizeSpotifyId, SCHEMA_VERSION, SleeveDatabase } from '../../src/core/db.ts';
import { TrackPrefs } from '../../src/core/prefs.ts';
import type { Candidate, TrackQuery } from '../../src/core/types.ts';

// The same recording as the library file names it and as Spotify does
const fromFile: TrackQuery = { artist: 'Télépopmusik', title: 'Breathe (Kartell Slow Remix)', durationMs: 203_100, isrc: 'FR-6V8-05-00123', spotifyId: '7rHmT1Ks5CPA2xEWpGQ19T' };
const fromSpotify: TrackQuery = { artist: 'Telepopmusik', title: 'Breathe - Kartell Slow Remix Edit', durationMs: 207_900, spotifyId: '7rHmT1Ks5CPA2xEWpGQ19T' };
const candidate = (id: string): Candidate => ({ provider: 'lrclib', id, track: { artist: 'A', title: 'T' }, lyrics: { synced: true, instrumental: false, lines: [] } });

describe('track identity by ID', () => {
  let database: SleeveDatabase, prefs: TrackPrefs, cache: LyricsCache;
  beforeEach(() => {
    database = new SleeveDatabase(':memory:');
    prefs = new TrackPrefs(database);
    cache = new LyricsCache(database);
  });
  afterEach(() => database.close());

  it('normalizes ISRCs and Spotify ids, ignoring what is not one', () => {
    expect(normalizeIsrc('fr-6v8-05-00123')).to.equal('FR6V80500123');
    expect(normalizeIsrc(' GBAYE9701374 ')).to.equal('GBAYE9701374');
    for (const bad of [undefined, '', '0', 'GBAYE970137', 'GBAYE97013745', '12AYE9701374']) expect(normalizeIsrc(bad), String(bad)).to.equal(null);
    expect(normalizeSpotifyId('2fuYa3Lx06QQJAm0MjztKr')).to.equal('2fuYa3Lx06QQJAm0MjztKr');
    expect(normalizeSpotifyId('spotify:track:2fuYa3Lx06QQJAm0MjztKr')).to.equal(null);
  });

  it('finds a pick and an offset made for the file when Spotify plays the recording under other names', () => {
    prefs.setPick(fromFile, candidate('1'));
    prefs.setOffset(fromFile, -250, candidate('1'));
    expect(prefs.get(fromSpotify)).to.deep.include({ offset: { ms: -250, provider: 'lrclib', id: '1' } });
    // By ISRC alone too, whatever the names and length
    expect(prefs.get({ artist: 'X', title: 'Y', durationMs: 10_000, isrc: 'FR6V80500123' })!.pick!.id).to.equal('1');
    expect(prefs.get({ artist: 'X', title: 'Y', durationMs: 10_000 })).to.equal(null);
  });

  it('tells recordings with the same names apart by ISRC', () => {
    prefs.setOffset(fromFile, 300, candidate('1'));
    const live = { ...fromFile, isrc: 'USABC0000001', spotifyId: undefined };
    expect(prefs.get(live)).to.equal(null);
    prefs.setOffset(live, -900, candidate('2'));
    expect(prefs.get(fromFile)!.offset!.ms).to.equal(300);
    expect(prefs.get(live)!.offset!.ms).to.equal(-900);
    // A query without an ISRC still finds one by names
    expect(prefs.get({ artist: fromFile.artist, title: fromFile.title, durationMs: fromFile.durationMs })).to.not.equal(null);
  });

  it('prefers a row matched by ID to a closer one matched by names', () => {
    prefs.setOffset({ ...fromFile, isrc: undefined, spotifyId: undefined, durationMs: 203_000 }, 111, candidate('1'));
    prefs.setOffset({ artist: 'Other', title: 'Name', durationMs: 50_000, spotifyId: fromFile.spotifyId }, 222, candidate('1'));
    // Names and length point at the first row, the Spotify id at the second
    expect(prefs.get({ ...fromFile, isrc: undefined, durationMs: 203_000 })!.offset!.ms).to.equal(222);
  });

  it('gives rows stored by names the IDs of the query that finds them, so they match by ID from then on', () => {
    const byName = { artist: fromFile.artist, title: fromFile.title, durationMs: fromFile.durationMs };
    prefs.setPick(byName, candidate('1'));
    expect(prefs.get(fromSpotify)).to.equal(null);
    expect(prefs.get(fromFile)!.pick!.id).to.equal('1');
    const row = database.db.prepare('SELECT isrc, spotify_id FROM track_prefs').get();
    expect(row).to.deep.equal({ isrc: 'FR6V80500123', spotify_id: '7rHmT1Ks5CPA2xEWpGQ19T' });
    expect(prefs.get(fromSpotify)!.pick!.id).to.equal('1');
  });

  it('shares stored answers the same way, and replaces them by ID', () => {
    cache.put('lrclib', fromFile, [candidate('1')]);
    expect(cache.get('lrclib', fromSpotify)!.candidates[0].id).to.equal('1');
    cache.put('lrclib', fromSpotify, [candidate('2')]);
    expect(cache.stats().answers).to.equal(1);
    expect(cache.get('lrclib', fromFile)!.candidates[0].id).to.equal('2');
    expect(cache.get('netease', fromFile)).to.equal(null);
  });
});

describe('schema 3', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'sleeve-schema3-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('upgrades a schema 2 database, keeping picks and offsets and adding IDs as they are seen', () => {
    const file = path.join(dir, 'sleeve.db');
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE answers (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, artist_key TEXT NOT NULL, title_key TEXT NOT NULL,
        duration_ms INTEGER, found INTEGER NOT NULL, candidates TEXT NOT NULL, fetched_at INTEGER NOT NULL);
      CREATE TABLE track_prefs (id INTEGER PRIMARY KEY, artist_key TEXT NOT NULL, title_key TEXT NOT NULL, duration_ms INTEGER,
        pick_provider TEXT, pick_id TEXT, pick_candidate TEXT, offset_ms INTEGER, offset_provider TEXT, offset_id TEXT, updated_at INTEGER NOT NULL);
      INSERT INTO track_prefs (artist_key, title_key, duration_ms, offset_ms, offset_provider, offset_id, updated_at)
        VALUES ('radiohead', 'airbag', 284000, 150, 'lrclib', '9', 1);
      PRAGMA user_version = 2;
    `);
    old.close();
    const database = new SleeveDatabase(file);
    expect((database.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).to.equal(SCHEMA_VERSION);
    const prefs = new TrackPrefs(database);
    const airbag = { artist: 'Radiohead', title: 'Airbag', durationMs: 284_500, isrc: 'GBAYE9701374' };
    expect(prefs.get(airbag)!.offset).to.deep.equal({ ms: 150, provider: 'lrclib', id: '9' });
    expect(prefs.get({ artist: 'Radiohead', title: 'Airbag (Remastered)', durationMs: 290_000, isrc: 'GBAYE9701374' })!.offset!.ms).to.equal(150);
    database.close();
  });
});
