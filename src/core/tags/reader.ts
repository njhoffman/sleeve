import type { LyricLine } from '../types.ts';

// Reading what a local audio file says about itself, behind a small interface so the implementation can
// change (music-metadata now; musicman's tag code later, if the two projects share it) without touching the
// providers or the CLI.

export interface StoredLyrics {
  // Where they came from, e.g. "USLT" or "SYLT"
  frame: string;
  synced: boolean;
  // The raw text for unsynced lyrics (which may still be LRC); empty for synced ones
  text: string;
  // Timed lines for synced lyrics; empty for unsynced ones
  lines: LyricLine[];
}

export interface FileTags {
  artist?: string;
  title?: string;
  album?: string;
  // The audio's own length, measured from the file
  durationMs?: number;
  isrc?: string;
  // From musicman's Spotify fields (TXXX:sp_*)
  spotifyId?: string;
  spotifyDurationMs?: number;
  lyrics: StoredLyrics[];
}

export interface TagReader {
  read(file: string): Promise<FileTags>;
}
