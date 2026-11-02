import { SleeveDaemon } from '../daemon/server.ts';
import { DEFAULT_HOST, DEFAULT_PORT, defaultSocketPath } from '../daemon/paths.ts';
import type { Io } from './lyrics.ts';
import { openSession, type SessionCliOptions, type SessionDeps } from './session.ts';

// `sleeve daemon` (also installed as `sleeved`): the NowPlaying session served over a WebSocket and a Unix socket
// until SIGINT or SIGTERM. Logs go to stderr, which the systemd unit hands to the journal.

export interface DaemonCommandOptions extends SessionCliOptions {
  host?: string;
  // commander's --no-websocket and --no-socket set these false
  port?: string;
  websocket?: boolean;
  socket?: string | boolean;
  allowOrigin?: string[];
}

export interface DaemonDeps extends SessionDeps {
  // Resolves when the daemon should stop; signals by default
  stop?: Promise<void>;
  // Called once it listens, with where
  listening?: (daemon: SleeveDaemon) => void;
}

function parsePort(text: string): number {
  const port = Number(text);
  if (!/^\d+$/.test(text) || port > 65_535) throw new Error(`Invalid port: ${text}`);
  return port;
}

function signalled(): Promise<void> {
  return new Promise(resolve => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

export async function daemonCommand(options: DaemonCommandOptions, io: Io, deps: DaemonDeps = {}): Promise<number> {
  const port = options.websocket === false ? null : options.port ? parsePort(options.port) : DEFAULT_PORT;
  const socketPath = options.socket === false ? null : typeof options.socket === 'string' ? options.socket : defaultSocketPath(deps.env);
  if (port === null && socketPath === null) throw new Error('Nothing to listen on: leave the WebSocket or the socket on');
  const stop = deps.stop ?? signalled();
  const { session, hub, close } = await openSession(options, io, deps);
  for (const { player, problem } of hub.problems()) io.err(`${player}: ${problem}`);
  const daemon = new SleeveDaemon(session, {
    host: options.host ?? DEFAULT_HOST,
    port,
    socketPath,
    allowOrigins: options.allowOrigin ?? [],
    problems: () => hub.problems(),
    log: text => io.err(text)
  });
  try {
    await daemon.listen();
    deps.listening?.(daemon);
    await stop;
    io.err('stopping');
    return 0;
  } finally {
    await daemon.close();
    await close();
  }
}
