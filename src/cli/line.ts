import { DaemonClient } from '../daemon/client.ts';
import { defaultSocketPath } from '../daemon/paths.ts';
import type { Io } from './lyrics.ts';

// `sleeve line`: the line playing, printed each time it changes, for status bars. An empty line stands for no line
// (between tracks, an instrumental break, no lyrics). A bar starts before sleeved as easily as after it, and sleeved
// restarts, so it waits for sleeved and comes back to it rather than exiting; only a signal ends it.

export const RECONNECT_MS = 2000;

export interface LineOptions {
  socket?: string;
}

export interface LineDeps {
  // Ends the command; the default is SIGINT or SIGTERM
  signal?: AbortSignal;
  reconnectMs?: number;
}

function signals(): AbortSignal {
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM'] as const) process.once(name, () => controller.abort());
  return controller.signal;
}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
});

export async function lineCommand(options: LineOptions, io: Io, { signal = signals(), reconnectMs = RECONNECT_MS }: LineDeps = {}): Promise<number> {
  const socketPath = options.socket ?? defaultSocketPath();
  let last: string | null = null;
  let told = false;
  const print = (text: string) => {
    if (text === last) return;
    last = text;
    io.out(text);
  };
  while (!signal.aborted) {
    const client = await DaemonClient.connect(socketPath);
    if (client) {
      told = false;
      await new Promise<void>(resolve => {
        client.onMessage(message => {
          if (message.type === 'line') print(message.line.text ?? '');
        });
        client.onClose(resolve);
        signal.addEventListener('abort', () => resolve(), { once: true });
        void client.send({ type: 'subscribe', lines: true });
      });
      client.close();
      // The line on the bar is no longer known to be playing
      if (last) print('');
    } else if (!told) {
      told = true;
      io.err(`Waiting for sleeved at ${socketPath}`);
    }
    if (!signal.aborted) await pause(reconnectMs, signal);
  }
  return 0;
}
