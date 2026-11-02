import { DURATION_WINDOW_MS } from '../core/db.ts';
import { fetchLyrics, queryForFile, type FetchOptions } from '../core/fetchLyrics.ts';
import type { TagReader } from '../core/tags/reader.ts';
import { formatRef, sameCandidate, type CandidateRef } from '../core/prefs.ts';
import type { LyricsResult, ScoredCandidate, TrackQuery } from '../core/types.ts';
import { positionAt } from '../players/clock.ts';
import type { PlaybackSource } from '../players/hub.ts';
import type { MusicmanLibrary } from '../players/musicman.ts';
import { Listeners, type Playback, type PlayingTrack } from '../players/types.ts';
import { lineAt, type CurrentLine } from './lines.ts';
import type { NowState } from './state.ts';

export { lineAt, nextLineTime, type CurrentLine } from './lines.ts';
export type { NowState } from './state.ts';

// Lyrics for whatever plays: follows the active playback, looks lyrics up once per track (the previous lookup
// is abandoned when the track changes first), and says which line is current, the user's offset included.
// What the daemon will serve; `sleeve now` prints it.


export interface SessionOptions extends Pick<FetchOptions, 'providers' | 'timeoutMs' | 'fetch' | 'cache' | 'prefs' | 'userAgent'> {
  library?: MusicmanLibrary | null;
  tags?: TagReader;
  lookup?: typeof fetchLyrics;
  // Look up the track the player has queued next once the current one is settled (default true)
  prefetch?: boolean;
}

interface Answer {
  query: TrackQuery | null;
  result: LyricsResult | null;
}

// A lookup started ahead for the track queued next, adopted when that track starts
interface Prefetch {
  key: string;
  abort: AbortController;
  answer: Promise<Answer>;
}

function fromPlayer(track: PlayingTrack, extra: Partial<TrackQuery> = {}): TrackQuery {
  return {
    artist: track.artist,
    title: track.title,
    ...(track.album ? { album: track.album } : {}),
    ...(track.durationMs ? { durationMs: track.durationMs } : {}),
    ...(track.spotifyId ? { spotifyId: track.spotifyId } : {}),
    ...extra
  };
}

// The query for a track. A local file playing (MPD) is asked by its own tags and measured length. A Spotify
// track that musicman has in the library keeps Spotify's names and length, since Spotify's audio is what plays,
// and gets the file (for its lyrics and tags) only when the file's length is within the duration window of
// Spotify's: a different master would put local lyrics out of time. null when there is no artist or title.
export async function queryForPlayback(track: PlayingTrack, { library, tags }: Pick<SessionOptions, 'library' | 'tags'> = {}): Promise<TrackQuery | null> {
  if (track.file) {
    try {
      return await queryForFile(track.file, {}, tags);
    } catch {
      // No tags, or the file is not readable here: what the player says, still with the file for sidecars
      return track.artist && track.title ? fromPlayer(track, { path: track.file }) : null;
    }
  }
  if (!track.artist || !track.title) return null;
  const local = track.spotifyId && library ? library.fileFor(track.spotifyId) : null;
  const fits = local && (!local.durationMs || !track.durationMs || Math.abs(local.durationMs - track.durationMs) <= DURATION_WINDOW_MS);
  if (!local || !fits) return fromPlayer(track);
  const given = fromPlayer(track);
  try {
    // The file's ISRC and the like, under the player's names and length
    return { ...(await queryForFile(local.file, given, tags)), ...given, path: local.file };
  } catch {
    return { ...given, path: local.file };
  }
}

// Every candidate a result holds: the one shown (a pick may be under the threshold and in neither list), then
// the rest in the order `sleeve lyrics --all` numbers them
function listed(result: LyricsResult | null): ScoredCandidate[] {
  if (!result) return [];
  return [...(result.best ? [result.best] : []), ...result.candidates, ...result.rejected];
}

export class NowPlaying {
  private source: PlaybackSource;
  private options: SessionOptions;
  private state: NowState = { playback: null, query: null, result: null, loading: false, error: null };
  private key: string | null = null;
  // Bumped by every lookup started, so a lookup overtaken by a newer one (next track, refresh, pick) is dropped
  private generation = 0;
  private abort: AbortController | null = null;
  private loading: Promise<void> = Promise.resolve();
  private listeners = new Listeners<NowState>();
  private unsubscribe: (() => void) | null = null;
  private prefetched: Prefetch | null = null;

  constructor(source: PlaybackSource, options: SessionOptions = {}) {
    this.source = source;
    this.options = options;
  }

  start(): void {
    this.unsubscribe = this.source.onChange(playback => this.follow(playback));
    this.follow(this.source.active());
  }

  current(): NowState {
    return this.state;
  }

  onChange(listener: (state: NowState) => void): () => void {
    return this.listeners.add(listener);
  }

  // Resolves once the lookup for the current track has finished
  async settled(): Promise<NowState> {
    let pending: Promise<void>;
    do {
      pending = this.loading;
      await pending;
    } while (pending !== this.loading);
    return this.state;
  }

  position(now?: number): number {
    return this.state.playback ? positionAt(this.state.playback, now) : 0;
  }

  line(now?: number): CurrentLine {
    return lineAt(this.state.result, this.position(now));
  }

  private follow(playback: Playback | null): void {
    const key = playback?.track ? `${playback.player}:${playback.track.key}` : null;
    this.state = { ...this.state, playback };
    if (key === this.key) {
      this.prefetchNext();
      this.listeners.emit(this.state);
      return;
    }
    this.key = key;
    this.abort?.abort();
    this.abort = null;
    if (!playback?.track) {
      this.generation++;
      this.state = { playback, query: null, result: null, loading: false, error: null };
      this.listeners.emit(this.state);
      return;
    }
    this.loading = this.load(playback.track, { fresh: true });
  }

  // Looks the track up. A new track (fresh) starts from nothing; a reload of the same track (refresh, a pick)
  // keeps showing what it had until the new answer is in.
  private lookupOptions() {
    const { library: _library, lookup = fetchLyrics, prefetch: _prefetch, ...fetchOptions } = this.options;
    return { lookup, fetchOptions };
  }

  // Looks the track up. A new track (fresh) starts from nothing, from its prefetched lookup when there is one; a
  // reload of the same track (refresh, a pick) keeps showing what it had until the new answer is in.
  private async load(track: PlayingTrack, { fresh = false, refresh = false }: { fresh?: boolean; refresh?: boolean } = {}): Promise<void> {
    this.abort?.abort();
    const adopted = fresh && this.prefetched?.key === this.key ? this.prefetched : null;
    if (adopted) this.prefetched = null;
    const abort = adopted?.abort ?? new AbortController();
    this.abort = abort;
    const generation = ++this.generation;
    const stale = () => this.generation !== generation;
    this.state = fresh
      ? { ...this.state, query: null, result: null, loading: true, error: null }
      : { ...this.state, loading: true, error: null };
    this.listeners.emit(this.state);
    try {
      // A prefetch that failed, or found nothing because providers failed, is asked again now
      const answer = adopted ? await adopted.answer.catch(() => null) : null;
      if (stale()) return;
      const usable = answer && !(answer.result && !answer.result.best && answer.result.errors.length);
      if (usable) {
        this.state = { ...this.state, query: answer.query, result: answer.result };
      } else {
        const query = fresh || !this.state.query ? await queryForPlayback(track, this.options) : this.state.query;
        if (stale()) return;
        this.state = { ...this.state, query };
        if (query) {
          const { lookup, fetchOptions } = this.lookupOptions();
          const result = await lookup(query, { ...fetchOptions, signal: abort.signal, ...(refresh ? { refresh } : {}) });
          if (stale()) return;
          this.state = { ...this.state, result };
        }
      }
    } catch (error) {
      if (stale()) return;
      this.state = { ...this.state, error: error instanceof Error ? error.message : String(error) };
    }
    this.state = { ...this.state, loading: false };
    this.prefetchNext();
    this.listeners.emit(this.state);
  }

  // Starts the lookup for the track queued next, once the current one is settled; drops one for a track that is no
  // longer next. Errors stay in the prefetch, for load to deal with.
  private prefetchNext(): void {
    if (this.options.prefetch === false) return;
    const playback = this.state.playback;
    const next = playback?.next;
    const key = playback && next ? `${playback.player}:${next.key}` : null;
    const wanted = key !== this.key ? key : null;
    if (this.prefetched && this.prefetched.key !== wanted) {
      this.prefetched.abort.abort();
      this.prefetched = null;
    }
    if (!wanted || !next || this.prefetched || this.state.loading) return;
    const abort = new AbortController();
    const answer = (async (): Promise<Answer> => {
      const query = await queryForPlayback(next, this.options);
      abort.signal.throwIfAborted();
      if (!query) return { query: null, result: null };
      const { lookup, fetchOptions } = this.lookupOptions();
      return { query, result: await lookup(query, { ...fetchOptions, signal: abort.signal }) };
    })();
    answer.catch(() => {});
    this.prefetched = { key: wanted, abort, answer };
  }

  // The key of the track whose lookup runs ahead, if any
  prefetching(): string | null {
    return this.prefetched?.key ?? null;
  }

  // Looks the current track up again, asking online providers instead of their stored answers
  async refresh(): Promise<NowState> {
    const track = this.state.playback?.track;
    if (!track) throw new Error('Nothing playing');
    this.loading = this.load(track, { refresh: true });
    return this.settled();
  }

  // Every provider's candidates for the current track, those under the threshold too, without changing what is
  // shown
  async candidates(): Promise<LyricsResult> {
    const query = this.state.query;
    if (!query) throw new Error(this.state.playback?.track ? 'The track has no artist and title to look up' : 'Nothing playing');
    const { lookup, fetchOptions } = this.lookupOptions();
    return lookup(query, { ...fetchOptions, all: true });
  }

  // Shows this candidate for the current track from now on (saved as `sleeve pick` saves it) and looks the track
  // up again so it is shown. The candidate is one of those shown, else one every provider is asked for.
  async pick(ref: CandidateRef): Promise<ScoredCandidate> {
    const prefs = this.requirePrefs();
    const { query, result } = this.state;
    if (!query) throw new Error(this.state.playback?.track ? 'The track has no artist and title to look up' : 'Nothing playing');
    const key = this.key;
    let candidate = listed(result).find(item => sameCandidate(item, ref));
    if (!candidate) candidate = listed(await this.candidates()).find(item => sameCandidate(item, ref));
    if (this.key !== key) throw new Error('The track changed before the pick was made');
    if (!candidate) throw new Error(`No candidate ${formatRef(ref)} for ${query.artist} - ${query.title}`);
    prefs.setPick(query, candidate);
    await this.reload();
    return candidate;
  }

  // Forgets the pick for the current track, so the ranking decides again; whether there was one
  async unpick(): Promise<boolean> {
    const prefs = this.requirePrefs();
    const query = this.state.query;
    if (!query) throw new Error('Nothing playing');
    const had = prefs.clearPick(query);
    if (had) await this.reload();
    return had;
  }

  // Moves the lyrics shown by deltaMs (positive: later) and remembers it for the track; the new offset, or null
  // when there are no lyrics to move
  nudge(deltaMs: number): number | null {
    const offsetMs = this.state.result?.best ? this.state.result.offsetMs + deltaMs : null;
    return offsetMs === null ? null : this.setOffset(offsetMs);
  }

  // Sets the offset for the lyrics shown (0 removes it) and remembers it for the track; null when there are no
  // lyrics to move
  setOffset(offsetMs: number): number | null {
    if (!Number.isInteger(offsetMs)) throw new Error(`Offset must be whole milliseconds: ${offsetMs}`);
    const { query, result } = this.state;
    if (!query || !result?.best) return null;
    const prefs = this.options.prefs;
    if (prefs) {
      if (offsetMs === 0) prefs.clearOffset(query);
      else prefs.setOffset(query, offsetMs, result.best);
    }
    this.state = { ...this.state, result: { ...result, offsetMs } };
    this.listeners.emit(this.state);
    return offsetMs;
  }

  private async reload(): Promise<void> {
    const track = this.state.playback?.track;
    if (!track) return;
    this.loading = this.load(track);
    await this.settled();
  }

  private requirePrefs() {
    if (!this.options.prefs) throw new Error('Picks are off (--no-prefs)');
    return this.options.prefs;
  }

  close(): void {
    this.generation++;
    this.unsubscribe?.();
    this.abort?.abort();
    this.prefetched?.abort.abort();
    this.prefetched = null;
  }
}
