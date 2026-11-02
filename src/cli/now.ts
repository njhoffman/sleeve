import type { LyricsResult } from '../core/types.ts';
import { clockTime } from '../players/clock.ts';
import { PlayerHub } from '../players/hub.ts';
import { MpdPlayer } from '../players/mpd.ts';
import { MprisPlayer, NOT_PLAYERS, type MprisBus } from '../players/mpris.ts';
import { MusicmanLibrary, readMusicmanPaths, type MusicmanPaths } from '../players/musicman.ts';
import { mpdSettings } from '../players/settings.ts';
import type { Player } from '../players/types.ts';
import { NowPlaying, type NowState } from '../now/session.ts';
import { describeCandidate, formatOffset, parseDuration, pickProviders, type Io } from './lyrics.ts';
import { openStores } from './stores.ts';

// `sleeve now`: lyrics for what MPD or Spotify plays, line by line as they come due, with + and - to nudge the
// timing (saved for the track) and q to quit; `--once` prints where playback is and the current line.

export interface NowOptions {
  once?: boolean;
  json?: boolean;
  // commander's --no-mpd and --no-mpris set these false
  mpd?: string | boolean;
  mpris?: string | boolean;
  musicDir?: string;
  providers?: string;
  timeout?: string;
  cache?: boolean;
  prefs?: boolean;
}

export const NUDGE_MS = 100;

// What `sleeve now` needs from outside, replaced in tests
export interface NowDeps {
  env?: NodeJS.ProcessEnv;
  musicman?: () => MusicmanPaths | null;
  openLibrary?: (paths: MusicmanPaths) => MusicmanLibrary | null;
  mprisBus?: () => Promise<MprisBus>;
  players?: Player[];
  input?: NodeJS.ReadStream;
  tickMs?: number;
  now?: () => number;
  fetch?: typeof fetch;
}

const realBus = async (): Promise<MprisBus> => (await import('../players/mprisDbus.ts')).dbusMprisBus();

function mprisNames(option: string | boolean | undefined): string[] {
  if (option === false) return [];
  const names = (typeof option === 'string' ? option : 'spotify').split(',').map(name => name.trim()).filter(Boolean);
  const proxies = names.filter(name => NOT_PLAYERS.includes(name));
  if (proxies.length) throw new Error(`Not an MPRIS player of its own: ${proxies.join(', ')} (MPD is read directly; leave out playerctld)`);
  return names;
}

function trackLine(state: NowState): string {
  const { playback } = state;
  if (!playback?.track) return 'Nothing playing';
  const { track } = playback;
  return `${track.artist ? `${track.artist} - ` : ''}${track.title}`;
}

// Why nothing was found: the providers that failed (prefs notes too, which also matter with lyrics)
function failures(result: LyricsResult | null): string[] {
  const errors = result?.errors ?? [];
  return errors.filter(error => !result?.best || error.provider === 'prefs').map(error => `${error.provider} failed: ${error.message}`);
}

function sourceLine(result: LyricsResult | null): string {
  if (!result?.best) return 'no lyrics found';
  const decided = `${result.pinned ? ', pinned' : ''}${result.offsetMs ? `, offset ${formatOffset(result.offsetMs)}` : ''}`;
  return `${describeCandidate(result.best)}${decided}`;
}

// Prints what changed since it last printed: the track, where its lyrics came from, pauses, and each line as it
// becomes current (again after a seek back)
export class LivePrinter {
  private io: Io;
  private track: string | null | undefined = undefined;
  private looked = false;
  private paused = false;
  private lastLine = -2;

  constructor(io: Io) {
    this.io = io;
  }

  render(session: Pick<NowPlaying, 'current' | 'line'>, now?: number): void {
    const state = session.current();
    const playback = state.playback;
    const key = playback?.track ? `${playback.player}:${playback.track.key}` : null;
    if (key !== this.track) {
      this.track = key;
      this.looked = false;
      this.paused = false;
      this.lastLine = -2;
      this.io.out(key ? `\n== ${trackLine(state)} [${playback!.player}]` : '\n== Nothing playing');
    }
    if (!key) return;
    if (!state.loading && !this.looked) {
      this.looked = true;
      this.io.out(`-- ${state.error ? `lookup failed: ${state.error}` : state.query ? sourceLine(state.result) : 'no artist or title to look up'}`);
      for (const failure of failures(state.result)) this.io.out(`-- ${failure}`);
      const lyrics = state.result?.best?.lyrics;
      if (lyrics?.instrumental) this.io.out('(instrumental)');
      else if (lyrics && !lyrics.synced) for (const line of lyrics.lines) this.io.out(line.text);
    }
    const paused = playback!.state !== 'playing';
    if (paused !== this.paused) {
      this.paused = paused;
      this.io.out(paused ? '-- paused' : '-- playing');
    }
    if (state.loading) return;
    const current = session.line(now);
    if (current.index !== this.lastLine) {
      if (current.line && current.line.text) this.io.out(`[${clockTime(current.time!)}] ${current.line.text}`);
      this.lastLine = current.index;
    }
  }
}

function snapshot(session: NowPlaying, hub: PlayerHub, now?: number) {
  const state = session.current();
  const playback = state.playback;
  const line = session.line(now);
  return {
    player: playback?.player ?? null,
    state: playback?.state ?? null,
    positionMs: playback ? Math.round(session.position(now)) : null,
    track: playback?.track ?? null,
    query: state.query,
    lyrics: state.result,
    line: line.line ? { index: line.index, timeMs: line.time, text: line.line.text } : null,
    problems: hub.problems()
  };
}

function printOnce(session: NowPlaying, hub: PlayerHub, options: NowOptions, io: Io, now?: number): number {
  const shot = snapshot(session, hub, now);
  if (options.json) {
    io.out(JSON.stringify(shot, null, 2));
    return shot.track ? 0 : 1;
  }
  const state = session.current();
  if (!shot.track) {
    io.out('Nothing playing');
    for (const { player, problem } of shot.problems) io.err(`  ${player}: ${problem}`);
    return 1;
  }
  const length = shot.track.durationMs ? `/${clockTime(shot.track.durationMs)}` : '';
  io.out(`${shot.player} ${shot.state} ${clockTime(shot.positionMs!)}${length} ${trackLine(state)}`);
  io.out(state.query ? sourceLine(state.result) : 'no artist or title to look up');
  for (const failure of failures(state.result)) io.err(`  ${failure}`);
  if (shot.line) io.out(`> ${shot.line.text}`);
  return 0;
}

// Raw keys from a terminal: + and - nudge, q quits
function keys(input: NodeJS.ReadStream | undefined, session: NowPlaying, io: Io, quit: () => void): () => void {
  if (!input?.isTTY) return () => {};
  input.setRawMode(true);
  input.resume();
  const press = (data: Buffer) => {
    for (const key of data.toString()) {
      if (key === 'q' || key === '\u0003') quit();
      const delta = key === '+' || key === '=' ? NUDGE_MS : key === '-' || key === '_' ? -NUDGE_MS : 0;
      if (!delta) continue;
      const offset = session.nudge(delta);
      if (offset !== null) io.out(`-- offset ${offset ? formatOffset(offset) : 'removed'}`);
      else io.out(session.current().loading ? '-- still looking up lyrics' : '-- no lyrics to move');
    }
  };
  input.on('data', press);
  return () => {
    input.off('data', press);
    input.setRawMode(false);
    input.pause();
  };
}

export async function nowCommand(options: NowOptions, io: Io, deps: NowDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const providers = pickProviders(options.providers);
  const timeoutMs = options.timeout ? parseDuration(options.timeout) : undefined;
  const names = mprisNames(options.mpris);
  if (options.json && !options.once) throw new Error('--json needs --once');

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
      bus = await (deps.mprisBus ?? realBus)();
      for (const name of names) players.push(new MprisPlayer(bus, name));
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
    library
  });
  try {
    hub.start();
    await hub.ready();
    session.start();
    if (options.once) {
      await session.settled();
      return printOnce(session, hub, options, io, deps.now?.());
    }
    for (const { player, problem } of hub.problems()) io.err(`${player}: ${problem}`);
    const printer = new LivePrinter(io);
    await new Promise<void>(resolve => {
      const tick = setInterval(() => printer.render(session, deps.now?.()), deps.tickMs ?? 50);
      const unsubscribe = session.onChange(() => printer.render(session, deps.now?.()));
      let release = () => {};
      const quit = () => {
        clearInterval(tick);
        unsubscribe();
        release();
        process.off('SIGINT', quit);
        process.off('SIGTERM', quit);
        resolve();
      };
      release = keys(deps.input ?? process.stdin, session, io, quit);
      process.once('SIGINT', quit);
      process.once('SIGTERM', quit);
      printer.render(session, deps.now?.());
    });
    return 0;
  } finally {
    session.close();
    await hub.close();
    bus?.close();
    library?.close();
    stores.close();
  }
}
