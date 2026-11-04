import { LyricsCache } from '../core/cache.ts';
import { SleeveDatabase } from '../core/db.ts';
import type { FetchOptions } from '../core/fetchLyrics.ts';
import { TrackPrefs } from '../core/prefs.ts';
import { TagFallbacks, TagRetries } from '../core/retries.ts';

// The cache, prefs, tag retries and fallbacks a command uses: the ones a caller passed (tests), else each on the user's
// database, opened once and only when one is wanted. close() closes what was opened here.

export interface Stores {
  cache?: LyricsCache;
  prefs?: TrackPrefs;
  retries?: TagRetries;
  fallbacks?: TagFallbacks;
  close(): void;
}

export function openStores(
  want: { cache: boolean; prefs: boolean; retries?: boolean; fallbacks?: boolean },
  given: Pick<FetchOptions, 'cache' | 'prefs'> & { retries?: TagRetries; fallbacks?: TagFallbacks } = {}
): Stores {
  let database: SleeveDatabase | undefined;
  const shared = () => (database ??= new SleeveDatabase());
  const cache = want.cache ? given.cache ?? new LyricsCache(shared()) : undefined;
  const prefs = want.prefs ? given.prefs ?? new TrackPrefs(shared()) : undefined;
  const retries = want.retries ? given.retries ?? new TagRetries(shared()) : undefined;
  const fallbacks = want.fallbacks ? given.fallbacks ?? new TagFallbacks(shared()) : undefined;
  return {
    ...(cache ? { cache } : {}),
    ...(prefs ? { prefs } : {}),
    ...(retries ? { retries } : {}),
    ...(fallbacks ? { fallbacks } : {}),
    close: () => database?.close()
  };
}
