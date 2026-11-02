import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeArtist, normalizeTitle } from './match.ts';
import type { TrackQuery } from './types.ts';

// sleeve's one database: online answers (cache.ts) and the user's per-track picks and timing offsets
// (prefs.ts) share it. This file opens it and owns the schema; each store keeps to its own tables.
//
// Schema 1: answers. Schema 2: track_prefs.

export const SCHEMA_VERSION = 2;

// A track is its normalized artist and title plus the duration asked with; rows match a query whose duration
// is within DURATION_WINDOW_MS of theirs, or when both have none
export const DURATION_WINDOW_MS = 2000;

export interface TrackKey {
  artist: string;
  title: string;
  duration: number | null;
}

export function trackKey(query: TrackQuery): TrackKey {
  return { artist: normalizeArtist(query.artist), title: normalizeTitle(query.title), duration: query.durationMs ?? null };
}

// The WHERE clause and its parameters for rows of a table that belong to the track
export function trackMatch(key: TrackKey): { where: string; params: Array<string | number> } {
  return key.duration === null
    ? { where: 'artist_key = ? AND title_key = ? AND duration_ms IS NULL', params: [key.artist, key.title] }
    : { where: 'artist_key = ? AND title_key = ? AND duration_ms BETWEEN ? AND ?', params: [key.artist, key.title, key.duration - DURATION_WINDOW_MS, key.duration + DURATION_WINDOW_MS] };
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
