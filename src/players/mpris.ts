import { fileURLToPath } from 'node:url';
import { monotonic } from './clock.ts';
import { Listeners, settle, type Playback, type PlaybackState, type Player, type PlayingTrack } from './types.ts';

// An MPRIS player (Spotify by default) on the session bus. Properties come in once and then as
// PropertiesChanged; the position, which MPRIS does not signal, is read again on every change of state or
// track, on Seeked, and every resyncMs while playing, and runs on in between (clock.ts). The player coming and
// going (Spotify started or quit) is followed through the bus name's owner.
//
// The bus is behind MprisBus, so tests need no D-Bus; mprisDbus.ts is the real one.

export const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
// Names that are not players of their own: playerctld proxies the others, and mpd's MPRIS bridge would show
// MPD twice next to the direct client
export const NOT_PLAYERS = ['playerctld', 'mpd'];

// Property values as plain JavaScript: variants unwrapped, 64-bit integers as numbers
export type Properties = Record<string, unknown>;

export interface MprisProxy {
  // org.mpris.MediaPlayer2.Player's properties
  properties(): Promise<Properties>;
  // In microseconds
  position(): Promise<number>;
  onChanged(listener: (changed: Properties) => void): void;
  onSeeked(listener: (positionUs: number) => void): void;
  close(): void;
}

export interface MprisBus {
  // Calls listener with whether the name has an owner each time that changes; resolves to whether it has one now
  watchName(name: string, listener: (owned: boolean) => void): Promise<boolean>;
  open(name: string): Promise<MprisProxy>;
  close(): void;
}

export interface MprisPlayerOptions {
  now?: () => number;
  // How often to read the position again while playing; 0 never
  resyncMs?: number;
  // Wait after a new track before reading the position again, since players report a new track in pieces
  settleMs?: number;
}

const STATES: Record<string, PlaybackState> = { Playing: 'playing', Paused: 'paused', Stopped: 'stopped' };

// The Spotify id in a track URL or MPRIS track id: open.spotify.com/track/ID, /com/spotify/track/ID
export function spotifyIdOf(text: unknown): string | undefined {
  const match = /track[/:]([A-Za-z0-9]{22})\b/.exec(typeof text === 'string' ? text : '');
  return match?.[1];
}

function text(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string' && item).join(', ') || undefined;
  return typeof value === 'string' && value ? value : undefined;
}

export function trackFromMetadata(metadata: unknown): PlayingTrack | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const fields = metadata as Record<string, unknown>;
  const title = text(fields['xesam:title']);
  const url = text(fields['xesam:url']);
  const id = text(fields['mpris:trackid']);
  if (!title && !url) return null;
  const artist = text(fields['xesam:artist']) ?? text(fields['xesam:albumArtist']) ?? '';
  const album = text(fields['xesam:album']);
  const length = Number(fields['mpris:length']);
  const durationMs = Number.isFinite(length) && length > 0 ? Math.round(length / 1000) : undefined;
  const spotifyId = spotifyIdOf(url) ?? spotifyIdOf(id);
  let file: string | undefined;
  if (url?.startsWith('file://')) {
    try { file = fileURLToPath(url); } catch { file = undefined; }
  }
  return {
    key: id ?? url ?? `${artist}-${title}`,
    artist,
    title: title ?? url!,
    ...(album ? { album } : {}),
    ...(durationMs ? { durationMs } : {}),
    ...(file ? { file } : {}),
    ...(spotifyId ? { spotifyId } : {})
  };
}

export class MprisPlayer implements Player {
  readonly name: string;
  private bus: MprisBus;
  private now: () => number;
  private resyncMs: number;
  private settleMs: number;
  private proxy: MprisProxy | null = null;
  private attaching: Promise<void> | null = null;
  private props: Properties = {};
  private position = { ms: 0, at: 0 };
  private playback: Playback | null = null;
  private listeners = new Listeners<Playback | null>();
  private first = settle();
  private timers = new Set<NodeJS.Timeout>();
  private resyncTimer: NodeJS.Timeout | null = null;
  private lastProblem: string | null = null;
  private closed = false;

  // identity: the part of the bus name after org.mpris.MediaPlayer2. ('spotify')
  constructor(bus: MprisBus, identity: string, options: MprisPlayerOptions = {}) {
    this.bus = bus;
    this.name = identity;
    this.now = options.now ?? monotonic;
    this.resyncMs = options.resyncMs ?? 5000;
    this.settleMs = options.settleMs ?? 400;
  }

  start(): void {
    void this.watch();
  }

  ready(): Promise<void> {
    return this.first.promise;
  }

  current(): Playback | null {
    return this.playback;
  }

  problem(): string | null {
    return this.lastProblem;
  }

  onChange(listener: (playback: Playback | null) => void): () => void {
    return this.listeners.add(listener);
  }

  private async watch(): Promise<void> {
    try {
      const owned = await this.bus.watchName(MPRIS_PREFIX + this.name, now => {
        if (now) void this.attach();
        else this.detach(`${this.name} is not running`);
      });
      if (owned) await this.attach();
      else this.lastProblem = `${this.name} is not running`;
    } catch (error) {
      this.lastProblem = error instanceof Error ? error.message : String(error);
    } finally {
      this.first.resolve();
    }
  }

  private attach(): Promise<void> {
    if (this.proxy || this.closed) return Promise.resolve();
    this.attaching ??= (async () => {
      try {
        const proxy = await this.bus.open(MPRIS_PREFIX + this.name);
        if (this.closed) {
          proxy.close();
          return;
        }
        this.proxy = proxy;
        proxy.onChanged(changed => this.changed(changed));
        proxy.onSeeked(positionUs => this.moved(positionUs));
        this.props = await proxy.properties();
        this.lastProblem = null;
        this.moved(Number(this.props.Position ?? 0));
        if (this.resyncMs > 0) this.resyncTimer = setInterval(() => { if (this.playback?.state === 'playing') void this.resync(); }, this.resyncMs);
      } catch (error) {
        this.lastProblem = error instanceof Error ? error.message : String(error);
        this.proxy?.close();
        this.proxy = null;
      } finally {
        this.attaching = null;
      }
    })();
    return this.attaching;
  }

  private detach(problem: string): void {
    this.proxy?.close();
    this.proxy = null;
    this.props = {};
    if (this.resyncTimer) clearInterval(this.resyncTimer);
    this.resyncTimer = null;
    this.lastProblem = problem;
    if (this.playback) {
      this.playback = null;
      this.listeners.emit(null);
    }
  }

  private changed(changed: Properties): void {
    const newTrack = 'Metadata' in changed && trackFromMetadata(changed.Metadata)?.key !== trackFromMetadata(this.props.Metadata)?.key;
    Object.assign(this.props, changed);
    if (!('PlaybackStatus' in changed || 'Metadata' in changed || 'Rate' in changed)) {
      this.emit();
      return;
    }
    // A new track starts at 0 until the player says otherwise
    if (newTrack) this.position = { ms: 0, at: this.now() };
    this.emit();
    void this.resync();
    if (newTrack && this.settleMs > 0) {
      const timer = setTimeout(() => { this.timers.delete(timer); void this.resync(); }, this.settleMs);
      this.timers.add(timer);
    }
  }

  private moved(positionUs: number): void {
    this.position = { ms: Math.round(positionUs / 1000), at: this.now() };
    this.emit();
  }

  private async resync(): Promise<void> {
    const proxy = this.proxy;
    if (!proxy) return;
    try {
      const positionUs = await proxy.position();
      if (proxy === this.proxy) this.moved(positionUs);
    } catch {
      // A player between tracks may refuse; the next change or resync reads it again
    }
  }

  private emit(): void {
    if (!this.proxy) return;
    const state = STATES[String(this.props.PlaybackStatus)] ?? 'stopped';
    const track = state === 'stopped' ? null : trackFromMetadata(this.props.Metadata);
    const rate = Number(this.props.Rate ?? 1);
    const previous = this.playback;
    const changed = !previous || previous.state !== state || previous.track?.key !== track?.key;
    this.playback = {
      player: this.name,
      state,
      track,
      positionMs: this.position.ms,
      at: this.position.at,
      rate: Number.isFinite(rate) && rate > 0 ? rate : 1,
      changedAt: changed ? this.now() : previous.changedAt
    };
    this.listeners.emit(this.playback);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.detach('closed');
    this.first.resolve();
  }
}
