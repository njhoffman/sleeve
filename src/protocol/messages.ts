import type { LyricsResult, ReportKind, TrackMark, TrackQuery } from '../core/types.ts';
import type { PlaybackState, PlayingTrack } from '../players/types.ts';

// The messages between sleeved and its clients, the same over the WebSocket (one per text frame) and the Unix
// socket (one JSON object per line). docs/protocol.md describes them. Free of Node imports, so a browser
// client imports this file as it is.
//
// The daemon sends state as it changes and each client works out the current line itself from the lyrics and
// the playback clock; clients that cannot (shell scripts, status bars) subscribe to `line` messages instead.

export const PROTOCOL_VERSION = 1;

// What a page shows besides the lyrics, and where
export const NOW_PRESETS = ['lyrics', 'minimal', 'full'] as const;
export const NOW_POSITIONS = ['top-left', 'top-center', 'top-right', 'center-left', 'center-right', 'bottom-left', 'bottom-center', 'bottom-right'] as const;
export const LYRICS_ALIGNS = ['left', 'center', 'right'] as const;
export type NowPreset = typeof NOW_PRESETS[number];
export type NowPosition = typeof NOW_POSITIONS[number];
export type LyricsAlign = typeof LYRICS_ALIGNS[number];

// A part of the window, relative to it: WxH+X+Y, each part pixels or a percentage of the window ("33%x100%+0+0")
export interface AreaLength {
  value: number;
  percent: boolean;
}
export interface Area {
  width: AreaLength;
  height: AreaLength;
  x: AreaLength;
  y: AreaLength;
}

const AREA_LENGTH = '\\d+(?:\\.\\d+)?%?';
const AREA = new RegExp(`^(${AREA_LENGTH})x(${AREA_LENGTH})([+-]${AREA_LENGTH})([+-]${AREA_LENGTH})$`);

// The area an option names; null for a form it cannot read or one with no size
export function parseArea(text: string): Area | null {
  const match = AREA.exec(text.trim());
  if (!match) return null;
  const [width, height, x, y] = match.slice(1).map(part => ({ value: Number.parseFloat(part), percent: part.endsWith('%') }));
  return width.value > 0 && height.value > 0 ? { width, height, x, y } : null;
}

// What fills the window behind the content. A color's alpha, or the cover's, is the background's alone: text stays solid.
export type PageBackground =
  | { kind: 'transparent' }
  | { kind: 'color'; color: string; alpha: number }
  // alpha null: the cover over the page's own color, as a window draws it; a number: at that opacity, over what is behind the window
  | { kind: 'cover'; alpha: number | null };

// transparent, #rrggbb, #rrggbbaa, cover or cover@0.6; null for anything else
export function parseBackground(text: string): PageBackground | null {
  const value = text.trim().toLowerCase();
  if (value === 'transparent') return { kind: 'transparent' };
  if (value === 'cover') return { kind: 'cover', alpha: null };
  const cover = /^cover@(\d*\.?\d+)$/.exec(value);
  if (cover) {
    const alpha = Number(cover[1]);
    return alpha <= 1 ? { kind: 'cover', alpha } : null;
  }
  const color = /^(#[0-9a-f]{6})([0-9a-f]{2})?$/.exec(value);
  return color ? { kind: 'color', color: color[1], alpha: color[2] ? Number.parseInt(color[2], 16) / 255 : 1 } : null;
}

// Stylesheet variables a page takes from its URL or a display change, over its stylesheet: the cover and its animation
// (--art-*, --flow-*, --swirl-*), the scrim behind the lyrics (--lyrics-scrim*) and the now-playing panel's size and
// distance from the edge (--now-scale, --now-margin, since 0.49.0), all but the two the page works out itself. Values keep to a set of characters that cannot leave a declaration or load anything (no quotes, semicolons,
// braces, slashes or url()), so a page can write them into a stylesheet as they are. An empty value removes the name.
export type StyleVariables = Record<string, string>;
const STYLE_NAME = /^--(?:art|flow|swirl)-[a-z][a-z0-9-]*$|^--lyrics-scrim(?:-[a-z][a-z0-9-]*)?$|^--now-(?:scale|margin)$/;
const STYLE_COMPUTED = ['--art-layer-opacity', '--lyrics-scrim-alpha', '--swirl-tint-color'];
const STYLE_VALUE = /^[a-z0-9 .,%()#+-]{0,100}$/i;
export const STYLE_HELP = '--art-*, --flow-*, --swirl-*, --lyrics-scrim*, --now-scale or --now-margin names, with values of letters, digits, spaces and . , % ( ) # + -';

export function styleNameError(name: string): string | null {
  if (!STYLE_NAME.test(name) || STYLE_COMPUTED.includes(name)) return `${name} is not a stylesheet variable a page takes (${STYLE_HELP})`;
  return null;
}

export function styleValueError(name: string, value: string): string | null {
  if (!STYLE_VALUE.test(value) || /url\s*\(/i.test(value)) return `${name}: ${value} has characters a page does not take (${STYLE_HELP})`;
  return null;
}

// A style map from untrusted JSON: the map, or the reason it is not one
export function parseStyle(value: unknown): { style: StyleVariables } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'it needs to be an object of stylesheet variables' };
  const style: StyleVariables = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string') return { error: `${name} needs to be a string` };
    const error = styleNameError(name) ?? styleValueError(name, entry.trim());
    if (error) return { error };
    style[name] = entry.trim();
  }
  return { style };
}

// NAME=VALUE pairs (flags), or NAME:VALUE;NAME:VALUE (a URL's ?style=), as a style map; the reason when one is wrong
export function parseStylePairs(pairs: readonly string[], separator: '=' | ':'): { style: StyleVariables } | { error: string } {
  const entries: Record<string, string> = {};
  for (const pair of pairs) {
    if (!pair.trim()) continue;
    const at = pair.indexOf(separator);
    if (at < 1) return { error: `${pair} is not NAME${separator}VALUE` };
    entries[pair.slice(0, at).trim()] = pair.slice(at + 1);
  }
  return parseStyle(entries);
}

export const styleParam = (style: StyleVariables) => Object.entries(style).map(([name, value]) => `${name}:${value}`).join(';');

// Changes to how pages look, over what their URL and stylesheet say, until sleeved restarts
export interface DisplayChange {
  preset?: NowPreset;
  position?: NowPosition;
  align?: LyricsAlign;
  // Where the lyrics lay out, and where the now-playing panel stands, inside the window (see parseArea)
  lyricsArea?: string;
  nowArea?: string;
  // What fills the window behind the content (see parseBackground)
  background?: string;
  // Stylesheet variables over the page's stylesheet (see StyleVariables); a change merges with the last, name by name
  style?: StyleVariables;
  // false hides the lyrics and the panel without closing the page; the background stays
  visible?: boolean;
}
// For every page, and by the instance a page names (?instance=); an instance's change wins for it
export const ALL_INSTANCES = '*';
export type Displays = Record<string, DisplayChange>;

// Where playback is: positionMs at `at`, a wall-clock time (epoch milliseconds, Date.now()), running on at
// `rate` while playing. Daemon and clients share the machine and so its wall clock, which makes the position
// exact whatever the message's delay.
export interface WirePlayback {
  player: string;
  state: PlaybackState;
  track: PlayingTrack | null;
  positionMs: number;
  at: number;
  rate: number;
}

export interface PlayerProblem {
  player: string;
  problem: string;
}

export interface WireLine {
  // -1 before the first line, or without synced lyrics
  index: number;
  text: string | null;
  // When the line starts, the offset applied (ms into the track)
  timeMs: number | null;
}

// Daemon to client

export interface HelloMessage {
  type: 'hello';
  protocol: number;
  version: string;
}

export interface PlaybackMessage {
  type: 'playback';
  playback: WirePlayback | null;
}

// The lookup for the track playing: sent when the track changes, when its lookup starts and ends, and after a
// pick or refresh. `key` names the track ("player:track key"), null when nothing plays.
export interface LyricsMessage {
  type: 'lyrics';
  key: string | null;
  query: TrackQuery | null;
  loading: boolean;
  error: string | null;
  result: LyricsResult | null;
}

// The offset of the lyrics shown changed (a nudge); everything else in the last lyrics message stands
export interface OffsetMessage {
  type: 'offset';
  offsetMs: number;
}

export interface PlayersMessage {
  type: 'players';
  problems: PlayerProblem[];
}

// To clients that subscribed to lines: the line now playing, whenever it changes
export interface LineMessage {
  type: 'line';
  key: string | null;
  line: WireLine;
}

// Every change in force, sent when one is made, and on connecting when there are any
export interface DisplayMessage {
  type: 'display';
  displays: Displays;
}

export interface ReplyMessage {
  type: 'reply';
  // The command's id, when it gave one
  id?: string | number;
  ok: boolean;
  error?: string;
  data?: unknown;
}

export type ServerMessage = HelloMessage | PlaybackMessage | LyricsMessage | OffsetMessage | PlayersMessage | LineMessage | DisplayMessage | ReplyMessage;

// Client to daemon. Every command is answered with a reply carrying its id.

interface Command {
  id?: string | number;
}

export interface NudgeCommand extends Command { type: 'nudge'; ms: number }
export interface OffsetCommand extends Command { type: 'offset'; ms: number }
export interface PickCommand extends Command { type: 'pick'; ref: string }
export interface MarkCommand extends Command { type: 'mark'; mark: TrackMark }
export interface UnpickCommand extends Command { type: 'unpick' }
// The lyrics shown are wrong or mistimed: remembered for the track, and the next best shown
export interface ReportCommand extends Command { type: 'report'; kind: ReportKind }
// Forgets what was reported about the track playing
export interface UnreportCommand extends Command { type: 'unreport' }
// Plays from ms into the track playing, in the player playing it
export interface SeekCommand extends Command { type: 'seek'; ms: number }
// Changes how one instance's page looks, or every page's without one; reset forgets the changes made for it
export interface DisplayCommand extends Command, DisplayChange { type: 'display'; instance?: string; reset?: boolean }
export interface RefreshCommand extends Command { type: 'refresh' }
export interface CandidatesCommand extends Command { type: 'candidates' }
// Sends the playback, lyrics and players messages again (and the line, to a subscriber)
export interface StateCommand extends Command { type: 'state' }
export interface SubscribeCommand extends Command { type: 'subscribe'; lines: boolean }

export type ClientCommand = NudgeCommand | OffsetCommand | PickCommand | MarkCommand | UnpickCommand | ReportCommand | UnreportCommand | SeekCommand | DisplayCommand | RefreshCommand | CandidatesCommand
  | StateCommand | SubscribeCommand;

export const COMMANDS: ReadonlyArray<ClientCommand['type']> = ['nudge', 'offset', 'pick', 'mark', 'unpick', 'report', 'unreport', 'seek', 'display', 'refresh', 'candidates', 'state', 'subscribe'];

// What a report command replies: the lyrics reported, what shows now (null for nothing), and whether that is their words
// alone, nothing else having been found
export interface ReportReply {
  kind: ReportKind;
  ref: string;
  next: string | null;
  untimed: boolean;
}

// The reply in a sentence, for a key's toast and for sleeve ctl
export function describeReport({ kind, ref, next, untimed }: ReportReply): string {
  const shows = untimed ? 'showing the words without times' : next ? `showing ${next}` : 'no lyrics left';
  return `${kind === 'wrong' ? 'Wrong lyrics' : 'Wrong times'}: ${ref}; ${shows}`;
}

// A command from untrusted JSON text, or why it is not one
export function parseCommand(text: string): { command: ClientCommand } | { error: string; id?: string | number } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: 'Not JSON' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'Not a JSON object' };
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' || typeof record.id === 'number' ? record.id : undefined;
  const failed = (error: string) => ({ error, ...(id !== undefined ? { id } : {}) });
  if (record.id !== undefined && id === undefined) return failed('id must be a string or a number');
  const type = record.type;
  if (typeof type !== 'string' || !(COMMANDS as string[]).includes(type)) return failed(`Unknown command: ${String(type)}`);
  if ((type === 'nudge' || type === 'offset') && !Number.isInteger(record.ms)) return failed(`${type} needs ms, whole milliseconds`);
  if (type === 'pick' && (typeof record.ref !== 'string' || !record.ref)) return failed('pick needs ref, as provider:id');
  if (type === 'mark' && record.mark !== 'none' && record.mark !== 'instrumental') return failed('mark needs mark, none or instrumental');
  if (type === 'report' && record.kind !== 'wrong' && record.kind !== 'mistimed') return failed('report needs kind, wrong or mistimed');
  if (type === 'seek' && (!Number.isInteger(record.ms) || (record.ms as number) < 0)) return failed('seek needs ms, whole milliseconds, not negative');
  if (type === 'display') {
    if (record.instance !== undefined && (typeof record.instance !== 'string' || !record.instance)) return failed('display needs instance to be a name');
    if (record.preset !== undefined && !(NOW_PRESETS as readonly unknown[]).includes(record.preset)) return failed(`display needs preset to be ${NOW_PRESETS.join(', ')}`);
    if (record.position !== undefined && !(NOW_POSITIONS as readonly unknown[]).includes(record.position)) return failed(`display needs position to be ${NOW_POSITIONS.join(', ')}`);
    if (record.align !== undefined && !(LYRICS_ALIGNS as readonly unknown[]).includes(record.align)) return failed(`display needs align to be ${LYRICS_ALIGNS.join(', ')}`);
    for (const name of ['lyricsArea', 'nowArea']) {
      if (record[name] !== undefined && (typeof record[name] !== 'string' || !parseArea(record[name] as string))) return failed(`display needs ${name} to be WxH+X+Y, in pixels or percent, not ${String(record[name])}`);
    }
    if (record.background !== undefined && (typeof record.background !== 'string' || !parseBackground(record.background))) return failed(`display needs background to be transparent, #rrggbb, #rrggbbaa, cover or cover@0.6, not ${String(record.background)}`);
    if (record.style !== undefined) {
      const style = parseStyle(record.style);
      if ('error' in style) return failed(`display has a style it cannot take: ${style.error}`);
    }
    if (record.visible !== undefined && typeof record.visible !== 'boolean') return failed('display needs visible to be true or false');
    if (record.reset !== undefined && typeof record.reset !== 'boolean') return failed('display needs reset to be true or false');
    if (['preset', 'position', 'align', 'lyricsArea', 'nowArea', 'background', 'style', 'visible', 'reset'].every(key => record[key] === undefined)) return failed('display needs something to change');
  }
  if (type === 'subscribe' && typeof record.lines !== 'boolean') return failed('subscribe needs lines, true or false');
  return { command: record as unknown as ClientCommand };
}
