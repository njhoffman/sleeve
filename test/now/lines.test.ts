import { expect } from 'chai';
import type { LyricLine } from '../../src/core/types.ts';
import { MAX_MS_PER_CHAR, wordFill, wordTexts, wordTimings } from '../../src/now/lines.ts';

const worded: LyricLine = {
  time: 1000, text: 'Hello big world',
  words: [{ time: 1000, text: 'Hello ' }, { time: 1500, text: 'big ' }, { time: 2250, text: 'world' }]
};
const plain: LyricLine = { time: 1000, text: 'ab  cd efgh' };

describe('word timing', () => {
  it('splits a line into its own words, or after each run of spaces', () => {
    expect(wordTexts(worded)).to.deep.equal(['Hello ', 'big ', 'world']);
    expect(wordTexts(plain)).to.deep.equal(['ab  ', 'cd ', 'efgh']);
    expect(wordTexts({ time: 0, text: '' })).to.deep.equal([]);
  });

  it('times words by their own times, the last one up to the next line or its length cap', () => {
    expect(wordTimings(worded, 0, 2600)).to.deep.equal([
      { text: 'Hello ', start: 1000, end: 1500 }, { text: 'big ', start: 1500, end: 2250 }, { text: 'world', start: 2250, end: 2600 }
    ]);
    expect(wordTimings(worded, 0, 60_000)[2].end).to.equal(2250 + 5 * MAX_MS_PER_CHAR);
    expect(wordTimings(worded, 0, null)[2].end).to.equal(2250 + 5 * MAX_MS_PER_CHAR);
  });

  it('applies the offset to word times', () => {
    expect(wordTimings(worded, -200, 2400).map(word => [word.start, word.end])).to.deep.equal([[800, 1300], [1300, 2050], [2050, 2400]]);
  });

  it('never starts a word before the line or the word before it', () => {
    const odd: LyricLine = { time: 1000, text: 'a b c', words: [{ time: 500, text: 'a ' }, { time: 2000, text: 'b ' }, { time: 1500, text: 'c' }] };
    expect(wordTimings(odd, 0, 3000).map(word => [word.start, word.end])).to.deep.equal([[1000, 2000], [2000, 2000], [2000, 2250]]);
  });

  it('estimates words by their length over the time to the next line', () => {
    // 8 letters over 1600 ms: 200 ms each
    expect(wordTimings(plain, 0, 2600)).to.deep.equal([
      { text: 'ab  ', start: 1000, end: 1400 }, { text: 'cd ', start: 1400, end: 1800 }, { text: 'efgh', start: 1800, end: 2600 }
    ]);
  });

  it('caps the estimate, and paces the last line on its own', () => {
    expect(wordTimings(plain, 0, 60_000).at(-1)!.end).to.equal(1000 + 8 * MAX_MS_PER_CHAR);
    const last = wordTimings(plain, 0, null);
    expect(last[0].start).to.equal(1000);
    expect(last.at(-1)!.end).to.be.greaterThan(1000).and.below(1000 + 8 * MAX_MS_PER_CHAR);
    expect(wordTimings({ time: null, text: 'unsynced' }, 0, null)).to.deep.equal([]);
  });

  it('fills a word from 0 to 1 as it plays', () => {
    const word = { text: 'a', start: 1000, end: 1400 };
    expect([900, 1000, 1100, 1400, 2000].map(at => wordFill(word, at))).to.deep.equal([0, 0, 0.25, 1, 1]);
    expect(wordFill({ text: 'a', start: 1000, end: 1000 }, 1000)).to.equal(1);
  });
});
