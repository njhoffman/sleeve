import type { NowState } from '../now/state.ts';
import { lineAt, type CurrentLine } from '../now/lines.ts';
import { monotonic, positionAt } from '../players/clock.ts';
import { Listeners, type Playback } from '../players/types.ts';
import type { PlayerProblem, ServerMessage, WirePlayback } from './messages.ts';

// The daemon's session as a client sees it, rebuilt from the messages it sends: the same NowState, position and
// current line NowPlaying gives in-process, so a display does not care which one it reads. Free of Node imports,
// for the browser renderer as much as for `sleeve now`.

export interface MirrorClocks {
  // Epoch milliseconds, the clock the daemon stamps playback with
  wall?: () => number;
  // The clock positions run on locally (performance.now())
  monotonic?: () => number;
}

// A wire playback on the local monotonic clock
export function fromWire(playback: WirePlayback, { wall = Date.now, monotonic: local = monotonic }: MirrorClocks = {}): Playback {
  const at = local() - (wall() - playback.at);
  return { ...playback, at, changedAt: at };
}

export class SessionMirror {
  private state: NowState = { playback: null, query: null, result: null, loading: false, error: null };
  private problemList: PlayerProblem[] = [];
  private listeners = new Listeners<NowState>();
  private clocks: MirrorClocks;
  version: string | null = null;
  protocol: number | null = null;

  constructor(clocks: MirrorClocks = {}) {
    this.clocks = clocks;
  }

  // Applies a message; whether it changed the state
  apply(message: ServerMessage): boolean {
    switch (message.type) {
      case 'hello':
        this.version = message.version;
        this.protocol = message.protocol;
        return false;
      case 'playback':
        this.state = { ...this.state, playback: message.playback ? fromWire(message.playback, this.clocks) : null };
        break;
      case 'lyrics':
        this.state = { ...this.state, query: message.query, result: message.result, loading: message.loading, error: message.error };
        break;
      case 'offset':
        if (!this.state.result) return false;
        this.state = { ...this.state, result: { ...this.state.result, offsetMs: message.offsetMs } };
        break;
      case 'players':
        this.problemList = message.problems;
        return false;
      default:
        return false;
    }
    this.listeners.emit(this.state);
    return true;
  }

  current(): NowState {
    return this.state;
  }

  problems(): PlayerProblem[] {
    return this.problemList;
  }

  onChange(listener: (state: NowState) => void): () => void {
    return this.listeners.add(listener);
  }

  position(now?: number): number {
    return this.state.playback ? positionAt(this.state.playback, now) : 0;
  }

  line(now?: number): CurrentLine {
    return lineAt(this.state.result, this.position(now));
  }
}
