import { DEFAULT_TIMEOUT_MS, fetchLyrics, type FetchOptions } from '../core/fetchLyrics.ts';
import { formatRef, parseRef, sameCandidate, type TrackPrefs } from '../core/prefs.ts';
import type { LyricsResult, TrackQuery } from '../core/types.ts';
import { buildQuery, describeCandidate, formatOffset, parseDuration, pickProviders, type Io } from './lyrics.ts';
import { openStores } from './stores.ts';

// `sleeve pick` (show these lyrics for a track from now on) and `sleeve offset` (shift them in time). The track
// comes from a file or --artist and --title, as for `sleeve lyrics`; candidates are looked up the same way,
// through the cache, so a number from `sleeve lyrics --all` names the same candidate here.

export interface TrackCommandOptions {
  artist?: string;
  title?: string;
  album?: string;
  duration?: string;
  providers?: string;
  timeout?: string;
  reset?: boolean;
}

const name = (query: TrackQuery) => `${query.artist} - ${query.title}`;

async function withTrack<T>(file: string | undefined, options: TrackCommandOptions, fetchOptions: FetchOptions,
  use: (query: TrackQuery, prefs: TrackPrefs, lookup: (all: boolean) => Promise<LyricsResult>) => Promise<T>): Promise<T> {
  const query = await buildQuery(file, options, fetchOptions.tags);
  const providers = pickProviders(options.providers);
  const timeoutMs = options.timeout ? parseDuration(options.timeout) : DEFAULT_TIMEOUT_MS;
  const { cache: _cache, prefs: _prefs, ...rest } = fetchOptions;
  const stores = openStores({ cache: true, prefs: true }, fetchOptions);
  const lookup = (all: boolean) => fetchLyrics(query, {
    ...rest, providers, timeoutMs, all, ...(stores.cache ? { cache: stores.cache } : {}), prefs: stores.prefs!
  });
  try {
    return await use(query, stores.prefs!, lookup);
  } finally {
    stores.close();
  }
}

// [file] <ref>, or [file] alone with --reset
export async function pickCommand(args: string[], options: TrackCommandOptions, io: Io, fetchOptions: FetchOptions = {}): Promise<number> {
  const wanted = options.reset ? 0 : 1;
  if (args.length < wanted || args.length > wanted + 1) {
    throw new Error(options.reset ? 'Give at most a file with --reset' : 'Give a candidate (provider:id, or a number from sleeve lyrics --all), after the file if there is one');
  }
  const file = args.length > wanted ? args[0] : undefined;
  const choice = options.reset ? undefined : args.at(-1)!;
  return withTrack(file, options, fetchOptions, async (query, prefs, lookup) => {
    if (choice === undefined) {
      io.out(prefs.clearPick(query) ? `Removed the pick for ${name(query)}` : `No pick for ${name(query)}`);
      return 0;
    }
    const ref = /^\d+$/.test(choice) ? null : parseRef(choice);
    if (!ref && !/^\d+$/.test(choice)) throw new Error(`Invalid candidate: ${choice} (use provider:id, or a number from sleeve lyrics --all)`);
    const result = await lookup(true);
    const listed = [...result.candidates, ...result.rejected];
    const candidate = ref ? listed.find(item => sameCandidate(item, ref)) : listed[Number(choice) - 1];
    if (!candidate) {
      io.err(`No candidate ${choice} for ${name(query)}; list them with sleeve lyrics --all`);
      for (const error of result.errors) io.err(`  ${error.provider} failed: ${error.message}`);
      return 1;
    }
    prefs.setPick(query, candidate);
    io.out(`Picked ${formatRef(candidate)} for ${name(query)}: ${describeCandidate(candidate)}`);
    return 0;
  });
}

// "250", "+250", "-1200", "250ms" to milliseconds
export function parseOffset(text: string): number {
  const match = /^([+-]?\d+)(ms)?$/.exec(text.trim());
  if (!match) throw new Error(`Invalid offset: ${text} (use whole milliseconds, like 250 or -1200)`);
  return Number(match[1]);
}

const looksLikeOffset = (text: string) => /^[+-]?\d+(ms)?$/.test(text.trim());

// [file] [ms]: sets the offset, or shows it without ms; --reset removes it. 0 removes it too.
export async function offsetCommand(args: string[], options: TrackCommandOptions, io: Io, fetchOptions: FetchOptions = {}): Promise<number> {
  if (args.length > 2) throw new Error('Give a file and an offset in milliseconds');
  const value = args.length && looksLikeOffset(args.at(-1)!) ? args.at(-1)! : undefined;
  const files = value === undefined ? args : args.slice(0, -1);
  if (files.length > 1) throw new Error(`Invalid offset: ${args.at(-1)} (use whole milliseconds, like 250 or -1200)`);
  if (options.reset && value !== undefined) throw new Error('Give an offset or --reset, not both');
  const ms = value === undefined ? undefined : parseOffset(value);
  return withTrack(files[0], options, fetchOptions, async (query, prefs, lookup) => {
    if (options.reset || ms === 0) {
      io.out(prefs.clearOffset(query) ? `Removed the offset for ${name(query)}` : `No offset for ${name(query)}`);
      return 0;
    }
    const result = await lookup(false);
    if (!result.best) {
      io.err(`No lyrics found for ${name(query)}, so nothing to offset`);
      return 1;
    }
    if (ms !== undefined) {
      prefs.setOffset(query, ms, result.best);
      io.out(`Offset ${formatOffset(ms)} for ${formatRef(result.best)} (${name(query)})`);
      return 0;
    }
    const stored = prefs.get(query)?.offset;
    if (!stored) io.out(`No offset for ${name(query)}`);
    else if (result.offsetMs) io.out(`Offset ${formatOffset(stored.ms)} for ${formatRef(stored)} (${name(query)})`);
    else io.out(`Offset ${formatOffset(stored.ms)} for ${formatRef(stored)}, which is not the lyrics shown now (${formatRef(result.best)}); not applied`);
    return 0;
  });
}
