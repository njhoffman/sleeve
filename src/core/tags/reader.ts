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
  // The MusicBrainz recording id (TXXX:MusicBrainz Release Track Id is the track on a release, not this)
  musicbrainzId?: string;
  // From musicman's Spotify fields (TXXX:sp_*)
  spotifyId?: string;
  spotifyDurationMs?: number;
  lyrics: StoredLyrics[];
}

// A picture embedded in the file (the front cover when it says which)
export interface Picture {
  // e.g. image/jpeg
  format: string;
  data: Uint8Array;
}

export interface TagReader {
  read(file: string): Promise<FileTags>;
  // The file's cover, or null when it has none; readers without pictures leave it out
  picture?(file: string): Promise<Picture | null>;
}
