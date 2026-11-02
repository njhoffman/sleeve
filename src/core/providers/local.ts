import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { looksLikeLrc, parseLrc } from '../lrc.ts';
import type { Candidate, Lyrics, TrackQuery } from '../types.ts';
import type { Provider, ProviderContext } from './provider.ts';

// Lyrics that come with a local file: an .lrc next to it (same name), and lyrics in its own tags. Both are
// exact: they belong to this file, so they need no matching.

function trackOf(query: TrackQuery) {
  return {
    artist: query.artist, title: query.title,
    ...(query.album ? { album: query.album } : {}),
    ...(query.durationMs ? { durationMs: query.durationMs } : {})
  };
}

// "song.mp3" -> "song.lrc"
export function sidecarPath(file: string): string {
  return path.join(path.dirname(file), `${path.basename(file, path.extname(file))}.lrc`);
}

export const sidecar: Provider = {
  name: 'sidecar',
  local: true,

  async search(query: TrackQuery): Promise<Candidate[]> {
    if (!query.path) return [];
    let text: string;
    try {
      text = await readFile(sidecarPath(query.path), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const lyrics = parseLrc(text);
    if (!lyrics.lines.length) return [];
    return [{ provider: 'sidecar', id: sidecarPath(query.path), track: trackOf(query), lyrics, exact: true }];
  }
};

export const embedded: Provider = {
  name: 'embedded',
  local: true,

  async search(query: TrackQuery, context: ProviderContext): Promise<Candidate[]> {
    if (!query.path) return [];
    const tags = await context.tags.read(query.path);
    return tags.lyrics.flatMap(stored => {
      let lyrics: Lyrics;
      if (stored.synced) lyrics = { synced: true, instrumental: false, lines: stored.lines };
      // LRC text in an unsynced frame (USLT) is common, since few players read SYLT
      else if (looksLikeLrc(stored.text)) lyrics = parseLrc(stored.text);
      else lyrics = { synced: false, instrumental: false, lines: stored.text.split(/\r?\n/).filter(text => text.trim()).map(text => ({ time: null, text: text.trim() })) };
      if (!lyrics.lines.length) return [];
      return [{ provider: 'embedded', id: `${query.path}#${stored.frame}`, track: trackOf(query), lyrics, exact: true }];
    });
  }
};
