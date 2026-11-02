import { LyricsCache } from '../core/cache.ts';
import { SleeveDatabase } from '../core/db.ts';
import type { FetchOptions } from '../core/fetchLyrics.ts';
import { TrackPrefs } from '../core/prefs.ts';

// The cache and prefs a command uses: the ones a caller passed (tests), else both on the user's database, opened
// once and only when one is wanted. close() closes what was opened here.

export interface Stores {
  cache?: LyricsCache;
  prefs?: TrackPrefs;
  close(): void;
}

export function openStores(want: { cache: boolean; prefs: boolean }, given: Pick<FetchOptions, 'cache' | 'prefs'> = {}): Stores {
  let database: SleeveDatabase | undefined;
  const shared = () => (database ??= new SleeveDatabase());
  const cache = want.cache ? given.cache ?? new LyricsCache(shared()) : undefined;
  const prefs = want.prefs ? given.prefs ?? new TrackPrefs(shared()) : undefined;
  return {
    ...(cache ? { cache } : {}),
    ...(prefs ? { prefs } : {}),
    close: () => database?.close()
  };
}
