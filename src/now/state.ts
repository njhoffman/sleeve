import type { LyricsResult, TrackQuery } from '../core/types.ts';
import type { Playback } from '../players/types.ts';

// What NowPlaying holds, in-process or mirrored from sleeved. Apart from session.ts, so browser code can name it
// without importing the session's Node dependencies.

export interface NowState {
  playback: Playback | null;
  // The track as asked for lyrics; null without a track, or while it is being worked out
  query: TrackQuery | null;
  result: LyricsResult | null;
  loading: boolean;
  error: string | null;
}
