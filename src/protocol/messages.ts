import type { LyricsResult, TrackMark, TrackQuery } from '../core/types.ts';
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

// Changes to how pages look, over what their URL and stylesheet say, until sleeved restarts
export interface DisplayChange {
  preset?: NowPreset;
  position?: NowPosition;
  align?: LyricsAlign;
  // Where the lyrics lay out, and where the now-playing panel stands, inside the window (see parseArea)
  lyricsArea?: string;
  nowArea?: string;
  // false hides the page without closing it
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
// Plays from ms into the track playing, in the player playing it
export interface SeekCommand extends Command { type: 'seek'; ms: number }
// Changes how one instance's page looks, or every page's without one; reset forgets the changes made for it
export interface DisplayCommand extends Command, DisplayChange { type: 'display'; instance?: string; reset?: boolean }
export interface RefreshCommand extends Command { type: 'refresh' }
export interface CandidatesCommand extends Command { type: 'candidates' }
// Sends the playback, lyrics and players messages again (and the line, to a subscriber)
export interface StateCommand extends Command { type: 'state' }
export interface SubscribeCommand extends Command { type: 'subscribe'; lines: boolean }

export type ClientCommand = NudgeCommand | OffsetCommand | PickCommand | MarkCommand | UnpickCommand | SeekCommand | DisplayCommand | RefreshCommand | CandidatesCommand
  | StateCommand | SubscribeCommand;

export const COMMANDS: ReadonlyArray<ClientCommand['type']> = ['nudge', 'offset', 'pick', 'mark', 'unpick', 'seek', 'display', 'refresh', 'candidates', 'state', 'subscribe'];

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
  if (type === 'seek' && (!Number.isInteger(record.ms) || (record.ms as number) < 0)) return failed('seek needs ms, whole milliseconds, not negative');
  if (type === 'display') {
    if (record.instance !== undefined && (typeof record.instance !== 'string' || !record.instance)) return failed('display needs instance to be a name');
    if (record.preset !== undefined && !(NOW_PRESETS as readonly unknown[]).includes(record.preset)) return failed(`display needs preset to be ${NOW_PRESETS.join(', ')}`);
    if (record.position !== undefined && !(NOW_POSITIONS as readonly unknown[]).includes(record.position)) return failed(`display needs position to be ${NOW_POSITIONS.join(', ')}`);
    if (record.align !== undefined && !(LYRICS_ALIGNS as readonly unknown[]).includes(record.align)) return failed(`display needs align to be ${LYRICS_ALIGNS.join(', ')}`);
    for (const name of ['lyricsArea', 'nowArea']) {
      if (record[name] !== undefined && (typeof record[name] !== 'string' || !parseArea(record[name] as string))) return failed(`display needs ${name} to be WxH+X+Y, in pixels or percent, not ${String(record[name])}`);
    }
    if (record.visible !== undefined && typeof record.visible !== 'boolean') return failed('display needs visible to be true or false');
    if (record.reset !== undefined && typeof record.reset !== 'boolean') return failed('display needs reset to be true or false');
    if (['preset', 'position', 'align', 'lyricsArea', 'nowArea', 'visible', 'reset'].every(key => record[key] === undefined)) return failed('display needs something to change');
  }
  if (type === 'subscribe' && typeof record.lines !== 'boolean') return failed('subscribe needs lines, true or false');
  return { command: record as unknown as ClientCommand };
}
