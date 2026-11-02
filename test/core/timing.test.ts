import { expect } from 'chai';
import { shiftLyrics } from '../../src/core/timing.ts';
import type { Lyrics } from '../../src/core/types.ts';

describe('shiftLyrics', () => {
  const lyrics: Lyrics = { synced: true, instrumental: false, lines: [
    { time: 100, text: 'One two', words: [{ time: 100, text: 'One' }, { time: 600, text: 'two' }] },
    { time: 2000, text: 'Three' }
  ] };

  it('moves line and word times later or sooner, never before the start', () => {
    expect(shiftLyrics(lyrics, 250).lines).to.deep.equal([
      { time: 350, text: 'One two', words: [{ time: 350, text: 'One' }, { time: 850, text: 'two' }] },
      { time: 2250, text: 'Three' }
    ]);
    expect(shiftLyrics(lyrics, -500).lines).to.deep.equal([
      { time: 0, text: 'One two', words: [{ time: 0, text: 'One' }, { time: 100, text: 'two' }] },
      { time: 1500, text: 'Three' }
    ]);
    expect(lyrics.lines[1].time).to.equal(2000);
  });

  it('leaves unsynced lines and a zero offset alone', () => {
    const plain: Lyrics = { synced: false, instrumental: false, lines: [{ time: null, text: 'x' }] };
    expect(shiftLyrics(plain, 300)).to.deep.equal(plain);
    expect(shiftLyrics(lyrics, 0)).to.equal(lyrics);
  });
});
