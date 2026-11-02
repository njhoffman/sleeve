// What a player reports: the track and where playback is in it. Players push a new Playback on every change
// (track, state, seek, a resync of the position); between changes the position runs on at `rate` from `at`
// (see clock.ts).

export type PlaybackState = 'playing' | 'paused' | 'stopped';

export interface PlayingTrack {
  // Identifies the track within its player: a change of key is a new track
  key: string;
  artist: string;
  title: string;
  album?: string;
  durationMs?: number;
  // The local file playing, absolute (MPD, or an MPRIS player playing a file:// URL)
  file?: string;
  spotifyId?: string;
}

export interface Playback {
  // 'mpd', or the MPRIS name ('spotify')
  player: string;
  state: PlaybackState;
  track: PlayingTrack | null;
  // Where playback was at `at`, a monotonic time in milliseconds (performance.now())
  positionMs: number;
  at: number;
  rate: number;
  // When the state or the track last changed (monotonic ms), to choose between paused players
  changedAt: number;
  // The track queued to play after this one, when the player says (MPD); for prefetching its lyrics
  next?: PlayingTrack | null;
}

export interface Player {
  readonly name: string;
  // Connects and keeps reconnecting until closed
  start(): void;
  // Resolves once the first attempt to reach the player has ended, connected or not
  ready(): Promise<void>;
  // null while the player is not running or cannot be reached
  current(): Playback | null;
  onChange(listener: (playback: Playback | null) => void): () => void;
  // Why the player is unreachable, when it is
  problem(): string | null;
  close(): Promise<void>;
}

export class Listeners<T> {
  private listeners = new Set<(value: T) => void>();

  add(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
}

// A promise and its resolve, for ready()
export function settle(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
