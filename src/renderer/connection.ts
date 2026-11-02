import { SessionMirror, type MirrorClocks } from '../protocol/mirror.ts';
import type { ClientCommand, ReplyMessage, ServerMessage } from '../protocol/messages.ts';
import { Listeners } from '../players/types.ts';
import { reconnectDelay } from './view.ts';

// The renderer's link to sleeved: a WebSocket that reconnects until closed, with the session mirrored and
// commands answered by their replies. Uses only the standard WebSocket, so it runs in a browser and in Node.

type Unsent<T> = T extends unknown ? Omit<T, 'id'> : never;

export class Connection {
  readonly mirror: SessionMirror;
  private url: string;
  private socket: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private nextId = 1;
  private waiting = new Map<number, (reply: ReplyMessage) => void>();
  private connectedListeners = new Listeners<boolean>();
  connected = false;

  constructor(url: string, clocks: MirrorClocks = {}) {
    this.url = url;
    this.mirror = new SessionMirror(clocks);
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  onConnected(listener: (connected: boolean) => void): () => void {
    return this.connectedListeners.add(listener);
  }

  private open(): void {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.addEventListener('message', event => this.receive(String(event.data)));
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const answer of this.waiting.values()) answer({ type: 'reply', ok: false, error: 'sleeved went away' });
      this.waiting.clear();
      if (this.connected) {
        this.connected = false;
        this.connectedListeners.emit(false);
      }
      if (this.stopped) return;
      this.timer = setTimeout(() => this.open(), reconnectDelay(this.attempt++));
    });
  }

  private receive(text: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }
    this.mirror.apply(message);
    // players ends the greeting: from here on the mirror holds the daemon's whole state
    if (message.type === 'players' && !this.connected) {
      this.connected = true;
      this.attempt = 0;
      this.connectedListeners.emit(true);
    }
    if (message.type === 'reply' && typeof message.id === 'number') {
      this.waiting.get(message.id)?.(message);
      this.waiting.delete(message.id);
    }
  }

  send(command: Unsent<ClientCommand>): Promise<ReplyMessage> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.resolve({ type: 'reply', ok: false, error: 'Not connected to sleeved' });
    const id = this.nextId++;
    return new Promise(resolve => {
      this.waiting.set(id, resolve);
      socket.send(JSON.stringify({ ...command, id }));
    });
  }

  close(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
  }
}
