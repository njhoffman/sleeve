import { PlayerHub } from '../players/hub.ts';
import { MpdPlayer } from '../players/mpd.ts';
import { MprisPlayer, NOT_PLAYERS, type MprisBus } from '../players/mpris.ts';
import { MusicmanLibrary, readMusicmanPaths, spotifyNext, type MusicmanPaths } from '../players/musicman.ts';
import { mpdSettings } from '../players/settings.ts';
import type { Player, PlayingTrack } from '../players/types.ts';
import { NowPlaying } from '../now/session.ts';
import { parseDuration, pickProviders, type Io } from './lyrics.ts';
import { openStores } from './stores.ts';

// The players, the musicman library, the stores and the NowPlaying session over them, as `sleeve now` and
// `sleeve daemon` both set them up from the same options.

export interface SessionCliOptions {
  // commander's --no-mpd and --no-mpris set these false
  mpd?: string | boolean;
  mpris?: string | boolean;
  musicDir?: string;
  providers?: string;
  timeout?: string;
  cache?: boolean;
  prefs?: boolean;
  // commander's --no-prefetch sets it false
  prefetch?: boolean;
}

// What the session needs from outside, replaced in tests
export interface SessionDeps {
  env?: NodeJS.ProcessEnv;
  musicman?: () => MusicmanPaths | null;
  openLibrary?: (paths: MusicmanPaths) => MusicmanLibrary | null;
  mprisBus?: () => Promise<MprisBus>;
  players?: Player[];
  fetch?: typeof fetch;
}

export interface OpenSession {
  session: NowPlaying;
  hub: PlayerHub;
  close(): Promise<void>;
}

export const DEFAULT_MPRIS = 'spotify';

const realBus = async (): Promise<MprisBus> => (await import('../players/mprisDbus.ts')).dbusMprisBus();

export function mprisNames(option: string | boolean | undefined): string[] {
  if (option === false) return [];
  const names = (typeof option === 'string' ? option : DEFAULT_MPRIS).split(',').map(name => name.trim()).filter(Boolean);
  const proxies = names.filter(name => NOT_PLAYERS.includes(name));
  if (proxies.length) throw new Error(`Not an MPRIS player of its own: ${proxies.join(', ')} (MPD is read directly; leave out playerctld)`);
  return names;
}

// Whether any option shapes the session (players, providers, stores), as opposed to how it is shown
export function shapesSession(options: SessionCliOptions): boolean {
  return options.mpd !== undefined || options.mpris !== undefined || options.musicDir !== undefined || options.providers !== undefined
    || options.timeout !== undefined || options.cache === false || options.prefs === false || options.prefetch === false;
}

// Checks the options, then opens everything and starts the session once every player has had its first try
export async function openSession(options: SessionCliOptions, io: Io, deps: SessionDeps = {}): Promise<OpenSession> {
  const env = deps.env ?? process.env;
  const providers = pickProviders(options.providers);
  const timeoutMs = options.timeout ? parseDuration(options.timeout) : undefined;
  const names = mprisNames(options.mpris);
  if (!deps.players && options.mpd === false && !names.length) throw new Error('No players: leave MPD or MPRIS on');

  let paths: MusicmanPaths | null = null;
  try {
    paths = (deps.musicman ?? (() => readMusicmanPaths()))();
  } catch (error) {
    io.err(`musicman: ${error instanceof Error ? error.message : String(error)}`);
  }
  let library: MusicmanLibrary | null = null;
  if (paths && names.length) {
    try {
      library = (deps.openLibrary ?? MusicmanLibrary.fromPaths)(paths);
    } catch (error) {
      io.err(`musicman: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let bus: MprisBus | null = null;
  const players: Player[] = deps.players ?? [];
  if (!deps.players) {
    if (options.mpd !== false) {
      const settings = mpdSettings({
        ...(typeof options.mpd === 'string' ? { mpd: options.mpd } : {}),
        ...(options.musicDir ? { musicDirectory: options.musicDir } : {}),
        env, musicman: paths
      });
      players.push(new MpdPlayer(settings));
    }
    if (names.length) {
      try {
        bus = await (deps.mprisBus ?? realBus)();
      } catch (error) {
        library?.close();
        throw error;
      }
      // Spotify's queue comes from musicman, which holds the Spotify token; without it nothing is prefetched
      const next = (track: PlayingTrack) => track.spotifyId ? spotifyNext(track.spotifyId) : Promise.resolve(null);
      for (const name of names) {
        players.push(new MprisPlayer(bus, name, name === 'spotify' && options.prefetch !== false ? { next } : {}));
      }
    }
  }
  if (!players.length) throw new Error('No players: leave MPD or MPRIS on');

  const hub = new PlayerHub(players);
  const stores = openStores({ cache: options.cache !== false, prefs: options.prefs !== false });
  const session = new NowPlaying(hub, {
    providers,
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(stores.cache ? { cache: stores.cache } : {}),
    ...(stores.prefs ? { prefs: stores.prefs } : {}),
    ...(options.prefetch === false ? { prefetch: false } : {}),
    library
  });
  const close = async () => {
    session.close();
    await hub.close();
    bus?.close();
    library?.close();
    stores.close();
  };
  try {
    hub.start();
    await hub.ready();
    session.start();
  } catch (error) {
    await close();
    throw error;
  }
  return { session, hub, close };
}
