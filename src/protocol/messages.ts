import type { LyricsResult, TrackMark, TrackQuery } from '../core/types.ts';
import type { PlaybackState, PlayingTrack } from '../players/types.ts';

// The messages between sleeved and its clients, the same over the WebSocket (one per text frame) and the Unix
// socket (one JSON object per line). docs/protocol.md describes them. Free of Node imports, so a browser
// client imports this file as it is.
//
// The daemon sends state as it changes and each client works out the current line itself from the lyrics and
// the playback clock; clients that cannot (shell scripts, status bars) subscribe to `line` messages instead.

export const PROTOCOL_VERSION = 1;

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

export interface ReplyMessage {
  type: 'reply';
  // The command's id, when it gave one
  id?: string | number;
  ok: boolean;
  error?: string;
  data?: unknown;
}

export type ServerMessage = HelloMessage | PlaybackMessage | LyricsMessage | OffsetMessage | PlayersMessage | LineMessage | ReplyMessage;

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
export interface RefreshCommand extends Command { type: 'refresh' }
export interface CandidatesCommand extends Command { type: 'candidates' }
// Sends the playback, lyrics and players messages again (and the line, to a subscriber)
export interface StateCommand extends Command { type: 'state' }
export interface SubscribeCommand extends Command { type: 'subscribe'; lines: boolean }

export type ClientCommand = NudgeCommand | OffsetCommand | PickCommand | MarkCommand | UnpickCommand | SeekCommand | RefreshCommand | CandidatesCommand
  | StateCommand | SubscribeCommand;

export const COMMANDS: ReadonlyArray<ClientCommand['type']> = ['nudge', 'offset', 'pick', 'mark', 'unpick', 'seek', 'refresh', 'candidates', 'state', 'subscribe'];

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
  if (type === 'subscribe' && typeof record.lines !== 'boolean') return failed('subscribe needs lines, true or false');
  return { command: record as unknown as ClientCommand };
}
