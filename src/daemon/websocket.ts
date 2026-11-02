import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Listeners } from '../players/types.ts';

// The server side of WebSocket (RFC 6455), as much as sleeved needs: text messages either way, fragmented ones
// reassembled, ping and pong, the close handshake, a size limit, and a ping on an interval to find clients that
// went away. No extensions (no permessage-deflate: messages are small and local, and compression only adds
// latency) and no subprotocols. Written here rather than taken from ws so the daemon owns its framing, timing
// and limits and has no dependency for it; Node's built-in WebSocket client talks to it in the tests.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  unsupported: 1003,
  invalidData: 1007,
  tooBig: 1009
} as const;

export interface WebSocketOptions {
  // Largest message accepted, reassembled (bytes)
  maxMessageBytes?: number;
  // How often to ping; a client that has not answered the previous ping by the next one is dropped. 0: never.
  pingMs?: number;
  // A client that leaves more than this unread is dropped rather than buffered for without end (bytes)
  maxBufferedBytes?: number;
}

export function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

// Why an upgrade request is not a WebSocket handshake this server takes, or null when it is
export function handshakeProblem(request: IncomingMessage): string | null {
  if (request.method !== 'GET') return 'not a GET';
  if ((request.headers.upgrade ?? '').toLowerCase() !== 'websocket') return 'not a WebSocket upgrade';
  const connection = (request.headers.connection ?? '').toLowerCase().split(',').map(token => token.trim());
  if (!connection.includes('upgrade')) return 'Connection has no upgrade';
  if (request.headers['sec-websocket-version'] !== '13') return 'not WebSocket version 13';
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) return 'no valid Sec-WebSocket-Key';
  return null;
}

// Refuses an upgrade with a plain HTTP status
export function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  const body = `${reason}\n`;
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

// A frame header and payload, unmasked (servers never mask)
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const header = length < 126 ? Buffer.alloc(2) : length < 65_536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  if (length < 126) header[1] = length;
  else if (length < 65_536) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

export class WebSocketConnection {
  private socket: Duplex;
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmenting = false;
  private closing = false;
  private closed = false;
  private awaitingPong = false;
  private pinger: NodeJS.Timeout | null = null;
  private maxMessageBytes: number;
  private maxBufferedBytes: number;
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private messages = new Listeners<string>();
  private closes = new Listeners<{ code: number; reason: string }>();

  // head: what arrived with the handshake. Reading starts on the next turn, once the caller has added its
  // listeners, and head is read first.
  constructor(socket: Duplex, { maxMessageBytes = 1 << 20, pingMs = 30_000, maxBufferedBytes = 8 << 20 }: WebSocketOptions = {}, head: Buffer = Buffer.alloc(0)) {
    this.socket = socket;
    this.maxMessageBytes = maxMessageBytes;
    this.maxBufferedBytes = maxBufferedBytes;
    setImmediate(() => {
      if (head.length) this.receive(head);
      socket.on('data', (chunk: Buffer) => this.receive(chunk));
    });
    socket.on('close', () => this.finish(CLOSE.goingAway, 'connection lost'));
    socket.on('error', () => socket.destroy());
    if (pingMs > 0) {
      this.pinger = setInterval(() => {
        if (this.awaitingPong) {
          socket.destroy();
          return;
        }
        this.awaitingPong = true;
        this.write(OP.ping, Buffer.alloc(0));
      }, pingMs);
      this.pinger.unref();
    }
  }

  get open(): boolean {
    return !this.closing && !this.closed;
  }

  onMessage(listener: (text: string) => void): () => void {
    return this.messages.add(listener);
  }

  onClose(listener: (event: { code: number; reason: string }) => void): () => void {
    return this.closes.add(listener);
  }

  send(text: string): void {
    if (this.open) this.write(OP.text, Buffer.from(text, 'utf8'));
  }

  // Starts the close handshake; the socket ends when the client answers, or after a second at most
  close(code: number = CLOSE.normal, reason = ''): void {
    if (!this.open) return;
    this.closing = true;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2, 'utf8');
    this.write(OP.close, payload);
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }

  private write(opcode: number, payload: Buffer): void {
    if (this.socket.destroyed) return;
    if (this.socket.writableLength > this.maxBufferedBytes) {
      this.socket.destroy();
      return;
    }
    this.socket.write(encodeFrame(opcode, payload));
  }

  private fail(code: number, reason: string): void {
    this.close(code, reason);
    this.buffer = Buffer.alloc(0);
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pinger) clearInterval(this.pinger);
    this.closes.emit({ code, reason });
  }

  private receive(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (!this.closed && !this.socket.destroyed) {
      const frame = this.nextFrame();
      if (!frame) return;
      this.handle(frame.fin, frame.opcode, frame.payload);
    }
  }

  // The next whole frame in the buffer, unmasked, or null until more arrives
  private nextFrame(): { fin: boolean; opcode: number; payload: Buffer } | null {
    const data = this.buffer;
    if (data.length < 2) return null;
    const fin = (data[0] & 0x80) !== 0;
    if (data[0] & 0x70) {
      this.fail(CLOSE.protocolError, 'reserved bits set');
      return null;
    }
    const opcode = data[0] & 0x0f;
    const masked = (data[1] & 0x80) !== 0;
    if (!masked) {
      this.fail(CLOSE.protocolError, 'client frames must be masked');
      return null;
    }
    let length = data[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (data.length < 4) return null;
      length = data.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (data.length < 10) return null;
      const long = data.readBigUInt64BE(2);
      if (long > BigInt(this.maxMessageBytes)) {
        this.fail(CLOSE.tooBig, 'message too big');
        return null;
      }
      length = Number(long);
      offset = 10;
    }
    if (length > this.maxMessageBytes) {
      this.fail(CLOSE.tooBig, 'message too big');
      return null;
    }
    if (data.length < offset + 4 + length) return null;
    const mask = data.subarray(offset, offset + 4);
    const payload = Buffer.from(data.subarray(offset + 4, offset + 4 + length));
    for (let at = 0; at < payload.length; at++) payload[at] ^= mask[at & 3];
    this.buffer = data.subarray(offset + 4 + length);
    return { fin, opcode, payload };
  }

  private handle(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode >= 0x8) {
      if (!fin || payload.length > 125) return this.fail(CLOSE.protocolError, 'invalid control frame');
      if (opcode === OP.ping) this.write(OP.pong, payload);
      else if (opcode === OP.pong) this.awaitingPong = false;
      else if (opcode === OP.close) this.answerClose(payload);
      else this.fail(CLOSE.protocolError, `unknown opcode ${opcode}`);
      return;
    }
    if (opcode === OP.binary) return this.fail(CLOSE.unsupported, 'text messages only');
    if (opcode === OP.text) {
      if (this.fragmenting) return this.fail(CLOSE.protocolError, 'new message inside a fragmented one');
    } else if (opcode === OP.continuation) {
      if (!this.fragmenting) return this.fail(CLOSE.protocolError, 'continuation without a message');
    } else {
      return this.fail(CLOSE.protocolError, `unknown opcode ${opcode}`);
    }
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > this.maxMessageBytes) return this.fail(CLOSE.tooBig, 'message too big');
    this.fragments.push(payload);
    this.fragmenting = !fin;
    if (!fin) return;
    const whole = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
    this.fragments = [];
    this.fragmentBytes = 0;
    let text: string;
    try {
      text = this.decoder.decode(whole);
    } catch {
      return this.fail(CLOSE.invalidData, 'invalid UTF-8');
    }
    if (this.open) this.messages.emit(text);
  }

  private answerClose(payload: Buffer): void {
    const code = payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE.normal;
    const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
    if (!this.closing) {
      this.closing = true;
      this.write(OP.close, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
    }
    this.socket.end();
    this.finish(code, reason);
  }
}

// Completes the handshake for an upgrade request already checked with handshakeProblem
export function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, options: WebSocketOptions = {}): WebSocketConnection {
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(request.headers['sec-websocket-key'] as string)}`,
    '', ''
  ].join('\r\n'));
  if ('setNoDelay' in socket && typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
  return new WebSocketConnection(socket, options, head);
}
