import { expect } from 'chai';
import { formatLrc, looksLikeLrc, parseLrc, plainText } from '../../src/core/lrc.ts';

describe('LRC', () => {
  it('parses timed lines, scaling fractions by their length', () => {
    const lyrics = parseLrc('[00:01.5]half\n[00:02.05]hundredths\n[00:03.123]millis\n[01:04]no fraction\n[00:05:20]colon');
    expect(lyrics.synced).to.equal(true);
    expect(lyrics.lines.map(line => [line.time, line.text])).to.deep.equal([
      [1500, 'half'], [2050, 'hundredths'], [3123, 'millis'], [5200, 'colon'], [64000, 'no fraction']
    ]);
  });

  it('repeats a line for each of its timestamps, in time order', () => {
    const lyrics = parseLrc('[00:10.00][00:30.00]Chorus\n[00:20.00]Verse');
    expect(lyrics.lines.map(line => [line.time, line.text])).to.deep.equal([[10000, 'Chorus'], [20000, 'Verse'], [30000, 'Chorus']]);
  });

  it('skips ID tags, applies [offset:] (positive shows lyrics sooner) and keeps blank-free text', () => {
    const lyrics = parseLrc('﻿[ar:Someone]\r\n[ti:Song]\r\n[offset:+500]\r\n\r\n[00:01.00]  One  \r\n[00:00.20]Early');
    expect(lyrics.lines.map(line => [line.time, line.text])).to.deep.equal([[0, 'Early'], [500, 'One']]);
  });

  it('reads enhanced LRC word times', () => {
    const lyrics = parseLrc('[00:10.00]<00:10.00>Hello <00:10.50>big <00:11.25>world');
    expect(lyrics.lines[0]).to.deep.equal({
      time: 10000, text: 'Hello big world',
      words: [{ time: 10000, text: 'Hello' }, { time: 10500, text: 'big' }, { time: 11250, text: 'world' }]
    });
  });

  it('treats text without timestamps as unsynced', () => {
    const lyrics = parseLrc('First line\nSecond line\n');
    expect(lyrics).to.deep.equal({ synced: false, instrumental: false, lines: [{ time: null, text: 'First line' }, { time: null, text: 'Second line' }] });
  });

  it('formats lyrics back to LRC, with word times, and as plain text', () => {
    const source = '[00:01.50]One\n[01:02.03]<01:02.03>Two <01:02.50>words';
    const lyrics = parseLrc(source);
    expect(formatLrc(lyrics)).to.equal(source);
    expect(plainText(lyrics)).to.equal('One\nTwo words');
    expect(formatLrc(parseLrc('plain\ntext'))).to.equal('plain\ntext');
  });

  it('tells LRC text from plain text', () => {
    expect(looksLikeLrc('Intro\n[00:12.34]Line')).to.equal(true);
    expect(looksLikeLrc('Just words [with brackets]')).to.equal(false);
  });
});
