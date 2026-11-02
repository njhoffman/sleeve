import { defaultDatabasePath, openShared, rankRows, rememberIds, SleeveDatabase, trackKey, trackMatch, type TrackRow } from './db.ts';
import type { Candidate, TrackQuery } from './types.ts';

// What the user decided for a track: a pick (the candidate to show, whatever the ranking says) and a timing
// offset. Both are kept until the user resets them; `sleeve cache clear` does not touch them.
//
// A pick is the candidate's provider and id plus a copy of the candidate, so it outlives the provider's
// stored answer and the provider dropping the record. The offset is set against one candidate (provider and
// id), since how far lyrics drift is a property of that candidate's timing against the audio; it applies
// only while that candidate is the one shown, and is kept otherwise. Setting an offset does not pick.
//
// Offsets are in milliseconds, positive to show lyrics later. (LRC's own [offset:] tag runs the other way.)
// Tracks match as db.ts defines: by ISRC or Spotify id first, else by names, the closest duration winning.

export interface CandidateRef {
  provider: string;
  id: string;
}

export interface TrackOffset extends CandidateRef {
  ms: number;
}

export interface TrackPrefsRecord {
  // The picked candidate as it was when picked: unscored, without cachedAt
  pick: Candidate | null;
  offset: TrackOffset | null;
  updatedAt: number;
}

interface Row extends TrackRow {
  pick_candidate: string | null;
  offset_ms: number | null;
  offset_provider: string | null;
  offset_id: string | null;
  updated_at: number;
}

// "provider:id", the form `sleeve pick` takes and `sleeve lyrics --all` prints
export function formatRef(ref: { provider: string; id?: string }): string {
  return `${ref.provider}:${ref.id ?? ''}`;
}

// Splits at the first colon, since ids may hold colons of their own
export function parseRef(text: string): CandidateRef | null {
  const colon = text.indexOf(':');
  if (colon <= 0 || colon === text.length - 1) return null;
  return { provider: text.slice(0, colon).toLowerCase(), id: text.slice(colon + 1) };
}

export function sameCandidate(candidate: { provider: string; id?: string }, ref: CandidateRef): boolean {
  return candidate.provider === ref.provider && candidate.id === ref.id;
}

function refOf(candidate: Candidate): CandidateRef {
  if (!candidate.id) throw new Error(`${candidate.provider} gave this candidate no id, so it cannot be remembered`);
  return { provider: candidate.provider, id: candidate.id };
}

// The candidate as a provider gave it, without what scoring and the cache added
function snapshot(candidate: Candidate): Candidate {
  const { provider, id, track, lyrics, exact } = candidate;
  return { provider, ...(id ? { id } : {}), track, lyrics, ...(exact ? { exact } : {}) };
}

export class TrackPrefs {
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

  private get db() {
    return this.database.db;
  }

  private row(query: TrackQuery): Row | null {
    const key = trackKey(query);
    const { where, params } = trackMatch(key);
    const rows = this.db.prepare(`SELECT id, duration_ms, isrc, spotify_id, pick_candidate, offset_ms, offset_provider, offset_id, updated_at FROM track_prefs WHERE ${where}`)
      .all(...params) as unknown as Row[];
    const [row] = rankRows(rows, key);
    if (row) rememberIds(this.database, 'track_prefs', row, key);
    return row ?? null;
  }

  get(query: TrackQuery): TrackPrefsRecord | null {
    const row = this.row(query);
    if (!row) return null;
    return {
      pick: row.pick_candidate ? JSON.parse(row.pick_candidate) as Candidate : null,
      offset: row.offset_ms !== null && row.offset_provider && row.offset_id
        ? { ms: row.offset_ms, provider: row.offset_provider, id: row.offset_id }
        : null,
      updatedAt: row.updated_at
    };
  }

  // Writes the columns for the track's row, creating it when missing and removing it once nothing is left in it
  private update(query: TrackQuery, columns: Record<string, string | number | null>): boolean {
    return this.database.transaction(() => {
      const existing = this.row(query);
      if (!existing) {
        if (Object.values(columns).every(value => value === null)) return false;
        const { artist, title, duration, isrc, spotifyId } = trackKey(query);
        const names = ['artist_key', 'title_key', 'duration_ms', 'isrc', 'spotify_id', ...Object.keys(columns), 'updated_at'];
        this.db.prepare(`INSERT INTO track_prefs (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
          .run(artist, title, duration, isrc, spotifyId, ...Object.values(columns), this.now());
        return true;
      }
      const assignments = Object.keys(columns).map(name => `${name} = ?`).join(', ');
      this.db.prepare(`UPDATE track_prefs SET ${assignments}, updated_at = ? WHERE id = ?`).run(...Object.values(columns), this.now(), existing.id);
      this.db.prepare('DELETE FROM track_prefs WHERE id = ? AND pick_candidate IS NULL AND offset_ms IS NULL').run(existing.id);
      return true;
    });
  }

  // Shows this candidate for the track from now on
  setPick(query: TrackQuery, candidate: Candidate): void {
    const ref = refOf(candidate);
    this.update(query, { pick_provider: ref.provider, pick_id: ref.id, pick_candidate: JSON.stringify(snapshot(candidate)) });
  }

  // Back to the ranking; returns whether there was a pick
  clearPick(query: TrackQuery): boolean {
    if (!this.get(query)?.pick) return false;
    return this.update(query, { pick_provider: null, pick_id: null, pick_candidate: null });
  }

  // Shifts the candidate's lyrics by ms (positive: later) whenever it is the one shown for the track
  setOffset(query: TrackQuery, ms: number, candidate: Candidate): void {
    if (!Number.isInteger(ms)) throw new Error(`Offset must be whole milliseconds: ${ms}`);
    const ref = refOf(candidate);
    this.update(query, { offset_ms: ms, offset_provider: ref.provider, offset_id: ref.id });
  }

  // Returns whether there was an offset
  clearOffset(query: TrackQuery): boolean {
    if (!this.get(query)?.offset) return false;
    return this.update(query, { offset_ms: null, offset_provider: null, offset_id: null });
  }

  close(): void {
    if (this.owned) this.database.close();
  }
}
