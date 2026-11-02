import { LyricsCache } from '../core/cache.ts';
import type { Io } from './lyrics.ts';

// `sleeve cache` (what is stored) and `sleeve cache clear` (forget answers so providers are asked again)

export interface CacheOptions {
  json?: boolean;
}

export interface ClearCommandOptions {
  provider?: string;
  notFound?: boolean;
}

function withCache<T>(open: () => LyricsCache, use: (cache: LyricsCache) => T): T {
  const cache = open();
  try {
    return use(cache);
  } finally {
    cache.close();
  }
}

export function cacheStatsCommand(options: CacheOptions, io: Io, open: () => LyricsCache = () => new LyricsCache()): number {
  const stats = withCache(open, cache => cache.stats());
  if (options.json) {
    io.out(JSON.stringify(stats, null, 2));
    return 0;
  }
  io.out(`${stats.file}: ${stats.answers} answers, ${stats.found} with lyrics, ${stats.notFound} without`);
  for (const [provider, counts] of Object.entries(stats.byProvider)) {
    io.out(`  ${provider}: ${counts.found} with lyrics, ${counts.notFound} without`);
  }
  return 0;
}

export function cacheClearCommand(options: ClearCommandOptions, io: Io, open: () => LyricsCache = () => new LyricsCache()): number {
  const removed = withCache(open, cache => cache.clear({
    ...(options.provider ? { provider: options.provider.toLowerCase() } : {}),
    notFoundOnly: Boolean(options.notFound)
  }));
  const what = [options.notFound ? '"none" answers' : 'answers', options.provider ? `from ${options.provider.toLowerCase()}` : ''].filter(Boolean).join(' ');
  io.out(`Removed ${removed} ${what}`);
  return 0;
}
