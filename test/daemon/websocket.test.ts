import { expect } from 'chai';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { acceptKey, CLOSE, encodeFrame, handshakeProblem, refuseUpgrade, upgrade, type WebSocketConnection, type WebSocketOptions } from '../../src/daemon/websocket.ts';
import { until } from '../helpers/fakeMpd.ts';
import { rawClient, wsClient } from '../helpers/ws.ts';

// An echo server over the WebSocket implementation, keeping what it received and how each connection closed
async function echoServer(options: WebSocketOptions = {}) {
  const received: string[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const connections: WebSocketConnection[] = [];
  const server: Server = createServer((_request, response) => response.writeHead(404).end());
  server.on('upgrade', (request, socket: Socket, head: Buffer) => {
    const problem = handshakeProblem(request);
    if (problem) return refuseUpgrade(socket, 400, 'Bad Request');
    const connection = upgrade(request, socket, head, options);
    connections.push(connection);
    connection.onMessage(text => {
      received.push(text);
      connection.send(`echo:${text}`);
    });
    connection.onClose(event => closes.push(event));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port, received, closes, connections,
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

describe('WebSocket server', () => {
  let echo: Awaited<ReturnType<typeof echoServer>>;
  afterEach(async () => { await echo?.close(); });

  it('computes the accept key as RFC 6455 does', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).to.equal('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('encodes the three payload length forms', () => {
    expect([...encodeFrame(1, Buffer.from('hi'))]).to.deep.equal([0x81, 2, 0x68, 0x69]);
    const medium = encodeFrame(1, Buffer.alloc(300));
    expect([medium[1], medium.readUInt16BE(2), medium.length]).to.deep.equal([126, 300, 304]);
    const large = encodeFrame(1, Buffer.alloc(70_000));
    expect([large[1], Number(large.readBigUInt64BE(2)), large.length]).to.deep.equal([127, 70_000, 70_010]);
  });

  it('talks to Node\'s own WebSocket client, both ways, small and large messages', async () => {
    echo = await echoServer();
    const client = await wsClient(`ws://127.0.0.1:${echo.port}/`);
    const replies: string[] = [];
    client.socket.addEventListener('message', event => replies.push(String(event.data)));
    client.socket.send('hello');
    const big = 'x'.repeat(100_000);
    client.socket.send(big);
    client.socket.send('héllo ✓');
    await until(() => replies.length === 3);
    expect(replies).to.deep.equal(['echo:hello', `echo:${big}`, 'echo:héllo ✓']);
    client.close();
    await until(() => echo.closes.length === 1);
    expect(echo.closes[0].code).to.equal(CLOSE.normal);
  });

  it('reassembles fragmented messages, answers pings, and reads what came with the handshake', async () => {
    echo = await echoServer();
    const raw = await rawClient(echo.port);
    expect(raw.response).to.match(/^HTTP\/1\.1 101/);
    raw.write(1, 'frag', { fin: false });
    raw.write(9, 'are you there');
    raw.write(0, 'mented', { fin: false });
    raw.write(0, '!');
    await until(() => raw.frames.length === 2);
    expect(raw.frames.map(item => [item.opcode, item.payload.toString()])).to.deep.equal([[0xa, 'are you there'], [1, 'echo:fragmented!']]);
    raw.write(8, Buffer.from([0x03, 0xe8]));
    await until(() => raw.ended);
    expect(raw.frames.at(-1)!.opcode).to.equal(8);
    expect(echo.closes).to.deep.equal([{ code: 1000, reason: '' }]);
  });

  it('closes with 1002 on unmasked frames, reserved bits and stray continuations', async () => {
    echo = await echoServer();
    for (const send of [
      (raw: Awaited<ReturnType<typeof rawClient>>) => raw.write(1, 'x', { mask: false }),
      (raw: Awaited<ReturnType<typeof rawClient>>) => raw.write(1, 'x', { rsv: 0x40 }),
      (raw: Awaited<ReturnType<typeof rawClient>>) => raw.write(0, 'x')
    ]) {
      const raw = await rawClient(echo.port);
      send(raw);
      await until(() => raw.frames.some(item => item.opcode === 8));
      expect(raw.frames.find(item => item.opcode === 8)!.payload.readUInt16BE(0)).to.equal(CLOSE.protocolError);
      raw.socket.destroy();
    }
    expect(echo.received).to.deep.equal([]);
  });

  it('refuses binary messages, invalid UTF-8 and messages over the limit', async () => {
    echo = await echoServer({ maxMessageBytes: 10 });
    const cases: Array<[number, Buffer | string, number, { fin?: boolean }?]> = [
      [2, 'bin', CLOSE.unsupported],
      [1, Buffer.from([0xc3, 0x28]), CLOSE.invalidData],
      [1, 'x'.repeat(11), CLOSE.tooBig],
      [1, 'x'.repeat(8), CLOSE.tooBig, { fin: false }]
    ];
    for (const [opcode, payload, code, options] of cases) {
      const raw = await rawClient(echo.port);
      raw.write(opcode, payload, options);
      // A fragmented message is over the limit only once its pieces add up
      if (options?.fin === false) raw.write(0, 'xxx');
      await until(() => raw.frames.some(item => item.opcode === 8));
      expect(raw.frames.find(item => item.opcode === 8)!.payload.readUInt16BE(0)).to.equal(code);
      raw.socket.destroy();
    }
  });

  it('refuses requests that are not a version 13 handshake', async () => {
    echo = await echoServer();
    const raw = await rawClient(echo.port, { key: 'short' });
    expect(raw.response).to.match(/^HTTP\/1\.1 400/);
  });

  it('drops a client that does not answer pings', async () => {
    echo = await echoServer({ pingMs: 20 });
    const raw = await rawClient(echo.port);
    // Pongs are never written back, so the second ping finds the first unanswered
    await until(() => raw.ended);
    expect(raw.frames.filter(item => item.opcode === 9)).to.have.length(1);
    expect(echo.closes).to.have.length(1);
  });
});
