import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// What musicman shares (its docs/09-contract.md): paths.json, where MPD, the library and its database are,
// and the spotify_track_files view, the library files tagged with a Spotify track id. sleeve reads both and
// never writes; without musicman, Spotify tracks just have no local file.

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
