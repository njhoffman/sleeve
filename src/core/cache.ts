import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeArtist, normalizeTitle } from './match.ts';
import type { Candidate, TrackQuery } from './types.ts';

// What online providers answered, so the same track is not fetched again: the candidates a provider returned
// for a track (or that it had none), kept per provider. Candidates are stored unscored, so a change to the
// scoring applies to cached answers too. Failures (timeouts, 503s) are never stored. Local providers are not
// cached: they are cheap and their files can change.
//
// A track is its normalized artist and title plus the duration asked with: an answer is reused for a query
// whose duration is within DURATION_WINDOW_MS of it, or when both have none. Found answers are kept for
// FOUND_TTL_MS, "none" answers for NOT_FOUND_TTL_MS, after which the provider is asked again.

export const DURATION_WINDOW_MS = 2000;
export const FOUND_TTL_MS = 180 * 24 * 3600 * 1000;
export const NOT_FOUND_TTL_MS = 7 * 24 * 3600 * 1000;

const SCHEMA_VERSION = 1;

export interface CachedAnswer {
  candidates: Candidate[];
  fetchedAt: number;
}

export interface CacheStats {
  file: string;
  answers: number;
  found: number;
  notFound: number;
  byProvider: Record<string, { found: number; notFound: number }>;
}

export interface ClearOptions {
  provider?: string;
  // Only the "none" answers, so those tracks are asked again
  notFoundOnly?: boolean;
}

// $XDG_DATA_HOME/sleeve/sleeve.db: data, not cache, since the same database will hold the user's picks and
// timing offsets
export function defaultDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'sleeve', 'sleeve.db');
}

interface Row {
  candidates: string;
  fetched_at: number;
  found: number;
}

export class LyricsCache {
  readonly file: string;
  private db: DatabaseSync;
  private now: () => number;

  // file ':memory:' for a cache that lasts as long as the object (tests)
  constructor(file: string = defaultDatabasePath(), { now = Date.now }: { now?: () => number } = {}) {
    this.file = file;
    this.now = now;
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  private migrate(): void {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version > SCHEMA_VERSION) throw new Error(`${this.file} is from a newer sleeve (schema ${version}); upgrade sleeve`);
    if (version < 1) {
      this.db.exec(`
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
        PRAGMA user_version = 1;
      `);
    }
  }

  private keys(query: TrackQuery) {
    return { artist: normalizeArtist(query.artist), title: normalizeTitle(query.title), duration: query.durationMs ?? null };
  }

  // Rows for the same provider and track whose duration matches the query's, newest first
  private matching(provider: string, query: TrackQuery): Array<Row & { id: number }> {
    const { artist, title, duration } = this.keys(query);
    const sql = duration === null
      ? 'SELECT id, candidates, fetched_at, found FROM answers WHERE provider = ? AND artist_key = ? AND title_key = ? AND duration_ms IS NULL ORDER BY fetched_at DESC'
      : 'SELECT id, candidates, fetched_at, found FROM answers WHERE provider = ? AND artist_key = ? AND title_key = ? AND duration_ms BETWEEN ? AND ? ORDER BY fetched_at DESC';
    const params = duration === null ? [provider, artist, title] : [provider, artist, title, duration - DURATION_WINDOW_MS, duration + DURATION_WINDOW_MS];
    return this.db.prepare(sql).all(...params) as unknown as Array<Row & { id: number }>;
  }

  // The provider's stored answer for the track, or null when there is none or it is too old
  get(provider: string, query: TrackQuery): CachedAnswer | null {
    const [row] = this.matching(provider, query);
    if (!row) return null;
    const ttl = row.found ? FOUND_TTL_MS : NOT_FOUND_TTL_MS;
    if (this.now() - row.fetched_at > ttl) return null;
    return { candidates: JSON.parse(row.candidates) as Candidate[], fetchedAt: row.fetched_at };
  }

  // Stores what the provider answered, replacing what it answered before for the same track
  put(provider: string, query: TrackQuery, candidates: Candidate[]): void {
    const { artist, title, duration } = this.keys(query);
    const replaced = this.matching(provider, query).map(row => row.id);
    const remove = this.db.prepare('DELETE FROM answers WHERE id = ?');
    const insert = this.db.prepare('INSERT INTO answers (provider, artist_key, title_key, duration_ms, found, candidates, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const id of replaced) remove.run(id);
      insert.run(provider, artist, title, duration, candidates.length ? 1 : 0, JSON.stringify(candidates), this.now());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  stats(): CacheStats {
    const rows = this.db.prepare('SELECT provider, found, COUNT(*) AS count FROM answers GROUP BY provider, found').all() as Array<{ provider: string; found: number; count: number }>;
    const byProvider: CacheStats['byProvider'] = {};
    let found = 0;
    let notFound = 0;
    for (const row of rows) {
      byProvider[row.provider] ??= { found: 0, notFound: 0 };
      if (row.found) {
        byProvider[row.provider].found += row.count;
        found += row.count;
      } else {
        byProvider[row.provider].notFound += row.count;
        notFound += row.count;
      }
    }
    return { file: this.file, answers: found + notFound, found, notFound, byProvider };
  }

  // Removes stored answers; returns how many
  clear({ provider, notFoundOnly = false }: ClearOptions = {}): number {
    const conditions = [...(provider ? ['provider = ?'] : []), ...(notFoundOnly ? ['found = 0'] : [])];
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const result = this.db.prepare(`DELETE FROM answers${where}`).run(...(provider ? [provider] : []));
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}
