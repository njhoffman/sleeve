import net from 'node:net';
import path from 'node:path';
import { monotonic } from './clock.ts';
import { Listeners, settle, type Playback, type PlaybackState, type Player, type PlayingTrack } from './types.ts';

// MPD through its own protocol: one connection that reads `status` and `currentsong`, then waits in
// `idle player` for the next change (play, pause, seek, a new song). MPD reports elapsed time exactly, so the
// position needs no polling. A dropped connection is retried with growing waits, and reported as no playback.

export interface MpdAddress {
  host: string;
  port: number;
  // A Unix socket instead of host and port
  socket?: string;
  password?: string;
}

export interface MpdPlayerOptions extends MpdAddress {
  // MPD's music_directory, to turn MPD's relative paths into files
  musicDirectory?: string;
  now?: () => number;
  // Waits before reconnecting, the last one repeating
  retryMs?: number[];
}

export const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];

type Fields = Map<string, string>;

// One protocol connection: commands answered in order, each reply ending in OK or ACK
export class MpdConnection {
  readonly version: Promise<string>;
  readonly closed: Promise<void>;
  private socket: net.Socket;
  private buffer = '';
  private pairs: Array<[string, string]> = [];
  private waiting: Array<{ resolve: (pairs: Array<[string, string]>) => void; reject: (error: Error) => void }> = [];
  private greet: { resolve: (version: string) => void; reject: (error: Error) => void } | null = null;
  private failure: Error | null = null;

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.version = new Promise((resolve, reject) => { this.greet = { resolve, reject }; });
    // Unhandled when a caller never awaits it; failures reach commands as well
    this.version.catch(() => {});
    socket.setEncoding('utf8');
    socket.on('data', chunk => this.receive(String(chunk)));
    socket.on('error', error => this.fail(error));
    this.closed = new Promise(resolve => socket.once('close', () => {
      this.fail(new Error('MPD closed the connection'));
      resolve();
    }));
  }

  static open(address: MpdAddress): Promise<MpdConnection> {
    const socket = address.socket ? net.connect({ path: address.socket }) : net.connect({ host: address.host, port: address.port });
    const connection = new MpdConnection(socket);
    return connection.version.then(() => connection);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      this.line(line);
    }
  }

  private line(line: string): void {
    if (this.greet) {
      const greet = this.greet;
      this.greet = null;
      if (line.startsWith('OK MPD ')) greet.resolve(line.slice(7));
      else {
        greet.reject(new Error(`Not an MPD server: ${line}`));
        this.socket.destroy();
      }
      return;
    }
    if (line === 'OK' || line.startsWith('ACK ')) {
      const pairs = this.pairs;
      this.pairs = [];
      const waiter = this.waiting.shift();
      if (line === 'OK') waiter?.resolve(pairs);
      else waiter?.reject(new Error(`MPD: ${line.slice(4)}`));
      return;
    }
    const colon = line.indexOf(': ');
    this.pairs.push(colon < 0 ? [line, ''] : [line.slice(0, colon), line.slice(colon + 2)]);
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.greet?.reject(error);
    this.greet = null;
    for (const waiter of this.waiting.splice(0)) waiter.reject(error);
  }

  command(text: string): Promise<Array<[string, string]>> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.socket.write(`${text}\n`);
    });
  }

  // The reply's fields; for repeated keys the first one
  async fields(text: string): Promise<Fields> {
    const fields: Fields = new Map();
    for (const [key, value] of await this.command(text)) if (!fields.has(key)) fields.set(key, value);
    return fields;
  }

  close(): void {
    this.socket.destroy();
  }
}

export function quoteArgument(text: string): string {
  return `"${text.replace(/[\\"]/g, '\\$&')}"`;
}

const STATES: Record<string, PlaybackState> = { play: 'playing', pause: 'paused', stop: 'stopped' };

function seconds(value: string | undefined): number | undefined {
  const number = Number(value);
  return value !== undefined && Number.isFinite(number) && number > 0 ? Math.round(number * 1000) : undefined;
}

// The song as a track: MPD's tags, the file under the music directory (not for streams)
export function trackOf(song: Fields, musicDirectory: string | undefined): PlayingTrack | null {
  const file = song.get('file');
  if (!file) return null;
  const stream = /^[a-z][a-z0-9+.-]*:\/\//i.test(file);
  const local = stream ? undefined : path.isAbsolute(file) ? file : musicDirectory ? path.join(musicDirectory, file) : undefined;
  const album = song.get('Album');
  const durationMs = seconds(song.get('duration') ?? song.get('Time'));
  return {
    key: file,
    artist: song.get('Artist') ?? song.get('AlbumArtist') ?? '',
    title: song.get('Title') ?? (stream ? file : path.basename(file, path.extname(file))),
    ...(album ? { album } : {}),
    ...(durationMs ? { durationMs } : {}),
    ...(local ? { file: local } : {})
  };
}

export class MpdPlayer implements Player {
  readonly name = 'mpd';
  private options: MpdPlayerOptions;
  private now: () => number;
  private playback: Playback | null = null;
  private listeners = new Listeners<Playback | null>();
  private first = settle();
  private connection: MpdConnection | null = null;
  private stopped = false;
  private running: Promise<void> | null = null;
  private pause: { timer: NodeJS.Timeout; resolve: () => void } | null = null;
  private lastProblem: string | null = null;

  constructor(options: MpdPlayerOptions) {
    this.options = options;
    this.now = options.now ?? monotonic;
  }

  start(): void {
    this.running ??= this.run();
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

  private async run(): Promise<void> {
    const retry = this.options.retryMs ?? RETRY_MS;
    let failures = 0;
    while (!this.stopped) {
      try {
        const connection = await MpdConnection.open(this.options);
        this.connection = connection;
        if (this.stopped) break;
        if (this.options.password) await connection.command(`password ${quoteArgument(this.options.password)}`);
        failures = 0;
        this.lastProblem = null;
        await this.refresh(connection);
        this.first.resolve();
        while (!this.stopped) {
          await connection.command('idle player');
          await this.refresh(connection);
        }
      } catch (error) {
        if (this.stopped) break;
        this.lastProblem = error instanceof Error ? error.message : String(error);
        this.update(null);
        this.first.resolve();
        await this.wait(retry[Math.min(failures, retry.length - 1)]);
        failures++;
      } finally {
        this.connection?.close();
        this.connection = null;
      }
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise(resolve => {
      this.pause = { timer: setTimeout(() => { this.pause = null; resolve(); }, ms), resolve };
    });
  }

  private async refresh(connection: MpdConnection): Promise<void> {
    const status = await connection.fields('status');
    const state = STATES[status.get('state') ?? ''] ?? 'stopped';
    const song = state === 'stopped' ? new Map<string, string>() : await connection.fields('currentsong');
    const track = trackOf(song, this.options.musicDirectory);
    const durationMs = seconds(status.get('duration'));
    const now = this.now();
    const previous = this.playback;
    const changed = !previous || previous.state !== state || previous.track?.key !== track?.key;
    this.update({
      player: this.name,
      state,
      track: track && durationMs ? { ...track, durationMs } : track,
      positionMs: Math.round(Number(status.get('elapsed') ?? 0) * 1000),
      at: now,
      rate: 1,
      changedAt: changed ? now : previous.changedAt
    });
  }

  private update(playback: Playback | null): void {
    if (playback === null && this.playback === null) return;
    this.playback = playback;
    this.listeners.emit(playback);
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.connection?.close();
    if (this.pause) {
      clearTimeout(this.pause.timer);
      this.pause.resolve();
    }
    this.first.resolve();
    await this.running;
  }
}
