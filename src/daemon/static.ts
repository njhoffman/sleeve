import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// The renderer, served by sleeved from the sources as they are: `/` is src/renderer/index.html, and `/src/...`
// the browser-safe sources it imports. TypeScript is turned into JavaScript on request with Node's own type
// stripping (the same erasable-only TypeScript Node runs, so no build step), cached until the file changes.
// Only the directories and files below are served; the rest of src/ (Node code) never is.

export const SOURCE_ROOT = path.resolve(import.meta.dirname, '..');

const SERVED = ['renderer/', 'protocol/', 'now/lines.ts', 'now/state.ts', 'players/clock.ts', 'players/types.ts', 'core/types.ts'];

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

// The user's own stylesheet, loaded by the page after sleeve's (src/renderer/style.css lists what it can set): served at
// /user.css, empty when there is none
export const USER_CSS_PATH = '/user.css';

export function userStylesheet(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'sleeve', 'style.css');
}

// The page's own code and sleeved's socket only
const POLICY = "default-src 'self'; connect-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'";

// The file under root a URL path names, or null when it is not one that is served
export function sourceFor(urlPath: string, root: string = SOURCE_ROOT): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded === '/' || decoded === '/index.html') return path.join(root, 'renderer', 'index.html');
  if (!decoded.startsWith('/src/') || decoded.includes('\0')) return null;
  const relative = path.posix.normalize(decoded.slice('/src/'.length));
  if (relative.startsWith('..') || path.posix.isAbsolute(relative)) return null;
  if (!SERVED.some(entry => entry.endsWith('/') ? relative.startsWith(entry) : relative === entry)) return null;
  if (!(path.extname(relative) in TYPES)) return null;
  return path.join(root, ...relative.split('/'));
}

// Type stripping, without the ExperimentalWarning Node prints on first use (once per daemon, into the journal):
// the API is what Node itself runs .ts files with, and the tests catch a change to it
function strip(source: string, sourceUrl: string): string {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning instanceof Error ? warning.message : warning).includes('stripTypeScriptTypes')) return;
    (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return stripTypeScriptTypes(source, { mode: 'strip', sourceUrl });
  } finally {
    process.emitWarning = emit;
  }
}

export class StaticFiles {
  private root: string;
  private userCss: string;
  private cache = new Map<string, { mtimeMs: number; body: Buffer }>();

  constructor(root: string = SOURCE_ROOT, userCss: string = userStylesheet()) {
    this.root = root;
    this.userCss = userCss;
  }

  private async body(file: string): Promise<Buffer | null> {
    let info;
    try {
      info = await stat(file);
    } catch {
      return null;
    }
    if (!info.isFile()) return null;
    const cached = this.cache.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs) return cached.body;
    const source = await readFile(file);
    const body = file.endsWith('.ts')
      ? Buffer.from(strip(source.toString('utf8'), path.relative(this.root, file)))
      : source;
    this.cache.set(file, { mtimeMs: info.mtimeMs, body });
    return body;
  }

  // Answers the request; false when it names nothing served, so the caller answers it
  async serve(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;
    const urlPath = new URL(request.url ?? '/', 'http://localhost').pathname;
    const user = urlPath === USER_CSS_PATH;
    const file = user ? this.userCss : sourceFor(urlPath, this.root);
    if (!file) return false;
    let body: Buffer | null;
    try {
      body = await this.body(file) ?? (user ? Buffer.alloc(0) : null);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain' }).end(`${error instanceof Error ? error.message : String(error)}\n`);
      return true;
    }
    if (!body) return false;
    response.writeHead(200, {
      'Content-Type': user ? TYPES['.css'] : TYPES[path.extname(file)],
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': POLICY
    });
    response.end(request.method === 'HEAD' ? undefined : body);
    return true;
  }
}
