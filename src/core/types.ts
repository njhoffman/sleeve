// The shapes shared by the lyrics core, its providers and its callers.

// One word of a line with its own start, for karaoke-style highlighting (enhanced LRC, richsync)
export interface LyricWord {
  // Milliseconds from the start of the track
  time: number;
  text: string;
}

export interface LyricLine {
  // Milliseconds from the start of the track; null in unsynced lyrics
  time: number | null;
  text: string;
  words?: LyricWord[];
  translation?: string;
}

export interface Lyrics {
  // Every line has a time
  synced: boolean;
  instrumental: boolean;
  lines: LyricLine[];
}

// What is known about the track lyrics are wanted for. Only artist and title are required; the rest
// narrows the match. durationMs should be the length of the audio that plays, since synced lyrics are
// timed against it.
export interface TrackQuery {
  artist: string;
  title: string;
  album?: string;
  durationMs?: number;
  // Exact identifiers, for providers that look tracks up by them
  isrc?: string;
  spotifyId?: string;
  // The MusicBrainz recording id, for providers that take one (none yet); not part of the track's identity
  musicbrainzId?: string;
  // A local file, for providers that read sidecar files or the file's own tags
  path?: string;
}

// The track a provider says its lyrics belong to, as the provider names it
export interface MatchedTrack {
  artist: string;
  title: string;
  album?: string;
  durationMs?: number;
}

// One provider's lyrics for a query, before scoring
export interface Candidate {
  provider: string;
  // The provider's own id for these lyrics, when it has one
  id?: string;
  track: MatchedTrack;
  lyrics: Lyrics;
  // Found by an exact identifier or by the file itself, so the match needs no text comparison
  exact?: boolean;
  // When the provider gave this answer, for candidates served from the cache (epoch milliseconds)
  cachedAt?: number;
}

export interface ScoreDetail {
  title: number;
  artist: number;
  album: number | null;
  duration: number | null;
}

export interface ScoredCandidate extends Candidate {
  // 0 to 1; candidates under the threshold are not offered as a match
  score: number;
  detail: ScoreDetail;
}

export interface ProviderError {
  provider: string;
  message: string;
}

// What the user can say instead of picking lyrics: none are right for this track, or it has no words
export type TrackMark = 'none' | 'instrumental';

export interface LyricsResult {
  best: ScoredCandidate | null;
  // Every candidate that passed the threshold, best first
  candidates: ScoredCandidate[];
  // Candidates under the threshold, kept so a caller can show why nothing matched
  rejected: ScoredCandidate[];
  errors: ProviderError[];
  // best is the user's pick for the track, not the ranking's
  pinned: boolean;
  // The user's timing offset for best, in milliseconds (positive: later); 0 when none. best's lyrics are as the
  // provider gave them, so a display applies this itself (shiftLyrics) and can change it live.
  offsetMs: number;
  // The user marked the track as having no right lyrics, or as instrumental: best is null whatever was found
  marked?: TrackMark;
}
