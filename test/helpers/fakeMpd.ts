import net from 'node:net';

// A stand-in MPD server on a random local port: answers status, currentsong and playlistid from `state`, holds `idle`
// until change() is called, and records every command. drop() closes the open connections, as MPD restarting
// would.

export interface FakeMpdState {
  status: Record<string, string>;
  song: Record<string, string>;
  // Songs by id, for playlistid
  queue?: Record<string, Record<string, string>>;
}

export interface FakeMpd {
  port: number;
  state: FakeMpdState;
  commands: string[];
  // Resolves once a client waits in idle
  idling(): Promise<void>;
  change(): void;
  drop(): void;
  close(): Promise<void>;
}

export async function fakeMpd(state: FakeMpdState, { password }: { password?: string } = {}): Promise<FakeMpd> {
  const commands: string[] = [];
  const sockets = new Set<net.Socket>();
  const idlers = new Set<net.Socket>();
  const reply = (fields: Record<string, string>) => `${Object.entries(fields).map(([key, value]) => `${key}: ${value}\n`).join('')}OK\n`;

  const server = net.createServer(socket => {
    sockets.add(socket);
    let authorized = !password;
    let buffer = '';
    socket.on('close', () => { sockets.delete(socket); idlers.delete(socket); });
    socket.on('error', () => {});
    socket.write('OK MPD 0.25.0\n');
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const command = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        commands.push(command);
        if (command.startsWith('password ')) {
          authorized = command === `password "${password?.replace(/[\\"]/g, '\\$&')}"`;
          socket.write(authorized ? 'OK\n' : 'ACK [3@0] {password} incorrect password\n');
        } else if (!authorized) socket.write('ACK [4@0] {status} you don\'t have permission for "status"\n');
        else if (command === 'status') socket.write(reply(state.status));
        else if (command === 'currentsong') socket.write(reply(state.song));
        else if (command.startsWith('idle')) idlers.add(socket);
        else if (/^playlistid \d+$/.test(command)) {
          const song = state.queue?.[command.slice('playlistid '.length)];
          socket.write(song ? reply(song) : 'ACK [50@0] {playlistid} No such song\n');
        }
        else socket.write(`ACK [5@0] {} unknown command "${command}"\n`);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

  return {
    port: (server.address() as net.AddressInfo).port,
    state,
    commands,
    idling() {
      return until(() => idlers.size > 0);
    },
    change() {
      for (const socket of idlers) socket.write('changed: player\nOK\n');
      idlers.clear();
    },
    drop() {
      for (const socket of sockets) socket.destroy();
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise(resolve => server.close(() => resolve()));
    }
  };
}

// Resolves once check() holds, polling briefly; fails the test after timeoutMs
export async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
