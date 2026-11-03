import { expect } from 'chai';
import { isLatin, latinCandidate, latinLyrics, normalizeLatin } from '../../src/core/script.ts';
import type { Candidate, Lyrics } from '../../src/core/types.ts';

const lyrics = (...texts: string[]): Lyrics => ({ synced: true, instrumental: false, lines: texts.map((text, index) => ({ time: index * 1000, text })) });
const candidate = (lines: Lyrics, track: Partial<Candidate['track']> = {}): Candidate => ({
  provider: 'netease', id: '1', track: { artist: 'Coldplay', title: 'Sparks', album: 'Parachutes', ...track }, lyrics: lines
});

describe('Latin script only', () => {
  it('puts look-alikes right inside Latin words, and leaves accents and real Cyrillic alone', () => {
    // Cyrillic е in "onе" and "hеre"
    expect(normalizeLatin('No onе treats me, all boys out hеre')).to.equal('No one treats me, all boys out here');
    expect(normalizeLatin('Café, niño, Ø')).to.equal('Café, niño, Ø');
    expect(normalizeLatin('Привет')).to.equal('Привет');
    // A word of look-alikes with a letter that has none stays as it was
    expect(normalizeLatin('hеж')).to.equal('hеж');
    expect(normalizeLatin('（Intro）：　go')).to.equal('(Intro): go');
    expect(isLatin('hеre')).to.equal(true);
    expect(isLatin('Привет')).to.equal(false);
    expect(isLatin('1999 ... !')).to.equal(true);
  });

  it('drops lines in another alphabet: credits, notes and translated titles', () => {
    // Two of ten lines: a fifth, the most that may go
    const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].map(word => `Line ${word}`);
    const kept = latinLyrics(lyrics('Surround Sound （太阳帝国）', ...words, '钢琴 : Benmont Tench', ''));
    expect(kept!.lines.map(line => line.text)).to.deep.equal([...words, '']);
    expect(kept!.lines.map(line => line.time)).to.deep.equal([1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 10000]);
  });

  it('leaves out lyrics with more than a fifth of their lines in another alphabet', () => {
    expect(latinLyrics(lyrics('One', 'Two', 'Three', 'Four', '四'))).to.not.equal(null);
    expect(latinLyrics(lyrics('One', 'Two', 'Three', '三', '四'))).to.equal(null);
    expect(latinLyrics(lyrics('사랑해', '보고 싶어'))).to.equal(null);
    // Instrumentals have no lines to judge
    expect(latinLyrics({ synced: false, instrumental: true, lines: [] })).to.deep.equal({ synced: false, instrumental: true, lines: [] });
  });

  it('fixes words and drops translations in another alphabet', () => {
    const line = { time: 0, text: 'hеllo', words: [{ time: 0, text: 'hеllo' }], translation: '你好' };
    expect(latinLyrics({ synced: true, instrumental: false, lines: [line] })!.lines).to.deep.equal([{ time: 0, text: 'hello', words: [{ time: 0, text: 'hello' }] }]);
  });

  it('leaves out a track named in another alphabet, and only drops such an album', () => {
    const words = lyrics('Did I drive you away');
    expect(latinCandidate(candidate(words, { artist: '酷玩乐队' }))).to.equal(null);
    expect(latinCandidate(candidate(words, { title: 'Ｓｐａｒｋｓ' }))!.track.title).to.equal('Ｓｐａｒｋｓ');
    expect(latinCandidate(candidate(words, { title: '火花' }))).to.equal(null);
    expect(latinCandidate(candidate(words, { album: '降落伞' }))!.track).to.deep.equal({ artist: 'Coldplay', title: 'Sparks' });
    expect(latinCandidate(candidate(lyrics('三', '四')))).to.equal(null);
  });
});
