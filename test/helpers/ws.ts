import { randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import type { ServerMessage } from '../../src/protocol/messages.ts';
import { until } from './fakeMpd.ts';

// WebSocket clients for tests: Node's built-in one, collecting messages, and a raw one that writes frames byte
// by byte, for what a well-behaved client never sends.

export interface TestClient {
  socket: WebSocket;
  messages: ServerMessage[];
  closed: { code: number; reason: string } | null;
  // Waits for a message the check accepts and takes it, dropping the ones before it
  next(check?: (message: ServerMessage) => boolean): Promise<ServerMessage>;
  send(value: unknown): void;
  close(): void;
}

export async function wsClient(url: string, options: { origin?: string } = {}): Promise<TestClient> {
  const headers = options.origin ? { headers: { origin: options.origin } } : undefined;
  const socket = new (WebSocket as unknown as new (url: string, options?: unknown) => WebSocket)(url, headers);
  const client: TestClient = {
    socket,
    messages: [],
    closed: null,
    async next(check = () => true) {
      let found: ServerMessage | undefined;
      await until(() => {
        const at = client.messages.findIndex(check);
        if (at < 0) return false;
        found = client.messages.splice(0, at + 1)[at];
        return true;
      });
      return found!;
    },
    send: value => socket.send(typeof value === 'string' ? value : JSON.stringify(value)),
    close: () => socket.close()
  };
  socket.addEventListener('message', event => {
    try {
      client.messages.push(JSON.parse(String(event.data)));
    } catch {
      // Not a protocol message (the echo server's); the test reads those itself
    }
  });
  socket.addEventListener('close', event => { client.closed = { code: event.code, reason: event.reason }; });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('WebSocket failed to open')));
  });
  return client;
}

export interface RawFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

export interface RawClient {
  socket: Socket;
  // The handshake response's status line and headers
  response: string;
  frames: RawFrame[];
  ended: boolean;
  write(opcode: number, payload: Buffer | string, options?: { fin?: boolean; mask?: boolean; rsv?: number }): void;
}

export function frame(opcode: number, payload: Buffer | string, { fin = true, mask = true, rsv = 0 } = {}): Buffer {
  const data = Buffer.from(payload);
  const length = data.length;
  const header = [((fin ? 0x80 : 0) | rsv | opcode)];
  const maskBit = mask ? 0x80 : 0;
  if (length < 126) header.push(maskBit | length);
  else if (length < 65_536) header.push(maskBit | 126, length >> 8, length & 0xff);
  else {
    const big = Buffer.alloc(8);
    big.writeBigUInt64BE(BigInt(length));
    header.push(maskBit | 127, ...big);
  }
  if (!mask) return Buffer.concat([Buffer.from(header), data]);
  const key = randomBytes(4);
  const masked = Buffer.from(data);
  for (let at = 0; at < masked.length; at++) masked[at] ^= key[at & 3];
  return Buffer.concat([Buffer.from(header), key, masked]);
}

function parseFrames(buffer: Buffer, frames: RawFrame[]): Buffer {
  let data = buffer;
  while (data.length >= 2) {
    let length = data[1] & 0x7f;
    let offset = 2;
    if (length === 126) { if (data.length < 4) break; length = data.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (data.length < 10) break; length = Number(data.readBigUInt64BE(2)); offset = 10; }
    if (data.length < offset + length) break;
    frames.push({ fin: (data[0] & 0x80) !== 0, opcode: data[0] & 0x0f, payload: data.subarray(offset, offset + length) });
    data = data.subarray(offset + length);
  }
  return data;
}

export async function rawClient(port: number, { path = '/ws', headers = {} as Record<string, string>, key = randomBytes(16).toString('base64') } = {}): Promise<RawClient> {
  const socket = connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const lines = [
    `GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13',
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), '', ''
  ];
  const client: RawClient = {
    socket, response: '', frames: [], ended: false,
    write: (opcode, payload, options) => socket.write(frame(opcode, payload, options))
  };
  let pending: Buffer = Buffer.alloc(0);
  let headerDone = false;
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    if (!headerDone) {
      const end = pending.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.response = pending.subarray(0, end).toString();
      pending = pending.subarray(end + 4);
      headerDone = true;
    }
    pending = parseFrames(pending, client.frames);
  });
  socket.on('close', () => { client.ended = true; });
  socket.on('error', () => {});
  socket.write(lines.join('\r\n'));
  await until(() => headerDone || client.ended);
  return client;
}
