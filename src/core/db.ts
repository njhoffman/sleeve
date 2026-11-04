import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeArtist, normalizeTitle } from './match.ts';
import type { TrackQuery } from './types.ts';

// sleeve's one database: online answers (cache.ts) and the user's per-track picks and timing offsets
// (prefs.ts) share it, and so do the files `sleeve tag` is to ask about again (retries.ts). This file opens it and
// owns the schema; each store keeps to its own tables.
//
// Schema 1: answers. Schema 2: track_prefs. Schema 3: isrc and spotify_id on both. Schema 4: tag_retries. Schema 6: track_prefs.mark. Schema 7: tag_fallbacks.

export const SCHEMA_VERSION = 7;

// A track is its normalized artist and title plus the duration asked with; rows match a query whose duration
// is within DURATION_WINDOW_MS of theirs, or when both have none. When the query carries IDs, a row with the
// same ISRC or Spotify id is the same track whatever its names and length (Spotify and the library file name a
// recording differently), and comes first; a row whose ISRC differs from the query's is a different recording
// even if the names match. Spotify ids do not rule a row out: one recording has several (album, single).
export const DURATION_WINDOW_MS = 2000;

export interface TrackKey {
  artist: string;
  title: string;
  duration: number | null;
  isrc: string | null;
  spotifyId: string | null;
}

// The columns a track row carries, for ranking the rows a query matches
export interface TrackRow {
  id: number;
  duration_ms: number | null;
  isrc: string | null;
  spotify_id: string | null;
}

// "US-RC1-76-07839" to "USRC17607839"; null for what is not an ISRC (country, registrant, year, designation)
export function normalizeIsrc(text: string | undefined): string | null {
  const isrc = (text ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc) ? isrc : null;
}

// A Spotify track id: 22 base-62 characters
export function normalizeSpotifyId(text: string | undefined): string | null {
  return text && /^[A-Za-z0-9]{22}$/.test(text) ? text : null;
}

export function trackKey(query: TrackQuery): TrackKey {
  return {
    artist: normalizeArtist(query.artist),
    title: normalizeTitle(query.title),
    duration: query.durationMs ?? null,
    isrc: normalizeIsrc(query.isrc),
    spotifyId: normalizeSpotifyId(query.spotifyId)
  };
}

// The WHERE clause and its parameters for rows of a table that belong to the track (rank them with rankRows)
export function trackMatch(key: TrackKey): { where: string; params: Array<string | number> } {
  const text = key.duration === null
    ? { where: 'artist_key = ? AND title_key = ? AND duration_ms IS NULL', params: [key.artist, key.title] as Array<string | number> }
    : { where: 'artist_key = ? AND title_key = ? AND duration_ms BETWEEN ? AND ?', params: [key.artist, key.title, key.duration - DURATION_WINDOW_MS, key.duration + DURATION_WINDOW_MS] };
  if (key.isrc) {
    text.where += ' AND (isrc IS NULL OR isrc = ?)';
    text.params.push(key.isrc);
  }
  const clauses = [`(${text.where})`];
  const params = [...text.params];
  if (key.isrc) {
    clauses.unshift('isrc = ?');
    params.unshift(key.isrc);
  }
  if (key.spotifyId) {
    clauses.splice(key.isrc ? 1 : 0, 0, 'spotify_id = ?');
    params.splice(key.isrc ? 1 : 0, 0, key.spotifyId);
  }
  return { where: clauses.length > 1 ? `(${clauses.join(' OR ')})` : clauses[0], params };
}

// How a row matched: 0 by ISRC, 1 by Spotify id, 2 by names and length
export function matchedBy(row: TrackRow, key: TrackKey): number {
  if (key.isrc && row.isrc === key.isrc) return 0;
  if (key.spotifyId && row.spotify_id === key.spotifyId) return 1;
  return 2;
}

// Rows a query matched, best first: by ID before by text, then the closest duration (a stable sort keeps the
// caller's order among equals)
export function rankRows<T extends TrackRow>(rows: T[], key: TrackKey): T[] {
  const wanted = key.duration ?? 0;
  return [...rows].sort((a, b) => matchedBy(a, key) - matchedBy(b, key)
    || Math.abs((a.duration_ms ?? 0) - wanted) - Math.abs((b.duration_ms ?? 0) - wanted));
}

// Fills in the IDs a row lacks from the query that matched it, so a row stored by names alone (everything
// before schema 3) is found by ID from then on
export function rememberIds(database: SleeveDatabase, table: 'answers' | 'track_prefs', row: TrackRow, key: TrackKey): void {
  const isrc = !row.isrc && key.isrc ? key.isrc : null;
  const spotifyId = !row.spotify_id && key.spotifyId ? key.spotifyId : null;
  if (!isrc && !spotifyId) return;
  database.db.prepare(`UPDATE ${table} SET isrc = COALESCE(isrc, ?), spotify_id = COALESCE(spotify_id, ?) WHERE id = ?`).run(isrc, spotifyId, row.id);
}

// $XDG_DATA_HOME/sleeve/sleeve.db: data, not cache, since it holds the user's picks and timing offsets
export function defaultDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'sleeve', 'sleeve.db');
}

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE answers (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      artist_key TEXT NOT NULL,
      title_key TEXT NOT NULL,
      duration_ms INTEGER,
      found INTEGER NOT NULL,
      candidates TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE INDEX answers_track ON answers (provider, artist_key, title_key);
  `,
  2: `
    CREATE TABLE track_prefs (
      id INTEGER PRIMARY KEY,
      artist_key TEXT NOT NULL,
      title_key TEXT NOT NULL,
      duration_ms INTEGER,
      pick_provider TEXT,
      pick_id TEXT,
      pick_candidate TEXT,
      offset_ms INTEGER,
      offset_provider TEXT,
      offset_id TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX track_prefs_track ON track_prefs (artist_key, title_key);
  `,
  3: `
    ALTER TABLE answers ADD COLUMN isrc TEXT;
    ALTER TABLE answers ADD COLUMN spotify_id TEXT;
    ALTER TABLE track_prefs ADD COLUMN isrc TEXT;
    ALTER TABLE track_prefs ADD COLUMN spotify_id TEXT;
    CREATE INDEX answers_isrc ON answers (provider, isrc);
    CREATE INDEX answers_spotify ON answers (provider, spotify_id);
    CREATE INDEX track_prefs_isrc ON track_prefs (isrc);
    CREATE INDEX track_prefs_spotify ON track_prefs (spotify_id);
  `,
  4: `
    CREATE TABLE tag_retries (
      path TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL,
      next_at INTEGER NOT NULL,
      error TEXT NOT NULL
    );
  `,
  // When each file was first deferred; files deferred before are counted from the upgrade
  5: `
    ALTER TABLE tag_retries ADD COLUMN first_at INTEGER NOT NULL DEFAULT 0;
    UPDATE tag_retries SET first_at = unixepoch('now') * 1000;
  `,
  6: `
    ALTER TABLE track_prefs ADD COLUMN mark TEXT;
  `,
  7: `
    CREATE TABLE tag_fallbacks (
      path TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      waited_for TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      written_at INTEGER NOT NULL
    );
  `
};

export class SleeveDatabase {
  readonly file: string;
  readonly db: DatabaseSync;

  // file ':memory:' for a database that lasts as long as the object (tests)
  constructor(file: string = defaultDatabasePath()) {
    this.file = file;
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  private migrate(): void {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version > SCHEMA_VERSION) throw new Error(`${this.file} is from a newer sleeve (schema ${version}); upgrade sleeve`);
    for (let next = version + 1; next <= SCHEMA_VERSION; next++) {
      this.transaction(() => this.db.exec(`${MIGRATIONS[next]}\nPRAGMA user_version = ${next};`));
    }
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

// A store opened on a path owns its database and closes it; one handed a SleeveDatabase shares it
export function openShared(source: string | SleeveDatabase): { database: SleeveDatabase; owned: boolean } {
  return typeof source === 'string' ? { database: new SleeveDatabase(source), owned: true } : { database: source, owned: false };
}
