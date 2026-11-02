import { Listeners, type Playback, type Player } from './types.ts';

// Every player at once, and the one that counts: the one playing (Spotify when several are, as musicman
// chooses), else the one paused most recently, else none. Every change of any player is passed on with the
// active playback, since a paused player becoming active matters as much as a seek.

export interface PlaybackSource {
  active(): Playback | null;
  onChange(listener: (active: Playback | null) => void): () => void;
}

export function choosePlayback(playbacks: Array<Playback | null>): Playback | null {
  const known = playbacks.filter((playback): playback is Playback => playback !== null && playback.track !== null);
  const playing = known.filter(playback => playback.state === 'playing');
  if (playing.length) return playing.find(playback => playback.player === 'spotify') ?? playing[0];
  const paused = known.filter(playback => playback.state === 'paused').sort((a, b) => b.changedAt - a.changedAt);
  return paused[0] ?? null;
}

export class PlayerHub implements PlaybackSource {
  readonly players: Player[];
  private listeners = new Listeners<Playback | null>();
  private unsubscribe: Array<() => void> = [];

  constructor(players: Player[]) {
    this.players = players;
  }

  start(): void {
    for (const player of this.players) {
      this.unsubscribe.push(player.onChange(() => this.listeners.emit(this.active())));
      player.start();
    }
  }

  // Once every player has answered or failed its first attempt
  async ready(): Promise<void> {
    await Promise.all(this.players.map(player => player.ready()));
  }

  active(): Playback | null {
    return choosePlayback(this.players.map(player => player.current()));
  }

  onChange(listener: (active: Playback | null) => void): () => void {
    return this.listeners.add(listener);
  }

  // Players that cannot be reached, with why
  problems(): Array<{ player: string; problem: string }> {
    return this.players.flatMap(player => {
      const problem = player.problem();
      return problem ? [{ player: player.name, problem }] : [];
    });
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    await Promise.all(this.players.map(player => player.close()));
  }
}
