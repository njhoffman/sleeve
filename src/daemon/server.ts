import { mkdirSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { connect, createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import path from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { formatRef, parseRef } from '../core/prefs.ts';
import type { NowPlaying } from '../now/session.ts';
import type { NowState } from '../now/state.ts';
import { nextLineTime } from '../now/lines.ts';
import { monotonic, positionAt } from '../players/clock.ts';
import type { Playback } from '../players/types.ts';
import {
  parseCommand, PROTOCOL_VERSION, type ClientCommand, type LyricsMessage, type PlayerProblem, type ReplyMessage,
  type ServerMessage, type WireLine, type WirePlayback
} from '../protocol/messages.ts';
import { DEFAULT_HOST, DEFAULT_PORT, defaultSocketPath, WEBSOCKET_PATH } from './paths.ts';
import { StaticFiles } from './static.ts';
import { CLOSE, handshakeProblem, refuseUpgrade, upgrade, type WebSocketOptions } from './websocket.ts';

// sleeved: one NowPlaying session served to any number of clients, over a WebSocket on localhost (browsers,
// Electron) and a Unix socket carrying one JSON message per line (scripts, `sleeve now`). Each client is sent
// hello, then the playback, lyrics and players messages, then every change as it happens; see
// src/protocol/messages.ts and docs/protocol.md.

export type DaemonSession = Pick<NowPlaying, 'current' | 'onChange' | 'line' | 'position' | 'nudge' | 'setOffset' | 'pick' | 'unpick' | 'refresh' | 'candidates'>;

export interface DaemonOptions {
  host?: string;
  // 0 picks a free port; null leaves the WebSocket out
  port?: number | null;
  // null leaves the Unix socket out
  socketPath?: string | null;
  // Origins allowed besides localhost pages and file://; '*' allows any
  allowOrigins?: string[];
  websocket?: WebSocketOptions;
  // The renderer's files, served at /; null leaves them out
  renderer?: StaticFiles | null;
  // Where player problems are read from, checked on every change and every few seconds
  problems?: () => PlayerProblem[];
  log?: (text: string) => void;
  wall?: () => number;
  monotonic?: () => number;
}

interface Client {
  id: number;
  label: string;
  lines: boolean;
  lastLine: string | null;
  send(message: ServerMessage): void;
  close(): void;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const MAX_LINE_BYTES = 1 << 20;
const MAX_BUFFERED_BYTES = 8 << 20;
const PROBLEM_CHECK_MS = 5000;
// sun_path holds 108 bytes on Linux, the terminating NUL included
const MAX_SOCKET_PATH = 107;

// Whether a browser page from this Origin may connect. Pages on other sites must not: they could nudge and pick
// for the user, and DNS rebinding makes "it only listens on localhost" no defense on its own.
export function originAllowed(origin: string | undefined, allowed: string[] = []): boolean {
  if (origin === undefined) return true;
  if (allowed.includes('*') || allowed.includes(origin)) return true;
  if (origin === 'file://') return true;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function trackKey(playback: Playback | null): string | null {
  return playback?.track ? `${playback.player}:${playback.track.key}` : null;
}

export class SleeveDaemon {
  private session: DaemonSession;
  private options: DaemonOptions;
  private clients = new Set<Client>();
  private nextId = 1;
  private last: NowState;
  private lastProblems = '[]';
  private lineTimer: NodeJS.Timeout | null = null;
  private problemTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private http: HttpServer | null = null;
  private unix: NetServer | null = null;
  private sockets = new Set<Socket>();
  private wall: () => number;
  private monotonic: () => number;
  port: number | null = null;
  socketPath: string | null = null;

  constructor(session: DaemonSession, options: DaemonOptions = {}) {
    this.session = session;
    this.options = options;
    this.last = session.current();
    this.wall = options.wall ?? Date.now;
    this.monotonic = options.monotonic ?? monotonic;
  }

  private log(text: string): void {
    this.options.log?.(text);
  }

  async listen(): Promise<void> {
    this.unsubscribe = this.session.onChange(state => this.changed(state));
    this.last = this.session.current();
    if (this.last.playback?.track) this.logTrack(this.last);
    this.lastProblems = JSON.stringify(this.problems());
    this.problemTimer = setInterval(() => this.checkProblems(), PROBLEM_CHECK_MS);
    this.problemTimer.unref();
    try {
      if (this.options.socketPath !== null) await this.listenUnix(this.options.socketPath ?? defaultSocketPath());
      if (this.options.port !== null) await this.listenWebSocket();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  // Messages

  private problems(): PlayerProblem[] {
    return this.options.problems?.() ?? [];
  }

  private wirePlayback(playback: Playback | null): WirePlayback | null {
    if (!playback) return null;
    return {
      player: playback.player,
      state: playback.state,
      track: playback.track,
      positionMs: Math.round(positionAt(playback, this.monotonic())),
      at: this.wall(),
      rate: playback.rate
    };
  }

  private lyricsMessage(state: NowState): LyricsMessage {
    return { type: 'lyrics', key: trackKey(state.playback), query: state.query, loading: state.loading, error: state.error, result: state.result };
  }

  private currentLine(): WireLine {
    const line = this.session.line(this.monotonic());
    return { index: line.index, text: line.line?.text ?? null, timeMs: line.time };
  }

  private snapshot(client: Client): void {
    const state = this.session.current();
    client.send({ type: 'playback', playback: this.wirePlayback(state.playback) });
    client.send(this.lyricsMessage(state));
    client.send({ type: 'players', problems: this.problems() });
    if (client.lines) this.sendLine(client, true);
  }

  private broadcast(message: ServerMessage): void {
    for (const client of this.clients) client.send(message);
  }

  // What changed since the last state: the playback, the lookup, or only the offset
  private changed(state: NowState): void {
    const last = this.last;
    this.last = state;
    if (state.playback !== last.playback) this.broadcast({ type: 'playback', playback: this.wirePlayback(state.playback) });
    const sameTrack = trackKey(state.playback) === trackKey(last.playback);
    const sameLookup = sameTrack && state.query === last.query && state.loading === last.loading && state.error === last.error;
    if (!sameLookup || state.result !== last.result) {
      const before = last.result, after = state.result;
      const offsetOnly = sameLookup && before && after && before.best === after.best && before.candidates === after.candidates
        && before.rejected === after.rejected && before.errors === after.errors && before.pinned === after.pinned;
      this.broadcast(offsetOnly ? { type: 'offset', offsetMs: after.offsetMs } : this.lyricsMessage(state));
      if (!sameTrack) this.logTrack(state);
    }
    if (!state.loading && last.loading && sameTrack) this.logLookup(state);
    this.checkProblems();
    this.scheduleLines();
  }

  private logTrack(state: NowState): void {
    const track = state.playback?.track;
    this.log(track ? `track: ${track.artist ? `${track.artist} - ` : ''}${track.title} [${state.playback!.player}]` : 'track: nothing playing');
  }

  private logLookup(state: NowState): void {
    const best = state.result?.best;
    if (state.error) this.log(`lyrics: lookup failed: ${state.error}`);
    else if (!state.query) this.log('lyrics: no artist or title to look up');
    else this.log(best ? `lyrics: ${formatRef(best)}${best.lyrics.synced ? ', synced' : ''}${state.result!.pinned ? ', pinned' : ''}` : 'lyrics: none found');
  }

  private checkProblems(): void {
    const problems = this.problems();
    const text = JSON.stringify(problems);
    if (text === this.lastProblems) return;
    this.lastProblems = text;
    this.broadcast({ type: 'players', problems });
  }

  // Lines, for subscribers: sent when the line playing changes, by a timer set for the next line's start rather
  // than a poll

  private sendLine(client: Client, always = false): void {
    const line = this.currentLine();
    const key = trackKey(this.session.current().playback);
    const id = `${key}#${line.index}#${line.timeMs}`;
    if (!always && id === client.lastLine) return;
    client.lastLine = id;
    client.send({ type: 'line', key, line });
  }

  private scheduleLines(): void {
    if (this.lineTimer) clearTimeout(this.lineTimer);
    this.lineTimer = null;
    const subscribers = [...this.clients].filter(client => client.lines);
    if (!subscribers.length) return;
    for (const client of subscribers) this.sendLine(client);
    const state = this.session.current();
    const playback = state.playback;
    if (!playback || playback.state !== 'playing' || playback.rate <= 0 || state.loading) return;
    const position = this.session.position(this.monotonic());
    const next = nextLineTime(state.result, position);
    if (next === null) return;
    const delay = Math.max(0, Math.ceil((next - position) / playback.rate));
    this.lineTimer = setTimeout(() => this.scheduleLines(), delay);
  }

  // Commands

  private async run(client: Client, command: ClientCommand): Promise<Omit<ReplyMessage, 'type' | 'id' | 'ok'>> {
    switch (command.type) {
      case 'nudge':
      case 'offset': {
        const offsetMs = command.type === 'nudge' ? this.session.nudge(command.ms) : this.session.setOffset(command.ms);
        if (offsetMs === null) throw new Error(this.session.current().loading ? 'Still looking up lyrics' : 'No lyrics to move');
        return { data: { offsetMs } };
      }
      case 'pick': {
        const ref = parseRef(command.ref);
        if (!ref) throw new Error(`Invalid candidate: ${command.ref} (use provider:id)`);
        const candidate = await this.session.pick(ref);
        this.log(`pick: ${formatRef(candidate)}`);
        return { data: { ref: formatRef(candidate) } };
      }
      case 'unpick': {
        const removed = await this.session.unpick();
        if (removed) this.log('pick: removed');
        return { data: { removed } };
      }
      case 'refresh':
        await this.session.refresh();
        return {};
      case 'candidates':
        return { data: await this.session.candidates() };
      case 'state':
        this.snapshot(client);
        return {};
      case 'subscribe':
        client.lines = command.lines;
        client.lastLine = null;
        this.scheduleLines();
        return {};
    }
  }

  private async receive(client: Client, text: string): Promise<void> {
    const parsed = parseCommand(text);
    if ('error' in parsed) {
      client.send({ type: 'reply', ...(parsed.id !== undefined ? { id: parsed.id } : {}), ok: false, error: parsed.error });
      return;
    }
    const { command } = parsed;
    const id = command.id !== undefined ? { id: command.id } : {};
    try {
      const reply = await this.run(client, command);
      client.send({ type: 'reply', ...id, ok: true, ...reply });
    } catch (error) {
      client.send({ type: 'reply', ...id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private add(label: string, send: (text: string) => void, close: () => void): Client {
    const client: Client = {
      id: this.nextId++, label, lines: false, lastLine: null,
      send: message => send(JSON.stringify(message)),
      close
    };
    this.clients.add(client);
    this.log(`client ${client.id} connected: ${label}`);
    client.send({ type: 'hello', protocol: PROTOCOL_VERSION, version: pkg.version });
    this.snapshot(client);
    return client;
  }

  private remove(client: Client): void {
    if (!this.clients.delete(client)) return;
    this.log(`client ${client.id} left`);
    if (client.lines) this.scheduleLines();
  }

  // Transports

  private async listenWebSocket(): Promise<void> {
    const files = this.options.renderer === null ? null : this.options.renderer ?? new StaticFiles();
    const server = createHttpServer(async (request, response) => {
      if (files && await files.serve(request, response)) return;
      response.writeHead(404, { 'Content-Type': 'text/plain' }).end(`sleeved ${pkg.version}: the renderer is at /, the WebSocket at ${WEBSOCKET_PATH}\n`);
    });
    server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
      socket.on('error', () => socket.destroy());
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== WEBSOCKET_PATH) return refuseUpgrade(socket, 404, 'Not Found');
      const problem = handshakeProblem(request);
      if (problem) return refuseUpgrade(socket, 400, 'Bad Request');
      const origin = request.headers.origin;
      if (!originAllowed(origin, this.options.allowOrigins)) {
        this.log(`refused a WebSocket from ${origin}`);
        return refuseUpgrade(socket, 403, 'Forbidden');
      }
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      const connection = upgrade(request, socket, head, this.options.websocket);
      const client = this.add(`WebSocket${origin ? ` from ${origin}` : ''}`, text => connection.send(text), () => connection.close(CLOSE.goingAway, 'sleeved stopping'));
      connection.onMessage(text => void this.receive(client, text));
      connection.onClose(() => this.remove(client));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? DEFAULT_PORT, this.options.host ?? DEFAULT_HOST, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.http = server;
    const address = server.address();
    this.port = typeof address === 'object' && address ? address.port : null;
    const base = `${this.options.host ?? DEFAULT_HOST}:${this.port}`;
    this.log(`listening on ws://${base}${WEBSOCKET_PATH}${files ? `, renderer at http://${base}/` : ''}`);
  }

  private async listenUnix(socketPath: string): Promise<void> {
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
      throw new Error(`Socket path too long for a Unix socket (${Buffer.byteLength(socketPath)} bytes, at most ${MAX_SOCKET_PATH}): ${socketPath}`);
    }
    mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    if (await answers(socketPath)) throw new Error(`sleeved is already running (${socketPath})`);
    rmSync(socketPath, { force: true });
    const server = createNetServer(socket => this.acceptUnix(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.unix = server;
    this.socketPath = socketPath;
    this.log(`listening on ${socketPath}`);
  }

  private acceptUnix(socket: Socket): void {
    this.sockets.add(socket);
    let pending = '';
    const send = (text: string) => {
      if (socket.destroyed) return;
      if (socket.writableLength > MAX_BUFFERED_BYTES) socket.destroy();
      else socket.write(`${text}\n`);
    };
    const client = this.add('Unix socket', send, () => socket.end());
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) void this.receive(client, line);
      }
      if (pending.length > MAX_LINE_BYTES) {
        client.send({ type: 'reply', ok: false, error: 'Line too long' });
        socket.end();
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.remove(client);
    });
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.lineTimer) clearTimeout(this.lineTimer);
    if (this.problemTimer) clearInterval(this.problemTimer);
    for (const client of [...this.clients]) client.close();
    this.clients.clear();
    const closing: Promise<void>[] = [];
    for (const server of [this.http, this.unix]) {
      if (server) closing.push(new Promise(resolve => server.close(() => resolve())));
    }
    // Clients that do not finish the close handshake promptly are cut off
    setTimeout(() => { for (const socket of this.sockets) socket.destroy(); }, 200).unref();
    await Promise.all(closing);
    this.http = this.unix = null;
    if (this.socketPath) rmSync(this.socketPath, { force: true });
  }
}

// Whether something answers on the Unix socket at socketPath
export function answers(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(socketPath);
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}
