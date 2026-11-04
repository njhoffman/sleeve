import { createHash } from 'node:crypto';
import { defaultDatabasePath, openShared, SleeveDatabase } from './db.ts';

// The files `sleeve tag` found no lyrics for because a provider failed (LRCLIB answers 503 for minutes when it is
// overloaded), with when to ask about each again: later and later, so a run over the library skips them and
// comes back instead of hammering a provider that is down. A file is forgotten once it is tagged, or once every
// provider answered about it.
//
// A file whose lyrics a later provider has waits for an earlier one that fails (src/core/tagger.ts), but not
// forever: once it was first deferred at least FALLBACK_AFTER_MS ago and has failed FALLBACK_ATTEMPTS times, the
// later provider's answer is taken (gaveUp). Both, since --retry-now runs pile up attempts within a night.

// The pause after each failure in a row; the last one repeats
export const RETRY_BACKOFF_MS = [10 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];

export const FALLBACK_AFTER_MS = 24 * 60 * 60_000;
export const FALLBACK_ATTEMPTS = 3;

export interface TagRetry {
  attempts: number;
  nextAt: number;
  error: string;
  // When the file was first deferred
  firstAt: number;
}

// Whether a file has waited long enough for a provider that keeps failing
export function gaveUp(retry: TagRetry | null | undefined, now: number): boolean {
  return Boolean(retry) && retry!.attempts >= FALLBACK_ATTEMPTS && now - retry!.firstAt >= FALLBACK_AFTER_MS;
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
    const row = this.database.db.prepare('SELECT attempts, next_at, error, first_at FROM tag_retries WHERE path = ?').get(path) as
      { attempts: number; next_at: number; error: string; first_at: number } | undefined;
    return row ? { attempts: row.attempts, nextAt: row.next_at, error: row.error, firstAt: row.first_at } : null;
  }

  // Records another failure for the file; when to ask again
  defer(path: string, error: string): TagRetry {
    const before = this.get(path);
    const attempts = (before?.attempts ?? 0) + 1;
    const now = this.now();
    const nextAt = now + RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length) - 1];
    const firstAt = before?.firstAt ?? now;
    this.database.db.prepare(`
      INSERT INTO tag_retries (path, attempts, next_at, error, first_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (path) DO UPDATE SET attempts = excluded.attempts, next_at = excluded.next_at, error = excluded.error
    `).run(path, attempts, nextAt, error, firstAt);
    return { attempts, nextAt, error, firstAt };
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

// The files written from a later provider because an earlier one kept failing (gaveUp), until the earlier one has
// been asked again (sleeve tag --recheck-fallbacks). The hash of the text written tells whether the lyrics are still
// the ones sleeve wrote, so a recheck never replaces what anything else put there since.
export interface TagFallback {
  provider: string;
  // The providers it took the place of
  waitedFor: string[];
  textHash: string;
  writtenAt: number;
}

export const lyricsHash = (text: string) => createHash('sha256').update(text).digest('hex');

export class TagFallbacks {
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

  get(path: string): TagFallback | null {
    const row = this.database.db.prepare('SELECT provider, waited_for, text_hash, written_at FROM tag_fallbacks WHERE path = ?').get(path) as
      { provider: string; waited_for: string; text_hash: string; written_at: number } | undefined;
    return row ? { provider: row.provider, waitedFor: row.waited_for.split(','), textHash: row.text_hash, writtenAt: row.written_at } : null;
  }

  record(path: string, provider: string, waitedFor: string[], text: string): void {
    this.database.db.prepare(`
      INSERT INTO tag_fallbacks (path, provider, waited_for, text_hash, written_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (path) DO UPDATE SET provider = excluded.provider, waited_for = excluded.waited_for, text_hash = excluded.text_hash, written_at = excluded.written_at
    `).run(path, provider, waitedFor.join(','), lyricsHash(text), this.now());
  }

  forget(path: string): void {
    this.database.db.prepare('DELETE FROM tag_fallbacks WHERE path = ?').run(path);
  }

  count(): number {
    return (this.database.db.prepare('SELECT COUNT(*) AS count FROM tag_fallbacks').get() as { count: number }).count;
  }

  close(): void {
    if (this.owned) this.database.close();
  }
}
