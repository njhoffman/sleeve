import { connect, type Socket } from 'node:net';
import { SessionMirror, type MirrorClocks } from '../protocol/mirror.ts';
import type { ClientCommand, ReplyMessage, ServerMessage } from '../protocol/messages.ts';
import { Listeners } from '../players/types.ts';
import { defaultSocketPath } from './paths.ts';

// A client of sleeved over its Unix socket: the session mirrored locally, and commands answered by their replies.

type Unsent<T> = T extends unknown ? Omit<T, 'id'> : never;

export class DaemonClient {
  readonly mirror: SessionMirror;
  readonly socketPath: string;
  private socket: Socket;
  private nextId = 1;
  private waiting = new Map<number, (reply: ReplyMessage) => void>();
  private messages = new Listeners<ServerMessage>();
  private closes = new Listeners<void>();
  private initial: Promise<void>;
  private closed = false;

  private constructor(socket: Socket, socketPath: string, clocks: MirrorClocks) {
    this.socket = socket;
    this.socketPath = socketPath;
    this.mirror = new SessionMirror(clocks);
    let pending = '';
    let resolveInitial!: () => void;
    let rejectInitial!: (error: Error) => void;
    this.initial = new Promise((resolve, reject) => { resolveInitial = resolve; rejectInitial = reject; });
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        let message: ServerMessage;
        try {
          message = JSON.parse(line) as ServerMessage;
        } catch {
          continue;
        }
        this.mirror.apply(message);
        // players is the last of what the daemon sends a client first
        if (message.type === 'players') resolveInitial();
        if (message.type === 'reply' && typeof message.id === 'number') {
          this.waiting.get(message.id)?.(message);
          this.waiting.delete(message.id);
        }
        this.messages.emit(message);
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      this.closed = true;
      rejectInitial(new Error('sleeved closed the connection'));
      for (const answer of this.waiting.values()) answer({ type: 'reply', ok: false, error: 'sleeved closed the connection' });
      this.waiting.clear();
      this.closes.emit();
    });
  }

  // Connects to the daemon; null when none answers at socketPath
  static async connect(socketPath: string = defaultSocketPath(), { timeoutMs = 1000, clocks = {} }: { timeoutMs?: number; clocks?: MirrorClocks } = {}): Promise<DaemonClient | null> {
    const socket = await new Promise<Socket | null>(resolve => {
      const socket = connect(socketPath);
      const timer = setTimeout(() => { socket.destroy(); resolve(null); }, timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
      socket.once('error', () => { clearTimeout(timer); resolve(null); });
    });
    if (!socket) return null;
    const client = new DaemonClient(socket, socketPath, clocks);
    const timer = setTimeout(() => socket.destroy(), timeoutMs);
    try {
      await client.initial;
      return client;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  get open(): boolean {
    return !this.closed;
  }

  onMessage(listener: (message: ServerMessage) => void): () => void {
    return this.messages.add(listener);
  }

  onClose(listener: () => void): () => void {
    return this.closes.add(listener);
  }

  send(command: Unsent<ClientCommand>): Promise<ReplyMessage> {
    if (this.closed) return Promise.resolve({ type: 'reply', ok: false, error: 'sleeved closed the connection' });
    const id = this.nextId++;
    return new Promise(resolve => {
      this.waiting.set(id, resolve);
      this.socket.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  close(): void {
    this.socket.end();
  }
}
