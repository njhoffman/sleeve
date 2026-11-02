import { DURATION_WINDOW_MS, defaultDatabasePath, openShared, SleeveDatabase, trackKey, trackMatch } from './db.ts';
import type { Candidate, TrackQuery } from './types.ts';

// What online providers answered, so the same track is not fetched again: the candidates a provider returned
// for a track (or that it had none), kept per provider. Candidates are stored unscored, so a change to the
// scoring applies to cached answers too. Failures (timeouts, 503s) are never stored. Local providers are not
// cached: they are cheap and their files can change.
//
// A track is matched as db.ts defines (normalized names, a duration within DURATION_WINDOW_MS). Found answers
// are kept for FOUND_TTL_MS, "none" answers for NOT_FOUND_TTL_MS, after which the provider is asked again.

export { DURATION_WINDOW_MS, defaultDatabasePath };
export const FOUND_TTL_MS = 180 * 24 * 3600 * 1000;
export const NOT_FOUND_TTL_MS = 7 * 24 * 3600 * 1000;

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

interface Row {
  candidates: string;
  fetched_at: number;
  found: number;
}

export class LyricsCache {
  readonly file: string;
  private database: SleeveDatabase;
  private owned: boolean;
  private now: () => number;

  // A path opens (and close() closes) the database there, ':memory:' for one that lasts as long as the
  // object; a SleeveDatabase is shared with the other stores and left open
  constructor(source: string | SleeveDatabase = defaultDatabasePath(), { now = Date.now }: { now?: () => number } = {}) {
    ({ database: this.database, owned: this.owned } = openShared(source));
    this.file = this.database.file;
    this.now = now;
  }

  private get db() {
    return this.database.db;
  }

  // Rows for the same provider and track whose duration matches the query's, newest first
  private matching(provider: string, query: TrackQuery): Array<Row & { id: number }> {
    const { where, params } = trackMatch(trackKey(query));
    const sql = `SELECT id, candidates, fetched_at, found FROM answers WHERE provider = ? AND ${where} ORDER BY fetched_at DESC`;
    return this.db.prepare(sql).all(provider, ...params) as unknown as Array<Row & { id: number }>;
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
    const { artist, title, duration } = trackKey(query);
    const replaced = this.matching(provider, query).map(row => row.id);
    const remove = this.db.prepare('DELETE FROM answers WHERE id = ?');
    const insert = this.db.prepare('INSERT INTO answers (provider, artist_key, title_key, duration_ms, found, candidates, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.database.transaction(() => {
      for (const id of replaced) remove.run(id);
      insert.run(provider, artist, title, duration, candidates.length ? 1 : 0, JSON.stringify(candidates), this.now());
    });
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
    if (this.owned) this.database.close();
  }
}
