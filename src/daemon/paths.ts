import os from 'node:os';
import path from 'node:path';

// Where sleeved listens: a Unix socket in the user's runtime directory (scripts, `sleeve now`) and a WebSocket on
// localhost (the browser renderer and the Electron shell).

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 6620;
export const WEBSOCKET_PATH = '/ws';

export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const runtime = env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `sleeve-${os.userInfo().uid}`);
  return path.join(runtime, 'sleeve', 'sleeved.sock');
}
