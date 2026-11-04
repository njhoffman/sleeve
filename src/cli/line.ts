import { DaemonClient } from '../daemon/client.ts';
import { defaultSocketPath } from '../daemon/paths.ts';
import type { Io } from './lyrics.ts';

// `sleeve line`: the line playing, printed each time it changes, for status bars. An empty line stands for no line
// (between tracks, an instrumental break, no lyrics); --between gives other text for the track having synced lyrics
// with no line playing yet or right now, so a bar can tell that from having no lyrics at all. A bar starts before sleeved as easily as after it, and sleeved
// restarts, so it waits for sleeved and comes back to it rather than exiting; only a signal ends it.

export const RECONNECT_MS = 2000;

export interface LineOptions {
  socket?: string;
  between?: string;
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
  const between = options.between ?? '';
  const print = (text: string) => {
    if (text === last) return;
    last = text;
    io.out(text);
  };
  while (!signal.aborted) {
    const client = await DaemonClient.connect(socketPath);
    if (client) {
      told = false;
      let line = '';
      await new Promise<void>(resolve => {
        client.onMessage(message => {
          if (message.type === 'line') line = message.line.text?.trim() ? message.line.text : '';
          // Lyrics arriving change nothing about the line before the first one, but do what is shown for it
          if (message.type === 'line' || message.type === 'lyrics') print(line || (client.mirror.current().result?.best?.lyrics.synced ? between : ''));
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
