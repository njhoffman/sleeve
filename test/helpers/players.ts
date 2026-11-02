import { Listeners, type Playback, type Player } from '../../src/players/types.ts';

// A player whose playback the test sets
export interface FakePlayer extends Player {
  set(playback: Playback | null): void;
  closed: boolean;
}

export function fakePlayer(name: string, { problem = null, playback = null }: { problem?: string | null; playback?: Playback | null } = {}): FakePlayer {
  const listeners = new Listeners<Playback | null>();
  let current = playback;
  const player: FakePlayer = {
    name,
    closed: false,
    start() {},
    ready: async () => {},
    current: () => current,
    problem: () => problem,
    onChange: listener => listeners.add(listener),
    set(next) { current = next; listeners.emit(next); },
    async close() { player.closed = true; }
  };
  return player;
}
