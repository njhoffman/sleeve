import { defaultDatabasePath, openShared, rankRows, rememberIds, SleeveDatabase, trackKey, trackMatch, type TrackRow } from './db.ts';
import { lineTimes, withoutPicked, wordsHash, type LyricsReport } from './reports.ts';
import type { Candidate, ReportKind, TrackMark, TrackQuery } from './types.ts';

// What the user decided for a track: a pick (the candidate to show, whatever the ranking says) or a mark (no
// lyrics are right for it, or it is instrumental: nothing is shown or written, whatever is found), and a timing
// offset. They are kept until the user resets them; `sleeve cache clear` does not touch them.
//
// A pick is the candidate's provider and id plus a copy of the candidate, so it outlives the provider's
// stored answer and the provider dropping the record. The offset is set against one candidate (provider and
// id), since how far lyrics drift is a property of that candidate's timing against the audio; it applies
// only while that candidate is the one shown, and is kept otherwise. Setting an offset does not pick.
//
// A report says lyrics shown were wrong or mistimed (src/core/reports.ts); a track can have any number, kept with its row.
// Reporting the lyrics picked removes the pick, and picking reported lyrics removes the report.
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
  mark?: TrackMark;
  reports?: LyricsReport[];
}

interface Row extends TrackRow {
  pick_candidate: string | null;
  mark: TrackMark | null;
  offset_ms: number | null;
  offset_provider: string | null;
  offset_id: string | null;
  updated_at: number;
  reports: string | null;
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

const reportsColumn = (reports: LyricsReport[]) => reports.length ? JSON.stringify(reports) : null;

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
    const rows = this.db.prepare(`SELECT id, duration_ms, isrc, spotify_id, pick_candidate, mark, offset_ms, offset_provider, offset_id, updated_at, reports FROM track_prefs WHERE ${where}`)
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
      updatedAt: row.updated_at,
      ...(row.mark ? { mark: row.mark } : {}),
      ...(row.reports ? { reports: JSON.parse(row.reports) as LyricsReport[] } : {})
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
      this.db.prepare('DELETE FROM track_prefs WHERE id = ? AND pick_candidate IS NULL AND mark IS NULL AND offset_ms IS NULL AND reports IS NULL').run(existing.id);
      return true;
    });
  }

  // Shows this candidate for the track from now on
  setPick(query: TrackQuery, candidate: Candidate): void {
    const ref = refOf(candidate);
    const reports = this.get(query)?.reports;
    this.update(query, {
      pick_provider: ref.provider, pick_id: ref.id, pick_candidate: JSON.stringify(snapshot(candidate)), mark: null,
      ...(reports ? { reports: reportsColumn(withoutPicked(reports, candidate)) } : {})
    });
  }

  // Shows nothing for the track from now on, in place of any pick
  setMark(query: TrackQuery, mark: TrackMark): void {
    this.update(query, { pick_provider: null, pick_id: null, pick_candidate: null, mark });
  }

  // Back to the ranking; returns whether there was a pick or a mark
  clearPick(query: TrackQuery): boolean {
    const record = this.get(query);
    if (!record?.pick && !record?.mark) return false;
    return this.update(query, { pick_provider: null, pick_id: null, pick_candidate: null, mark: null });
  }

  // How many tracks are marked: a run over the library looks each file's track up only when some are
  markCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS count FROM track_prefs WHERE mark IS NOT NULL').get() as { count: number }).count;
  }

  // Remembers what the user said about these lyrics, once per kind; a pick of them goes
  addReport(query: TrackQuery, kind: ReportKind, candidate: Candidate): void {
    const record = this.get(query);
    const { provider, id, lyrics } = candidate;
    const report: LyricsReport = {
      kind, provider, ...(id ? { id } : {}), artist: query.artist, title: query.title, ...(query.path ? { path: query.path } : {}),
      words: wordsHash(lyrics), times: lineTimes(lyrics), reportedAt: this.now()
    };
    const others = (record?.reports ?? []).filter(item => item.kind !== kind || item.provider !== provider || item.id !== id);
    const picked = record?.pick && id && sameCandidate(record.pick, { provider, id });
    this.update(query, { reports: reportsColumn([...others, report]), ...(picked ? { pick_provider: null, pick_id: null, pick_candidate: null } : {}) });
  }

  // Forgets what was reported about the track; whether anything was
  clearReports(query: TrackQuery): boolean {
    if (!this.get(query)?.reports) return false;
    return this.update(query, { reports: null });
  }

  // How many tracks have reports
  reportCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS count FROM track_prefs WHERE reports IS NOT NULL').get() as { count: number }).count;
  }

  // Every report, the latest first
  allReports(): LyricsReport[] {
    const rows = this.db.prepare('SELECT reports FROM track_prefs WHERE reports IS NOT NULL').all() as unknown as Array<{ reports: string }>;
    return rows.flatMap(row => JSON.parse(row.reports) as LyricsReport[]).sort((a, b) => b.reportedAt - a.reportedAt);
  }

  // Forgets every report; how many tracks had some
  clearAllReports(): number {
    const count = this.reportCount();
    this.database.transaction(() => {
      this.db.prepare('UPDATE track_prefs SET reports = NULL WHERE reports IS NOT NULL').run();
      this.db.prepare('DELETE FROM track_prefs WHERE pick_candidate IS NULL AND mark IS NULL AND offset_ms IS NULL AND reports IS NULL').run();
    });
    return count;
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
