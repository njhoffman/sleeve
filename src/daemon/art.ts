import { readdir, readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { musicMetadataReader } from '../core/tags/musicMetadata.ts';
import type { Picture, TagReader } from '../core/tags/reader.ts';
import type { Playback, PlayingTrack } from '../players/types.ts';

// The cover of the track playing, for the renderer's background: GET /art/current?key=<the track's key>. Only the
// track playing now is served (the key must be its key), so the page can ask for nothing else, and from sleeved's
// own origin, so the page may read the pixels for its colors. Where it comes from, first found:
//
// - the cover the player names (MPRIS mpris:artUrl): https (Spotify's CDN) fetched here, or a file:// image;
// - the picture embedded in the file playing;
// - an image beside the file: cover, folder or front (.jpg, .jpeg, .png, .webp), any case.
//
// The last few covers are kept, so a page reloaded or a second page costs nothing. Whatever the source, a cover is
// served only as the JPEG, PNG, GIF or WebP its first bytes show (rasterFormat), never as the type it claims: an SVG
// could run script on sleeved's own origin, which may open the control socket, were its URL opened directly.

export const ART_PATH = '/art/current';
const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 5000;
const KEEP = 8;
const IMAGE_TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
// What a cover is sent with: it is an image and nothing else, and a page it is opened as gets no script and no origin
const SERVED_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" };

const startsWith = (data: Uint8Array, bytes: number[], at = 0) => bytes.every((byte, index) => data[at + index] === byte);
const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));

// The raster format data is, by its signature; null for anything else (SVG, HTML, a truncated file)
export function rasterFormat(data: Uint8Array): string | null {
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(data, ascii('GIF87a')) || startsWith(data, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(data, ascii('RIFF')) && startsWith(data, ascii('WEBP'), 8)) return 'image/webp';
  return null;
}

// A picture as what its bytes are, or null when they are no raster image
function raster(picture: Picture | null | undefined): Picture | null {
  const format = picture?.data.length ? rasterFormat(picture.data) : null;
  return format ? { format, data: picture!.data } : null;
}
const BESIDE = /^(cover|folder|front)\.(jpe?g|png|webp)$/i;

export interface CoverArtOptions {
  tags?: TagReader;
  fetch?: typeof globalThis.fetch;
  userAgent?: string;
}

export class CoverArt {
  private tags: TagReader;
  private fetch: typeof globalThis.fetch;
  private userAgent: string;
  // By track key, the most recent last; null: looked for, none found
  private kept = new Map<string, Promise<Picture | null>>();

  constructor({ tags = musicMetadataReader, fetch = globalThis.fetch, userAgent = 'sleeve' }: CoverArtOptions = {}) {
    this.tags = tags;
    this.fetch = fetch;
    this.userAgent = userAgent;
  }

  // Answers GET /art/current for playback (the session's now); false for any other request
  async serve(request: IncomingMessage, response: ServerResponse, playback: Playback | null): Promise<boolean> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== ART_PATH || (request.method !== 'GET' && request.method !== 'HEAD')) return false;
    const track = playback?.track;
    if (!track || url.searchParams.get('key') !== track.key) {
      response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not the track playing\n');
      return true;
    }
    const picture = await this.cover(track);
    if (!picture) {
      response.writeHead(404, { 'Content-Type': 'text/plain' }).end('no cover\n');
      return true;
    }
    response.writeHead(200, { 'Content-Type': picture.format, 'Content-Length': picture.data.length, 'Cache-Control': 'private, max-age=3600', ...SERVED_HEADERS });
    response.end(request.method === 'HEAD' ? undefined : picture.data);
    return true;
  }

  // The track's cover, looked for once while it is among the last few
  cover(track: PlayingTrack): Promise<Picture | null> {
    const known = this.kept.get(track.key);
    if (known) {
      this.kept.delete(track.key);
      this.kept.set(track.key, known);
      return known;
    }
    const found = this.find(track).catch(() => null);
    this.kept.set(track.key, found);
    while (this.kept.size > KEEP) this.kept.delete(this.kept.keys().next().value!);
    return found;
  }

  private async find(track: PlayingTrack): Promise<Picture | null> {
    if (track.artUrl?.startsWith('https://')) {
      const fetched = raster(await this.download(track.artUrl));
      if (fetched) return fetched;
    } else if (track.artUrl?.startsWith('file://')) {
      const named = raster(await imageFile(fileURLToPath(track.artUrl)));
      if (named) return named;
    }
    if (!track.file) return null;
    const embedded = raster(await this.tags.picture?.(track.file).catch(() => null));
    if (embedded) return embedded;
    return beside(track.file);
  }

  // The body, read up to MAX_BYTES: refused by its Content-Length when that says more, and cut off once it passes it
  private async download(url: string): Promise<Picture | null> {
    const response = await this.fetch(url, { headers: { 'User-Agent': this.userAgent }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const length = Number(response.headers.get('content-length') ?? 0);
    if (!response.ok || !response.body || length > MAX_BYTES) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      total += read.value.length;
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(read.value);
    }
    const data = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      data.set(chunk, at);
      at += chunk.length;
    }
    return { format: 'application/octet-stream', data };
  }
}

// An image file by its extension, if it is one and not too big
async function imageFile(file: string): Promise<Picture | null> {
  const format = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!format) return null;
  try {
    if ((await stat(file)).size > MAX_BYTES) return null;
    return { format, data: new Uint8Array(await readFile(file)) };
  } catch {
    return null;
  }
}

// cover.jpg and the like in the file's folder
async function beside(file: string): Promise<Picture | null> {
  const folder = path.dirname(file);
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return null;
  }
  const rank = (name: string) => ['cover', 'folder', 'front'].indexOf(name.split('.')[0].toLowerCase());
  for (const name of names.filter(entry => BESIDE.test(entry)).sort((a, b) => rank(a) - rank(b))) {
    const found = raster(await imageFile(path.join(folder, name)));
    if (found) return found;
  }
  return null;
}
