import { DURATION_WINDOW_MS } from '../core/db.ts';
import { fetchLyrics, queryForFile, type FetchOptions } from '../core/fetchLyrics.ts';
import type { TagReader } from '../core/tags/reader.ts';
import type { LyricLine, LyricsResult, TrackQuery } from '../core/types.ts';
import { positionAt } from '../players/clock.ts';
import type { PlaybackSource } from '../players/hub.ts';
import type { MusicmanLibrary } from '../players/musicman.ts';
import { Listeners, type Playback, type PlayingTrack } from '../players/types.ts';

// Lyrics for whatever plays: follows the active playback, looks lyrics up once per track (the previous lookup
// is abandoned when the track changes first), and says which line is current, the user's offset included.
// What the daemon will serve; `sleeve now` prints it.

export interface NowState {
  playback: Playback | null;
  // The track as asked for lyrics; null without a track, or while it is being worked out
  query: TrackQuery | null;
  result: LyricsResult | null;
  loading: boolean;
  error: string | null;
}

export interface SessionOptions extends Pick<FetchOptions, 'providers' | 'timeoutMs' | 'fetch' | 'cache' | 'prefs' | 'userAgent'> {
  library?: MusicmanLibrary | null;
  tags?: TagReader;
  lookup?: typeof fetchLyrics;
}

export interface CurrentLine {
  // -1 before the first line
  index: number;
  line: LyricLine | null;
  // When the line starts, the offset applied (ms)
  time: number | null;
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

// The line playing at positionMs, with lyrics shifted by offsetMs (positive: later)
export function lineAt(result: LyricsResult | null, positionMs: number): CurrentLine {
  const lyrics = result?.best?.lyrics;
  if (!lyrics?.synced) return { index: -1, line: null, time: null };
  const offset = result!.offsetMs;
  let index = -1;
  for (let at = 0; at < lyrics.lines.length; at++) {
    if ((lyrics.lines[at].time ?? 0) + offset > positionMs) break;
    index = at;
  }
  return index < 0 ? { index, line: null, time: null } : { index, line: lyrics.lines[index], time: lyrics.lines[index].time! + offset };
}

export class NowPlaying {
  private source: PlaybackSource;
  private options: SessionOptions;
  private state: NowState = { playback: null, query: null, result: null, loading: false, error: null };
  private key: string | null = null;
  private abort: AbortController | null = null;
  private loading: Promise<void> = Promise.resolve();
  private listeners = new Listeners<NowState>();
  private unsubscribe: (() => void) | null = null;

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
      this.listeners.emit(this.state);
      return;
    }
    this.key = key;
    this.abort?.abort();
    this.abort = null;
    if (!playback?.track) {
      this.state = { playback, query: null, result: null, loading: false, error: null };
      this.listeners.emit(this.state);
      return;
    }
    this.loading = this.load(key!, playback.track);
  }

  private async load(key: string, track: PlayingTrack): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    const stale = () => this.key !== key;
    this.state = { ...this.state, query: null, result: null, loading: true, error: null };
    this.listeners.emit(this.state);
    try {
      const query = await queryForPlayback(track, this.options);
      if (stale()) return;
      this.state = { ...this.state, query };
      if (query) {
        const { library: _library, lookup = fetchLyrics, ...fetchOptions } = this.options;
        const result = await lookup(query, { ...fetchOptions, signal: abort.signal });
        if (stale()) return;
        this.state = { ...this.state, result };
      }
    } catch (error) {
      if (stale()) return;
      this.state = { ...this.state, error: error instanceof Error ? error.message : String(error) };
    }
    this.state = { ...this.state, loading: false };
    this.listeners.emit(this.state);
  }

  // Moves the lyrics shown by deltaMs (positive: later) and remembers it for the track; the new offset, or null
  // when there are no lyrics to move
  nudge(deltaMs: number): number | null {
    const { query, result } = this.state;
    if (!query || !result?.best) return null;
    const offsetMs = result.offsetMs + deltaMs;
    const prefs = this.options.prefs;
    if (prefs) {
      if (offsetMs === 0) prefs.clearOffset(query);
      else prefs.setOffset(query, offsetMs, result.best);
    }
    this.state = { ...this.state, result: { ...result, offsetMs } };
    this.listeners.emit(this.state);
    return offsetMs;
  }

  close(): void {
    this.unsubscribe?.();
    this.abort?.abort();
  }
}
