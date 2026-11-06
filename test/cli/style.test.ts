import { expect } from 'chai';
import { stripVTControlCharacters } from 'node:util';
import { fileLine, progressLine, summaryLines } from '../../src/cli/tag.ts';
import { TAG_STATUSES, type TagStatus } from '../../src/core/tagger.ts';
import { main } from '../../src/cli/index.ts';
import { elapsed, gradientBar, LiveLine, paint, percent, PLAIN, shortenPath, streamStyle, table, truncate, visibleWidth, type StreamStyle } from '../../src/cli/style.ts';

const plain = stripVTControlCharacters;
const color: StreamStyle = { rich: true, tty: true, depth: 24, columns: 100 };
const counts = (given: Partial<Record<TagStatus, number>>) => ({ ...Object.fromEntries(TAG_STATUSES.map(status => [status, 0])), ...given }) as Record<TagStatus, number>;

describe('how the commands look', () => {
  describe('what a stream can show', () => {
    const terminal = { isTTY: true, columns: 120, getColorDepth: () => 24 };

    it('is plain down a pipe', () => {
      expect(streamStyle({}, {})).to.deep.equal(PLAIN);
      expect(streamStyle({ isTTY: false, columns: 80 }, {})).to.deep.equal(PLAIN);
    });

    it('follows the terminal', () => {
      expect(streamStyle(terminal, {})).to.deep.equal({ rich: true, tty: true, columns: 120, depth: 24 });
      expect(streamStyle({ ...terminal, getColorDepth: () => 8 }, {}).depth).to.equal(8);
      expect(streamStyle({ ...terminal, getColorDepth: () => 4 }, {}).depth).to.equal(4);
      expect(streamStyle({ ...terminal, getColorDepth: () => 1 }, {}).depth).to.equal(1);
    });

    it('keeps the layout and drops the color with NO_COLOR', () => {
      expect(streamStyle(terminal, { NO_COLOR: '1' })).to.deep.equal({ rich: true, tty: true, columns: 120, depth: 1 });
      expect(streamStyle(terminal, { FORCE_COLOR: '0' }).depth).to.equal(1);
    });

    it('turns on down a pipe with FORCE_COLOR, which beats NO_COLOR, though nothing can be redrawn there', () => {
      expect(streamStyle({}, { FORCE_COLOR: '1' })).to.deep.equal({ rich: true, tty: false, columns: null, depth: 4 });
      expect(streamStyle({}, { FORCE_COLOR: '3', NO_COLOR: '1' }).depth).to.equal(24);
      expect(streamStyle({}, { FORCE_COLOR: '2' }).depth).to.equal(8);
      expect(streamStyle({}, { FORCE_COLOR: '' })).to.deep.equal(PLAIN);
    });
  });

  it('paints only where there is color', () => {
    expect(paint(PLAIN).red('x')).to.equal('x');
    expect(paint(color).red('x')).to.equal('\u001b[31mx\u001b[39m');
  });

  it('measures text without its color, an accented letter as one column', () => {
    expect(visibleWidth(paint(color).green('abc'))).to.equal(3);
    expect(visibleWidth('Café')).to.equal(4);
    expect(truncate('abcdef', 4)).to.equal('abc…');
    expect(truncate('abc', 4)).to.equal('abc');
  });

  describe('tables', () => {
    it('lines columns up, with none of the last one\'s padding', () => {
      expect(table([['a', '1', 'x'], ['bbb', '22', 'yyy']], { right: [1] })).to.deep.equal(['a     1  x', 'bbb  22  yyy']);
      expect(table([])).to.deep.equal([]);
    });

    it('lines up colored cells by what shows', () => {
      const lines = table([[{ text: 'a', style: paint(color).red }, 'x'], ['bbb', 'y']]);
      expect(lines.map(plain)).to.deep.equal(['a    x', 'bbb  y']);
    });

    it('shortens the flexible column to fit, and no further than it can be read', () => {
      const rows = [['1', 'a long name that goes on', 'end']];
      expect(table(rows, { flex: 1, columns: 24 })).to.deep.equal(['1  a long name tha…  end']);
      expect(table(rows, { flex: 1, columns: 1 })[0]).to.include('a long name…');
      expect(table(rows, { flex: 1, columns: 200 })).to.deep.equal(['1  a long name that goes on  end']);
    });
  });

  describe('paths', () => {
    const file = 'Rated/Electronica/Indietronica/Singles/Name of the song.mp3';

    it('leave out the middle, never the name', () => {
      expect(shortenPath(file, 100)).to.equal(file);
      expect(shortenPath(file, 40)).to.equal('Rated/…/Singles/Name of the song.mp3');
      expect(shortenPath(file, 30)).to.equal('…/Singles/Name of the song.mp3');
      expect(shortenPath(file, 20)).to.equal('…/Name of the song.mp3');
      expect(shortenPath('Only a name that is long.mp3', 5)).to.equal('Only a name that is long.mp3');
    });
  });

  describe('gradient bars', () => {
    it('are exactly as wide as asked, whatever they hold', () => {
      for (const fraction of [0, 0.01, 0.5, 0.99, 1, 2, -1, NaN]) {
        for (const depth of [1, 4, 8, 24] as const) expect(visibleWidth(gradientBar(fraction, 20, depth)), `${fraction} at ${depth}`).to.equal(20);
      }
      expect(visibleWidth(gradientBar(1, 1, 24))).to.equal(1);
    });

    it('fill in eighths', () => {
      expect(plain(gradientBar(0.5, 4, 24))).to.equal('██░░');
      expect(plain(gradientBar(0.0625, 2, 24))).to.equal('▏░');
      expect(plain(gradientBar(0, 2, 24))).to.equal('░░');
      expect(plain(gradientBar(1, 2, 24))).to.equal('██');
    });

    it('run blue to green in true color, and step down with the terminal', () => {
      const bar = gradientBar(1, 3, 24);
      expect(bar).to.include('\u001b[38;2;66;112;232m');
      expect(bar).to.include('\u001b[38;2;62;214;155m');
      expect(gradientBar(1, 3, 8)).to.match(/\u001b\[38;5;\d+m/);
      expect(gradientBar(1, 3, 4)).to.include('\u001b[36m').and.not.include('38;');
      expect(gradientBar(0.5, 4, 1)).to.equal('██░░');
    });
  });

  it('gives percents and times in few characters', () => {
    expect([percent(0), percent(0.009), percent(0.5), percent(1), percent(NaN)]).to.deep.equal(['0%', '0.9%', '50%', '100%', '0%']);
    expect([elapsed(45_000), elapsed(192_000), elapsed(3_720_000)]).to.deep.equal(['45s', '3m 12s', '1h 02m']);
  });

  describe('a line redrawn in place', () => {
    it('skips updates close together, and comes back at once after being cleared', () => {
      const written: string[] = [];
      let clock = 0;
      const line = new LiveLine(text => written.push(text), { now: () => clock, gapMs: 100 });
      line.update(() => 'one');
      clock = 50;
      line.update(() => 'skipped');
      clock = 150;
      line.update(() => 'two');
      clock = 160;
      line.clear();
      line.clear();
      line.update(() => 'three');
      expect(written.map(plain).map(text => text.replace('\r', ''))).to.deep.equal(['one', 'two', '', 'three']);
    });
  });

  describe('sleeve tag in a terminal', () => {
    it('shows a file\'s status in color, its path shortened to a column, its details dim', () => {
      const report = { file: '/x', status: 'deferred' as const, detail: 'lrclib failed; again later' };
      const line = fileLine(report, 'Rated/Electronica/Indietronica/Singles/Very long album name/Name.mp3', color);
      expect(line).to.include('\u001b[33mdeferred    \u001b[39m');
      expect(plain(line)).to.match(/^deferred {4} Rated\/…\/Very long album name\/Name\.mp3 +lrclib failed · again later$/);
      expect(plain(line).indexOf('lrclib')).to.equal(13 + Math.floor(87 * 0.55) + 2);
      expect(plain(fileLine({ file: '/x', status: 'not found' }, 'a.mp3', color))).to.equal('not found    a.mp3');
    });

    it('keeps the progress line within the terminal', () => {
      const seen = counts({ written: 36, deferred: 2, 'has lyrics': 3000 });
      const line = progressLine(3751, 7348, seen, 192_000, color);
      expect(plain(line)).to.match(/^[█▏▎▍▌▋▊▉░]+ {1,}51% · 3751\/7348 · 36 written · 2 deferred · 3m 12s$/);
      expect(visibleWidth(line)).to.be.at.most(100);
      for (const columns of [20, 40, 60, 80]) expect(visibleWidth(progressLine(3751, 7348, seen, 192_000, { ...color, columns })), String(columns)).to.be.below(columns);
      expect(plain(progressLine(0, 0, counts({}), 0, color))).to.include('0/0');
    });

    it('sums up a run with each count\'s share, or in one line for a few files', () => {
      const lines = summaryLines(counts({ written: 69, 'has lyrics': 5694, 'not found': 859 }), 725_000, color).map(plain);
      expect(lines).to.have.length(4);
      expect(lines[0]).to.match(/^written +69 +[█▏▎▍▌▋▊▉░]{24} +1\.0%$/);
      expect(lines[1]).to.match(/^has lyrics +5694 +[█▏▎▍▌▋▊▉░]{24} +86%$/);
      expect(lines[3]).to.equal('6622 files in 12m 05s');
      expect(summaryLines(counts({ written: 2, deferred: 1 }), 0, color).map(plain)).to.deep.equal(['2 written · 1 deferred']);
    });
  });

  describe('help and errors', () => {
    const run = async (args: string[], styles?: { out: StreamStyle; err: StreamStyle }) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(args, { out: text => out.push(text), err: text => err.push(text), ...(styles ? { styles } : {}) });
      return { code, out: out.join('\n'), err: err.join('\n') };
    };
    const styles = { out: color, err: color };

    it('color help only where the stream can show it', async () => {
      expect((await run(['--help'])).out).to.not.include('\u001b[');
      const colored = (await run(['--help'], styles)).out;
      expect(colored).to.include('\u001b[1mUsage:');
      expect(colored).to.include('\u001b[36mlyrics');
      expect((await run(['tag', '--help'], styles)).out).to.include('\u001b[32m');
    });

    it('put a red prefix on errors in a terminal, and leave them as they were elsewhere', async () => {
      const args = ['lyrics', '--format', 'nope'];
      expect((await run(args)).err).to.equal('Error: Invalid format: nope (use lrc or plain)');
      expect((await run(args, styles)).err).to.equal('\u001b[31merror:\u001b[39m Invalid format: nope (use lrc or plain)');
      expect((await run(['no-such-command'], styles)).err).to.match(/^\u001b\[31merror:\u001b\[39m unknown command/);
      expect((await run(['no-such-command'])).err).to.match(/^error: unknown command/);
    });
  });
});
