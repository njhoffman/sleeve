import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PlayingTrack } from './types.ts';

// What musicman shares (its docs/09-contract.md): paths.json, where MPD, the library and its database are,
// and the spotify_track_files view, the library files tagged with a Spotify track id. sleeve reads both and
// never writes; without musicman, Spotify tracks just have no local file. Also `musicman spotify queue --format json`,
// what Spotify plays next, so its lyrics can be looked up ahead as MPD's are; musicman holds the Spotify token.

export interface MusicmanPaths {
  mpd: { host: string; port: number; baseDirectory: string };
  db: { path: string | null };
}

export const PATHS_VERSION = 1;

export function musicmanPathsFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'musicman', 'paths.json');
}

// null when musicman has not written the file; throws when it cannot be read or is from another version
export function readMusicmanPaths(file: string = musicmanPathsFile()): MusicmanPaths | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const paths = JSON.parse(text) as MusicmanPaths & { version?: number };
  if (paths.version !== PATHS_VERSION) throw new Error(`${file} is version ${paths.version}; this sleeve reads version ${PATHS_VERSION}`);
  return paths;
}

export interface LibraryFile {
  // Absolute
  file: string;
  durationMs?: number;
}

export class MusicmanLibrary {
  private db: DatabaseSync;
  private baseDirectory: string;

  // Throws when the database cannot be opened or predates the view (musicman before 1.55.0)
  constructor(dbPath: string, baseDirectory: string) {
    this.db = new DatabaseSync(dbPath, { readOnly: true });
    this.baseDirectory = baseDirectory;
    const view = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'spotify_track_files'").get();
    if (!view) {
      this.db.close();
      throw new Error(`${dbPath} has no spotify_track_files view; update musicman to 1.55.0 or later`);
    }
  }

  static fromPaths(paths: MusicmanPaths): MusicmanLibrary | null {
    return paths.db.path ? new MusicmanLibrary(paths.db.path, paths.mpd.baseDirectory) : null;
  }

  // The library file for a Spotify track, a copy kept in the library before an excluded duplicate
  fileFor(spotifyId: string): LibraryFile | null {
    const row = this.db.prepare('SELECT path, duration FROM spotify_track_files WHERE track_id = ? ORDER BY excluded, path LIMIT 1')
      .get(spotifyId) as { path: string; duration: number | null } | undefined;
    if (!row) return null;
    return {
      file: path.join(this.baseDirectory, row.path),
      ...(row.duration ? { durationMs: Math.round(row.duration * 1000) } : {})
    };
  }

  close(): void {
    this.db.close();
  }
}

// `musicman spotify queue --format json` (version 1): the track playing and the next few, from the Web API
export const QUEUE_VERSION = 1;
const QUEUE_TIMEOUT_MS = 15_000;

interface QueueTrack {
  id: string;
  title: string;
  artists: string[];
  album: string | null;
  durationMs: number | null;
}

export type RunCommand = (command: string, args: string[], timeoutMs: number) => Promise<string>;

const runCommand: RunCommand = (command, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

// The track Spotify plays next, as the MPRIS player will name it once it starts (its key is Spotify's MPRIS track
// id), or null when the queue is empty or is not after playingId (Spotify moved on, or plays elsewhere). Throws
// when musicman cannot answer.
export async function spotifyNext(playingId: string, run: RunCommand = runCommand): Promise<PlayingTrack | null> {
  const text = await run('musicman', ['spotify', 'queue', '--format', 'json'], QUEUE_TIMEOUT_MS);
  const start = text.indexOf('{');
  if (start < 0) throw new Error('musicman spotify queue printed no JSON');
  const answer = JSON.parse(text.slice(start)) as { version?: number; playing?: QueueTrack | null; queue?: QueueTrack[] };
  if (answer.version !== QUEUE_VERSION) throw new Error(`musicman spotify queue is version ${answer.version}; this sleeve reads version ${QUEUE_VERSION}`);
  if (answer.playing?.id !== playingId) return null;
  const next = answer.queue?.[0];
  if (!next?.id || !next.title) return null;
  return {
    key: `/com/spotify/track/${next.id}`,
    artist: next.artists.join(', '),
    title: next.title,
    ...(next.album ? { album: next.album } : {}),
    ...(next.durationMs ? { durationMs: next.durationMs } : {}),
    spotifyId: next.id
  };
}
