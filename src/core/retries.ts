import { defaultDatabasePath, openShared, SleeveDatabase } from './db.ts';

// The files `sleeve tag` found no lyrics for because a provider failed (LRCLIB answers 503 for minutes when it is
// overloaded), with when to ask about each again: later and later, so a run over the library skips them and
// comes back instead of hammering a provider that is down. A file is forgotten once it is tagged, or once every
// provider answered about it.

// The pause after each failure in a row; the last one repeats
export const RETRY_BACKOFF_MS = [10 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];

export interface TagRetry {
  attempts: number;
  nextAt: number;
  error: string;
}

export class TagRetries {
  readonly file: string;
  private database: SleeveDatabase;
  private owned: boolean;
  private now: () => number;

  // As LyricsCache: a path opens and owns the database, a SleeveDatabase is shared
  constructor(source: string | SleeveDatabase = defaultDatabasePath(), { now = Date.now }: { now?: () => number } = {}) {
    ({ database: this.database, owned: this.owned } = openShared(source));
    this.file = this.database.file;
    this.now = now;
  }

  get(path: string): TagRetry | null {
    const row = this.database.db.prepare('SELECT attempts, next_at, error FROM tag_retries WHERE path = ?').get(path) as
      { attempts: number; next_at: number; error: string } | undefined;
    return row ? { attempts: row.attempts, nextAt: row.next_at, error: row.error } : null;
  }

  // Records another failure for the file; when to ask again
  defer(path: string, error: string): TagRetry {
    const attempts = (this.get(path)?.attempts ?? 0) + 1;
    const nextAt = this.now() + RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length) - 1];
    this.database.db.prepare(`
      INSERT INTO tag_retries (path, attempts, next_at, error) VALUES (?, ?, ?, ?)
      ON CONFLICT (path) DO UPDATE SET attempts = excluded.attempts, next_at = excluded.next_at, error = excluded.error
    `).run(path, attempts, nextAt, error);
    return { attempts, nextAt, error };
  }

  clear(path: string): void {
    this.database.db.prepare('DELETE FROM tag_retries WHERE path = ?').run(path);
  }

  count(): number {
    return (this.database.db.prepare('SELECT COUNT(*) AS count FROM tag_retries').get() as { count: number }).count;
  }

  close(): void {
    if (this.owned) this.database.close();
  }
}
