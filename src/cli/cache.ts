import { LyricsCache } from '../core/cache.ts';
import { done, outStyle, type Io } from './lyrics.ts';
import { gradientBar, paint, percent, table, type Cell } from './style.ts';

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
  const style = outStyle(io);
  if (style.rich) {
    const paints = paint(style);
    io.out(`${paints.dim(stats.file)}`);
    const row = (name: string, found: number, without: number, styled: boolean): Cell[] => [
      styled ? { text: name, style: paints.bold } : { text: name, style: paints.cyan }, String(found), String(without),
      gradientBar(found / (found + without), 20, style.depth), percent(found / (found + without))
    ];
    const rows = [
      ['', 'lyrics', 'none', '', 'found'].map(text => ({ text, style: paints.dim })),
      ...Object.entries(stats.byProvider).map(([provider, counts]) => row(provider, counts.found, counts.notFound, false)),
      row('all', stats.found, stats.notFound, true)
    ];
    for (const line of table(rows, { right: [1, 2, 4] })) io.out(line);
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
  done(io, `Removed ${removed} ${what}`);
  return 0;
}
