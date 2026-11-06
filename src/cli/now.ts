import type { LyricsResult } from '../core/types.ts';
import { DaemonClient } from '../daemon/client.ts';
import { defaultSocketPath } from '../daemon/paths.ts';
import { nextLineTime, wordTimings, type CurrentLine } from '../now/lines.ts';
import type { NowState } from '../now/state.ts';
import { clockTime } from '../players/clock.ts';
import type { PlayerProblem } from '../protocol/messages.ts';
import { describeCandidate, errStyle, formatOffset, outStyle, warn, type Io } from './lyrics.ts';
import { openSession, shapesSession, type SessionCliOptions, type SessionDeps } from './session.ts';
import { gradientBar, paint, type Paint } from './style.ts';

// `sleeve now`: lyrics for what MPD or Spotify plays, line by line as they come due, with + and - to nudge the
// timing (saved for the track) and q to quit; `--once` prints where playback is and the current line. In a terminal
// (and without NO_COLOR) a line with word times is drawn in place as it is sung, the words still to come dim;
// --estimate-words times every line that way, by word length.
//
// When sleeved runs, `sleeve now` shows its session instead of opening the players itself (so a nudge here moves
// the lyrics in every display), unless an option asks for players, providers or stores of its own, or
// --no-daemon. --daemon insists on the daemon.

export interface NowOptions extends SessionCliOptions {
  once?: boolean;
  json?: boolean;
  // undefined: the daemon when it runs; true: only the daemon; false: never
  daemon?: boolean;
  socket?: string;
  estimateWords?: boolean;
}

export const NUDGE_MS = 100;

export interface NowDeps extends SessionDeps {
  input?: NodeJS.ReadStream;
  // Where a line is drawn in place; stdout by default, used when it is a terminal and NO_COLOR is not set
  output?: { isTTY?: boolean; write(text: string): unknown };
  tickMs?: number;
  now?: () => number;
}

// What printing needs, from the session in-process or the daemon's mirror
export interface NowView {
  current(): NowState;
  line(now?: number): CurrentLine;
  position(now?: number): number;
  problems(): PlayerProblem[];
  // The new offset, or why there is none
  nudge(deltaMs: number): Promise<{ offsetMs: number } | { error: string }>;
  // Resolves once the current track's lookup has finished
  settled(): Promise<void>;
  // Resolves when the session goes away underneath (the daemon stopped); never for one in-process
  lost: Promise<void>;
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

function sourceLine(result: LyricsResult | null, paints?: Paint): string {
  if (result?.marked) return result.marked === 'none' ? 'marked as having no correct lyrics' : 'marked as instrumental';
  if (!result?.best) return 'no lyrics found';
  const decided = `${result.pinned ? ', pinned' : ''}${result.offsetMs ? `, offset ${formatOffset(result.offsetMs)}` : ''}`;
  return `${describeCandidate(result.best, paints)}${decided}`;
}

// Prints what changed since it last printed: the track, where its lyrics came from, pauses, and each line as it
// becomes current (again after a seek back). With a live writer, a line with word times (or estimated ones) is
// drawn in place as it is sung, the words to come dim, and becomes an ordinary line once the next one starts or
// anything else is printed.
export interface LiveOptions {
  write(text: string): unknown;
  estimateWords?: boolean;
}

const CLEAR_LINE = '\r\u001b[2K';
const DIM = '\u001b[2m';
const UNDIM = '\u001b[22m';

export class LivePrinter {
  private io: Io;
  private live: LiveOptions | null;
  private track: string | null | undefined = undefined;
  private looked = false;
  private paused = false;
  private lastLine = -2;
  // The line being drawn in place, and how many of its words were sung when it was drawn
  private drawing: { text: string; sung: number } | null = null;
  private paints: Paint;

  constructor(io: Io, live: LiveOptions | null = null) {
    this.io = io;
    this.live = live;
    this.paints = paint(outStyle(io));
  }

  // Prints a line of its own, ending the one drawn in place first
  say(text: string): void {
    this.settle();
    this.io.out(text);
  }

  // The line drawn in place, left as an ordinary line
  private settle(): void {
    if (!this.drawing) return;
    this.live!.write(`${CLEAR_LINE}${this.drawing.text}\n`);
    this.drawing = null;
  }

  // position is needed only to draw lines in place
  render(session: Pick<NowView, 'current' | 'line'> & Partial<Pick<NowView, 'position'>>, now?: number): void {
    const state = session.current();
    const playback = state.playback;
    const key = playback?.track ? `${playback.player}:${playback.track.key}` : null;
    if (key !== this.track) {
      this.track = key;
      this.looked = false;
      this.paused = false;
      this.lastLine = -2;
      this.say(key ? `\n${this.paints.bold(`== ${trackLine(state)}`)} ${this.paints.dim(`[${playback!.player}]`)}` : `\n${this.paints.bold('== Nothing playing')}`);
    }
    if (!key) return;
    if (!state.loading && !this.looked) {
      this.looked = true;
      const rich = outStyle(this.io).rich ? this.paints : undefined;
      this.say(`${this.paints.dim('--')} ${state.error ? this.paints.red(`lookup failed: ${state.error}`) : state.query ? sourceLine(state.result, rich) : 'no artist or title to look up'}`);
      for (const failure of failures(state.result)) this.say(this.paints.yellow(`-- ${failure}`));
      const lyrics = state.result?.best?.lyrics;
      if (lyrics?.instrumental) this.say('(instrumental)');
      else if (lyrics && !lyrics.synced) for (const line of lyrics.lines) this.say(line.text);
    }
    const paused = playback!.state !== 'playing';
    if (paused !== this.paused) {
      this.paused = paused;
      this.say(this.paints.dim(paused ? '-- paused' : '-- playing'));
    }
    if (state.loading) return;
    const current = session.line(now);
    if (current.index !== this.lastLine) {
      this.settle();
      this.lastLine = current.index;
      if (!current.line?.text) return;
      const text = `${this.paints.dim(`[${clockTime(current.time!)}]`)} ${current.line.text}`;
      if (!this.live || !session.position || !(current.line.words?.length || this.live.estimateWords)) return this.io.out(text);
      this.drawing = { text, sung: -1 };
    }
    if (this.drawing && current.line && session.position) this.draw(current, state, session.position(now));
  }

  // The line in place: sung words as they are, the rest dim; drawn again only when another word comes due
  private draw(current: CurrentLine, state: NowState, positionMs: number): void {
    const words = wordTimings(current.line!, state.result!.offsetMs, nextLineTime(state.result, positionMs));
    // A word lights up as it starts: a terminal has no partial fill
    const sung = words.filter(word => positionMs >= word.start).length;
    if (sung === this.drawing!.sung) return;
    this.drawing!.sung = sung;
    const done = words.slice(0, sung).map(word => word.text).join('');
    const rest = words.slice(sung).map(word => word.text).join('');
    this.live!.write(`${CLEAR_LINE}${this.paints.dim(`[${clockTime(current.time!)}]`)} ${done}${rest ? `${DIM}${rest}${UNDIM}` : ''}`);
  }

  // Ends the line in place, when following stops
  close(): void {
    this.settle();
  }
}


function snapshot(view: NowView, now?: number) {
  const state = view.current();
  const playback = state.playback;
  const line = view.line(now);
  return {
    player: playback?.player ?? null,
    state: playback?.state ?? null,
    positionMs: playback ? Math.round(view.position(now)) : null,
    track: playback?.track ?? null,
    query: state.query,
    lyrics: state.result,
    line: line.line ? { index: line.index, timeMs: line.time, text: line.line.text } : null,
    problems: view.problems()
  };
}

function printOnce(view: NowView, options: NowOptions, io: Io, now?: number): number {
  const shot = snapshot(view, now);
  if (options.json) {
    io.out(JSON.stringify(shot, null, 2));
    return shot.track ? 0 : 1;
  }
  const state = view.current();
  if (!shot.track) {
    io.out('Nothing playing');
    for (const { player, problem } of shot.problems) warn(io, `${errStyle(io).rich ? '' : '  '}${player}: ${problem}`);
    return 1;
  }
  const length = shot.track.durationMs ? `/${clockTime(shot.track.durationMs)}` : '';
  const style = outStyle(io);
  if (style.rich) {
    const paints = paint(style);
    const stateColor = shot.state === 'playing' ? paints.green : paints.yellow;
    const position = shot.track.durationMs ? `${gradientBar(shot.positionMs! / shot.track.durationMs, 24, style.depth)} ` : '';
    io.out(`${paints.bold(trackLine(state))}`);
    io.out(`${stateColor(String(shot.state))} ${paints.dim(String(shot.player))}  ${position}${clockTime(shot.positionMs!)}${paints.dim(length)}`);
    io.out(state.query ? sourceLine(state.result, paints) : 'no artist or title to look up');
    for (const failure of failures(state.result)) warn(io, failure);
    if (shot.line) io.out(`${paints.cyan('>')} ${shot.line.text}`);
    return 0;
  }
  io.out(`${shot.player} ${shot.state} ${clockTime(shot.positionMs!)}${length} ${trackLine(state)}`);
  io.out(state.query ? sourceLine(state.result) : 'no artist or title to look up');
  for (const failure of failures(state.result)) io.err(`  ${failure}`);
  if (shot.line) io.out(`> ${shot.line.text}`);
  return 0;
}

// Raw keys from a terminal: + and - nudge, q quits
function keys(input: NodeJS.ReadStream | undefined, view: NowView, say: (text: string) => void, quit: () => void): () => void {
  if (!input?.isTTY) return () => {};
  input.setRawMode(true);
  input.resume();
  const press = (data: Buffer) => {
    for (const key of data.toString()) {
      if (key === 'q' || key === '\u0003') quit();
      const delta = key === '+' || key === '=' ? NUDGE_MS : key === '-' || key === '_' ? -NUDGE_MS : 0;
      if (!delta) continue;
      void view.nudge(delta).then(answer => {
        say('error' in answer ? `-- ${answer.error.toLowerCase()}` : `-- offset ${answer.offsetMs ? formatOffset(answer.offsetMs) : 'removed'}`);
      });
    }
  };
  input.on('data', press);
  return () => {
    input.off('data', press);
    input.setRawMode(false);
    input.pause();
  };
}

// Prints lines as they come due until q, a signal, or the session going away; 0, or 1 when the daemon stopped
async function follow(view: NowView, onChange: (listener: () => void) => () => void, io: Io, deps: NowDeps, options: NowOptions): Promise<number> {
  for (const { player, problem } of view.problems()) warn(io, `${player}: ${problem}`);
  const output = deps.output ?? process.stdout;
  const colors = output.isTTY && !(deps.env ?? process.env).NO_COLOR;
  const printer = new LivePrinter(io, colors ? { write: text => output.write(text), estimateWords: options.estimateWords === true } : null);
  return new Promise<number>(resolve => {
    const render = () => printer.render(view, deps.now?.());
    const tick = setInterval(render, deps.tickMs ?? 50);
    const unsubscribe = onChange(render);
    let release = () => {};
    const quit = (code: number) => {
      clearInterval(tick);
      unsubscribe();
      release();
      printer.close();
      process.off('SIGINT', interrupted);
      process.off('SIGTERM', interrupted);
      resolve(code);
    };
    const interrupted = () => quit(0);
    release = keys(deps.input ?? process.stdin, view, text => printer.say(text), () => quit(0));
    process.once('SIGINT', interrupted);
    process.once('SIGTERM', interrupted);
    void view.lost.then(() => {
      printer.close();
      warn(io, '-- sleeved stopped');
      quit(1);
    });
    render();
  });
}

async function local(options: NowOptions, io: Io, deps: NowDeps): Promise<number> {
  const { session, hub, close } = await openSession(options, io, deps);
  const view: NowView = {
    current: () => session.current(),
    line: now => session.line(now),
    position: now => session.position(now),
    problems: () => hub.problems(),
    nudge: async delta => {
      const offsetMs = session.nudge(delta);
      if (offsetMs !== null) return { offsetMs };
      return { error: session.current().loading ? 'Still looking up lyrics' : 'No lyrics to move' };
    },
    settled: async () => { await session.settled(); },
    lost: new Promise(() => {})
  };
  try {
    if (options.once) {
      await view.settled();
      return printOnce(view, options, io, deps.now?.());
    }
    return await follow(view, listener => session.onChange(listener), io, deps, options);
  } finally {
    await close();
  }
}

async function remote(client: DaemonClient, options: NowOptions, io: Io, deps: NowDeps): Promise<number> {
  const mirror = client.mirror;
  const view: NowView = {
    current: () => mirror.current(),
    line: now => mirror.line(now),
    position: now => mirror.position(now),
    problems: () => mirror.problems(),
    nudge: async delta => {
      const reply = await client.send({ type: 'nudge', ms: delta });
      return reply.ok ? (reply.data as { offsetMs: number }) : { error: reply.error ?? 'failed' };
    },
    settled: () => new Promise(resolve => {
      if (!mirror.current().loading || !client.open) return resolve();
      const stop = mirror.onChange(state => {
        if (state.loading) return;
        stop();
        resolve();
      });
      client.onClose(() => resolve());
    }),
    lost: new Promise(resolve => client.onClose(resolve))
  };
  try {
    if (options.once) {
      await view.settled();
      return printOnce(view, options, io, deps.now?.());
    }
    io.err(paint(errStyle(io)).dim(`-- following sleeved (${client.socketPath})`));
    return await follow(view, listener => mirror.onChange(listener), io, deps, options);
  } finally {
    client.close();
  }
}

export async function nowCommand(options: NowOptions, io: Io, deps: NowDeps = {}): Promise<number> {
  if (options.json && !options.once) throw new Error('--json needs --once');
  const own = shapesSession(options);
  if (options.daemon === true && own) throw new Error('--daemon takes no player, provider or store options: sleeved has its own');
  // A test that gives its own players never reaches for a real daemon
  const tryDaemon = options.daemon === true || (options.daemon === undefined && !own && !deps.players);
  if (tryDaemon) {
    const socketPath = options.socket ?? defaultSocketPath(deps.env);
    const client = await DaemonClient.connect(socketPath);
    if (client) return remote(client, options, io, deps);
    if (options.daemon === true) throw new Error(`sleeved is not running (nothing answers at ${socketPath})`);
  }
  return local(options, io, deps);
}
