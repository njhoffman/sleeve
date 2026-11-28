import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { expect } from 'chai';
import { mkdtemp, rm, utimes, writeFile, mkdir } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { LyricsResult, ScoredCandidate } from '../../src/core/types.ts';
import { SleeveDaemon } from '../../src/daemon/server.ts';
import { sourceFor, SOURCE_ROOT, StaticFiles } from '../../src/daemon/static.ts';
import { NowPlaying } from '../../src/now/session.ts';
import type { NowState } from '../../src/now/state.ts';
import { PlayerHub } from '../../src/players/hub.ts';
import { Connection } from '../../src/renderer/connection.ts';
import { candidateEntries, coverColors, darkVibrant, displaySettings, fullTint, tintPixels, flowSettings, flowStep, follow, formatOffset, formatTime, lineStart, lyricsInsets, lyricsShown, nowShowsCover, nowShowsProgress, nowText, panelPosition, resolveArea, NO_SCROLL_BACK, progress, reconnectDelay, SCROLL_BACK_MS, scrollBackOffset, styleRule, scrimAlpha, wholeCoverPosition, wholeCoverRect, coverDetail, SCRIM_MAX, status, swirlLayers, timingFunction, wheel } from '../../src/renderer/view.ts';
import { until } from '../helpers/fakeMpd.ts';
import { fakePlayer } from '../helpers/players.ts';

const candidate = (provider: string, id: string | undefined, extra: Partial<ScoredCandidate> = {}): ScoredCandidate => ({
  provider, ...(id ? { id } : {}), track: { artist: 'A', title: 'T', album: 'Al', durationMs: 185_000 }, score: 0.9,
  detail: { title: 1, artist: 1, album: null, duration: null },
  lyrics: { synced: true, instrumental: false, lines: [{ time: 1000, text: 'one' }] }, ...extra
});
const result = (extra: Partial<LyricsResult> = {}): LyricsResult => ({
  best: candidate('lrclib', '1'), candidates: [candidate('lrclib', '1')], rejected: [], errors: [], pinned: false, offsetMs: 0, ...extra
});
const state = (extra: Partial<NowState> = {}): NowState => ({
  playback: { player: 'mpd', state: 'playing', track: { key: 'k', artist: 'A', title: 'T' }, positionMs: 0, at: 0, rate: 1, changedAt: 0 },
  query: { artist: 'A', title: 'T' }, result: result(), loading: false, error: null, ...extra
});

// A module with a syntax error, a name declared twice included, leaves the page blank; tsc does not always say so
describe('renderer sources', () => {
  for (const name of readdirSync(new URL('../../src/renderer/', import.meta.url)).filter(file => file.endsWith('.ts'))) {
    it(`${name} loads as a module`, async () => {
      const source = stripTypeScriptTypes(readFileSync(new URL(`../../src/renderer/${name}`, import.meta.url), 'utf8'));
      const dir = await mkdtemp(path.join(os.tmpdir(), 'sleeve-renderer-'));
      try {
        const file = path.join(dir, `${name}.mjs`);
        await writeFile(file, source);
        expect(spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }).stderr).to.equal('');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('renderer view', () => {
  describe('the now-playing panel', () => {
    const params = (text = '') => new URLSearchParams(text);
    const reading = (values: Record<string, string> = {}) => (name: string) => values[name] ?? '';

    it('shows only lyrics on the overlay and a line in a window unless told otherwise', () => {
      expect(displaySettings(reading(), params(), true)).to.deep.include({ preset: 'lyrics', position: 'top-left', align: 'left', visible: true });
      expect(displaySettings(reading(), params(), false)).to.deep.include({ preset: 'minimal', position: 'top-left', align: 'left', visible: true });
    });

    it('takes a live change over the URL over the stylesheet, passing over what it does not know', () => {
      const css = reading({ '--now-preset': ' full ', '--now-position': 'bottom-right', '--lyrics-align': 'center' });
      expect(displaySettings(css, params(), true)).to.deep.include({ preset: 'full', position: 'bottom-right', align: 'center', visible: true });
      expect(displaySettings(css, params('now=minimal&now-position=center-left&lyrics-align=right'), true)).to.deep.include({ preset: 'minimal', position: 'center-left', align: 'right', visible: true });
      expect(displaySettings(css, params('now=huge&now-position=middle'), true)).to.deep.include({ preset: 'full', position: 'bottom-right' });
      expect(displaySettings(css, params('now=minimal'), true, { preset: 'lyrics', visible: false })).to.deep.include({ preset: 'lyrics', visible: false });
    });

    it('gives the full panel lines of its own, and the others one line', () => {
      const playing = state();
      expect(nowText(playing, 'minimal', 'A - T')).to.deep.equal({ title: 'A - T', artist: '', album: '' });
      expect(nowText(playing, 'full', 'A - T')).to.deep.include({ title: 'T', artist: 'A' });
      expect(nowText(state({ playback: null }), 'full', '')).to.deep.equal({ title: '', artist: '', album: '' });
    });

    it('gives the card title, artist and album lines, and the strip title and artist only', () => {
      const playing = state({ playback: { ...state().playback!, track: { ...state().playback!.track!, album: 'Al' } } });
      expect(nowText(playing, 'card', 'A - T')).to.deep.equal({ title: 'T', artist: 'A', album: 'Al' });
      expect(nowText(playing, 'strip', 'A - T')).to.deep.equal({ title: 'T', artist: 'A', album: '' });
      expect(nowText(state({ playback: null }), 'strip', '')).to.deep.equal({ title: '', artist: '', album: '' });
    });

    it('shows the seek bar with full, card and strip, and the cover with full and card', () => {
      expect(['lyrics', 'minimal', 'full', 'card', 'strip'].filter(preset => nowShowsProgress(preset as 'full'))).to.deep.equal(['full', 'card', 'strip']);
      expect(['lyrics', 'minimal', 'full', 'card', 'strip'].filter(preset => nowShowsCover(preset as 'full'))).to.deep.equal(['full', 'card']);
    });

    it('lays a strip along the top edge for a top position and the bottom one otherwise', () => {
      expect(panelPosition('strip', 'top-right')).to.equal('top-center');
      expect(panelPosition('strip', 'center-left')).to.equal('bottom-center');
      expect(panelPosition('strip', 'center')).to.equal('bottom-center');
      expect(panelPosition('strip', 'bottom-left')).to.equal('bottom-center');
      expect(panelPosition('card', 'center-left')).to.equal('center-left');
    });

    it('takes card, strip and the center position from the URL', () => {
      expect(displaySettings(reading(), params('now=card&now-position=center'), true)).to.deep.include({ preset: 'card', position: 'center' });
      expect(displaySettings(reading({ '--now-preset': 'strip' }), params(), false)).to.deep.include({ preset: 'strip' });
    });

    it('writes times as m:ss, and h:mm:ss from an hour', () => {
      expect(formatTime(0)).to.equal('0:00');
      expect(formatTime(61_999)).to.equal('1:01');
      expect(formatTime(3_725_000)).to.equal('1:02:05');
      expect(formatTime(undefined)).to.equal('');
    });

    it('takes areas like the rest, passing over a form it cannot read', () => {
      const css = reading({ '--lyrics-area': '50%x100%+0+0' });
      expect(displaySettings(css, params(), true)).to.deep.include({ lyricsArea: '50%x100%+0+0', nowArea: null });
      expect(displaySettings(css, params('lyrics-area=33%25x100%25%2B0%2B0'), true).lyricsArea).to.equal('33%x100%+0+0');
      expect(displaySettings(css, params('lyrics-area=rubbish'), true).lyricsArea).to.equal('50%x100%+0+0');
      // none leaves the lyrics out; a panel's area never is none
      const none = displaySettings(css, params('lyrics-area=none&now-area=none'), true);
      expect(none).to.deep.include({ lyricsArea: 'none', nowArea: null });
      expect(lyricsShown(none)).to.equal(false);
      expect(lyricsShown(displaySettings(css, params(), true))).to.equal(true);
      expect(displaySettings(reading(), params(), true, { lyricsArea: 'none' }).lyricsArea).to.equal('none');
      expect(displaySettings(css, params(), true, { nowArea: '100x100+0+0' }).nowArea).to.equal('100x100+0+0');
    });

    it('takes stylesheet variables from ?style= under a live change\'s, name by name, leaving out a URL style with anything wrong', () => {
      expect(displaySettings(reading(), params(), false).style).to.deep.equal({});
      const url = params(`style=${encodeURIComponent('--art-size:512;--art-blur:0')}`);
      expect(displaySettings(reading(), url, false).style).to.deep.equal({ '--art-size': '512', '--art-blur': '0' });
      expect(displaySettings(reading(), url, false, { style: { '--art-blur': '2', '--art-size': '' } }).style).to.deep.equal({ '--art-blur': '2' });
      expect(displaySettings(reading(), params(`style=${encodeURIComponent('--art-size:512;--now-preset:full')}`), false).style).to.deep.equal({});
    });

    it('writes the style as one rule that wins over /user.css, in a steady order', () => {
      expect(styleRule({})).to.equal('');
      expect(styleRule({ '--art-size': '512', '--art-animation': 'sleeve-art-swirl', '--art-blur': '' })).to.equal(':root:root { --art-animation: sleeve-art-swirl; --art-size: 512; }');
    });

    it('takes a background like the rest, with the old ?background=none meaning none', () => {
      const css = reading({ '--background': 'cover' });
      expect(displaySettings(reading(), params(), true).background).to.equal(null);
      expect(displaySettings(css, params(), true).background).to.equal('cover');
      expect(displaySettings(css, params('background=none'), false).background).to.equal('transparent');
      expect(displaySettings(css, params('background=%2310203099'), false).background).to.equal('#10203099');
      expect(displaySettings(css, params('background=clear'), false).background).to.equal('cover');
      expect(displaySettings(css, params('background=none'), false, { background: 'cover@0.5' }).background).to.equal('cover@0.5');
    });

    it('resolves an area in pixels or percent, clipped to the window', () => {
      const window = { width: 2000, height: 1000 };
      expect(resolveArea(null, window)).to.deep.equal({ left: 0, top: 0, width: 2000, height: 1000 });
      expect(resolveArea('25%x100%+0+0', window)).to.deep.equal({ left: 0, top: 0, width: 500, height: 1000 });
      expect(resolveArea('75%x50%+25%+50%', window)).to.deep.equal({ left: 500, top: 500, width: 1500, height: 500 });
      expect(resolveArea('300x200+10+20', window)).to.deep.equal({ left: 10, top: 20, width: 300, height: 200 });
      expect(resolveArea('300x200-100-50', window)).to.deep.equal({ left: 0, top: 0, width: 200, height: 150 });
      expect(resolveArea('300x200+1900+900', window)).to.deep.equal({ left: 1900, top: 900, width: 100, height: 100 });
      expect(resolveArea('300x200+3000+0', window).width).to.equal(0);
    });

    it('measures the lyrics\' clearance within their area, and leaves them alone for a panel elsewhere', () => {
      const area = { left: 0, top: 0, width: 500, height: 1000 };
      expect(lyricsInsets('bottom-left', { top: 850, right: 340, bottom: 980, left: 24 }, area)).to.deep.include({ bottom: 166 });
      expect(lyricsInsets('bottom-left', { top: 850, right: 1000, bottom: 980, left: 600 }, area)).to.deep.equal({ top: 0, right: 0, bottom: 0, left: 0 });
      expect(lyricsInsets('center-right', { top: 400, right: 480, bottom: 600, left: 300 }, { left: 100, top: 0, width: 400, height: 1000 }).right).to.equal(216);
    });

    it('counts the empty strip above the lyrics, however wide it is set', () => {
      const area = { width: 1000, height: 1000 };
      const panel = { top: 18, right: 200, bottom: 60, left: 24 };
      expect(lyricsInsets('top-left', panel, area, 0.08).top).to.equal(0);
      expect(lyricsInsets('top-left', panel, area, 0).top).to.equal(76);
      expect(lyricsInsets('top-left', panel, area, 0.02).top).to.equal(56);
    });

    it('keeps the lyrics clear of it: a strip at the top or bottom, a column at a side, nothing without one', () => {
      const view = { width: 1000, height: 1000 };
      const none = { top: 0, right: 0, bottom: 0, left: 0 };
      expect(lyricsInsets('top-left', null, view)).to.deep.equal(none);
      // Inside the faded top of the lyrics, as the one-line panel always was
      expect(lyricsInsets('top-left', { top: 18, right: 200, bottom: 60, left: 24 }, view)).to.deep.equal(none);
      expect(lyricsInsets('top-center', { top: 18, right: 600, bottom: 150, left: 300 }, view).top).to.equal(86);
      expect(lyricsInsets('bottom-right', { top: 850, right: 980, bottom: 980, left: 600 }, view)).to.deep.equal({ ...none, bottom: 166 });
      expect(lyricsInsets('center-left', { top: 400, right: 364, bottom: 600, left: 24 }, view)).to.deep.equal({ ...none, left: 380 });
      expect(lyricsInsets('center-right', { top: 400, right: 976, bottom: 600, left: 636 }, view)).to.deep.equal({ ...none, right: 380 });
      // In the middle there is no side to clear; the areas keep the two apart
      expect(lyricsInsets('center', { top: 300, right: 650, bottom: 700, left: 350 }, view)).to.deep.equal(none);
    });
  });

  describe('the whole cover', () => {
    const window = { width: 1920, height: 1080 };
    const third = { left: 0, top: 0, width: 640, height: 1080 };

    it('stands in the larger free side beside the lyrics, the largest square there less the margin', () => {
      // Lyrics in the left third: the right two thirds, 1280 x 1080, a 1080 square less 10% all round
      expect(wholeCoverRect(window, third, 'auto', 0.1)).to.deep.equal({ left: 640 + (1280 - 864) / 2, top: 108, width: 864, height: 864 });
      // Lyrics on the right: the left side
      const rightSide = { left: 1280, top: 0, width: 640, height: 1080 };
      expect(wholeCoverRect(window, rightSide, 'auto', 0).left).to.equal((1280 - 1080) / 2);
      // A narrow side: the square fits its width
      expect(wholeCoverRect(window, { left: 0, top: 0, width: 1400, height: 1080 }, 'auto', 0)).to.deep.include({ left: 1400, width: 520 });
    });

    it('takes the middle of the window when neither side is a fifth of it, or when asked', () => {
      const wide = { left: 100, top: 0, width: 1720, height: 1080 };
      const middle = { left: (1920 - 1080) / 2, top: 0, width: 1080, height: 1080 };
      expect(wholeCoverRect(window, wide, 'auto', 0)).to.deep.equal(middle);
      expect(wholeCoverRect(window, third, 'center', 0)).to.deep.equal(middle);
    });

    it('takes a side when asked, the middle when that side has no room', () => {
      expect(wholeCoverRect(window, { left: 960, top: 0, width: 960, height: 1080 }, 'left', 0).left).to.equal(0);
      expect(wholeCoverRect(window, third, 'left', 0).left).to.equal((1920 - 1080) / 2);
      expect(wholeCoverRect(window, third, 'right', 0).left).to.equal(640 + (1280 - 1080) / 2);
    });

    it('keeps the margin within 0 to 40%, and reads the position, auto for anything else', () => {
      expect(wholeCoverRect(window, third, 'auto', 3).width).to.be.closeTo(1080 * 0.2, 1e-9);
      expect(wholeCoverRect(window, third, 'auto', -1).width).to.equal(1080);
      expect(wholeCoverPosition(' right ')).to.equal('right');
      expect(wholeCoverPosition('top')).to.equal('auto');
      expect(wholeCoverPosition('')).to.equal('auto');
    });
  });

  describe('the scrim behind the lyrics', () => {
    // A side x side RGBA image, each pixel's gray from at(x, y)
    const image = (side: number, at: (x: number, y: number) => number) => {
      const pixels = new Uint8ClampedArray(side * side * 4);
      for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) pixels.set([at(x, y), at(x, y), at(x, y), 255], (y * side + x) * 4);
      return pixels;
    };

    it('reads a flat or smooth cover as no detail, a busy one as full, and in between in order', () => {
      expect(coverDetail(image(16, () => 128), 16)).to.equal(0);
      expect(coverDetail(image(16, x => x * 2), 16)).to.equal(0);
      expect(coverDetail(image(16, (x, y) => ((x + y) % 2) * 255), 16)).to.equal(1);
      const some = coverDetail(image(16, (x, y) => ((x + y) % 2) * 6), 16);
      expect(some).to.be.greaterThan(0).and.lessThan(1);
      expect(coverDetail(image(16, (x, y) => ((x + y) % 2) * 3), 16)).to.be.lessThan(some);
    });

    it('reads nothing from too few pixels', () => {
      expect(coverDetail([], 128)).to.equal(0);
      expect(coverDetail(image(1, () => 255), 1)).to.equal(0);
    });

    it('follows the detail when auto or unset, takes a number from 0 to 1 as it is, and treats anything else as auto', () => {
      expect(scrimAlpha('auto', 0)).to.equal(0);
      expect(scrimAlpha('auto', 1)).to.equal(SCRIM_MAX);
      expect(scrimAlpha('', 0.5)).to.equal(0.3);
      expect(scrimAlpha(' 0.25 ', 1)).to.equal(0.25);
      expect(scrimAlpha('0', 1)).to.equal(0);
      expect(scrimAlpha('3', 0)).to.equal(1);
      expect(scrimAlpha('-1', 1)).to.equal(0);
      expect(scrimAlpha('strong', 1)).to.equal(SCRIM_MAX);
    });
  });

  describe('the flow background', () => {
    const settings = (values: Record<string, string> = {}) => flowSettings(name => values[name] ?? '');

    it('takes its settings from CSS variables, its defaults for what is missing or unreadable, within range', () => {
      expect(settings()).to.deep.equal({ speed: 1, amount: 1, detail: 1, zoom: 1.4, saturation: 1.3, resolution: 0.25, fps: 30, period: 60, delay: 10, size: 2, brightness: 0.5 });
      expect(settings({ '--swirl-period': '0', '--swirl-size': '20', '--swirl-delay': '-4' })).to.deep.include({ period: 1, size: 6, delay: -4 });
      expect(settings({ '--flow-speed': ' 2.5 ', '--flow-fps': '20', '--art-saturation': '0.5' })).to.deep.include({ speed: 2.5, fps: 20, saturation: 0.5 });
      expect(settings({ '--flow-speed': 'fast' }).speed).to.equal(1);
      expect(settings({ '--flow-resolution': '9', '--flow-fps': '0', '--flow-zoom': '0' })).to.deep.include({ resolution: 1, fps: 1, zoom: 1 });
    });

    it('moves at the speed shown, so a new speed carries on from where the picture is', () => {
      const start = { ...settings(), phase: 10, turn: 0 };
      expect(flowStep(start, settings(), 500).phase).to.be.closeTo(10.5, 1e-9);
      const faster = flowStep(start, settings({ '--flow-speed': '20' }), 16);
      expect(faster.phase).to.be.closeTo(10.016, 1e-9);
      expect(faster.speed).to.be.greaterThan(1).and.lessThan(2);
    });

    it('glides to a changed setting and settles on it, the same at any frame rate; resolution and fps apply at once', () => {
      const target = settings({ '--flow-amount': '3', '--flow-resolution': '0.5', '--flow-fps': '60' });
      const steps = (count: number, dtMs: number) => {
        let view = { ...settings(), phase: 0, turn: 0 };
        for (let at = 0; at < count; at++) view = flowStep(view, target, dtMs);
        return view;
      };
      expect(steps(1, 16)).to.deep.include({ resolution: 0.5, fps: 60 });
      expect(steps(1, 16).amount).to.be.lessThan(1.1);
      expect(steps(30, 16).amount).to.be.closeTo(steps(15, 32).amount, 1e-6);
      expect(steps(500, 16).amount).to.equal(3);
    });

    it('turns the swirl once a period at the speed shown, and a new period carries on from where it is', () => {
      const start = { ...settings(), phase: 0, turn: 0.25 };
      expect(flowStep(start, settings(), 6000).turn).to.be.closeTo(0.35, 1e-9);
      expect(flowStep({ ...start, speed: -1 }, settings({ '--flow-speed': '-1' }), 6000).turn).to.be.closeTo(0.15, 1e-9);
      const slower = flowStep(start, settings({ '--swirl-period': '600' }), 16);
      expect(slower.turn).to.be.greaterThan(0.25).and.lessThan(0.25 + 0.016 / 60 + 1e-9);
      expect(slower.period).to.be.greaterThan(60).and.lessThan(600);
    });

    it('eases a turn as CSS does: the keywords, cubic-bezier(), linear for anything else', () => {
      const easeInOut = timingFunction('ease-in-out');
      expect(easeInOut(0)).to.equal(0);
      expect(easeInOut(1)).to.be.closeTo(1, 1e-6);
      expect(easeInOut(0.5)).to.be.closeTo(0.5, 1e-6);
      expect(easeInOut(0.1)).to.be.lessThan(0.05);
      expect(easeInOut(0.9)).to.be.greaterThan(0.95);
      expect(timingFunction(' Cubic-Bezier(0.42, 0, 0.58, 1) ')(0.2)).to.be.closeTo(easeInOut(0.2), 1e-6);
      expect(timingFunction('ease-in')(0.5)).to.be.lessThan(0.5);
      expect(timingFunction('ease-out')(0.5)).to.be.greaterThan(0.5);
      for (const text of ['linear', 'steps(4)', 'cubic-bezier(2, 0, 0.5, 1)', 'bounce', '']) expect(timingFunction(text)(0.3)).to.be.closeTo(0.3, 1e-9);
    });

    it('places the swirl layers at the corners of a box 125% of the window, turning opposite ways, the second trailing', () => {
      const linear = (progress: number) => progress;
      const view = { turn: 0.25, period: 60, delay: 15, size: 2 };
      const [first, second] = swirlLayers(view, linear, 1600, 900);
      // In viewport lengths: the box runs from (-0.125, -0.0703) to (1.125, 0.6328)
      expect(first.x).to.be.closeTo(-0.125 + 1, 1e-9);
      expect(first.y).to.be.closeTo(-0.125 * 900 / 1600 + 1, 1e-9);
      expect(second.x).to.be.closeTo(1.125 - 1, 1e-9);
      expect(second.y).to.be.closeTo(1.125 * 900 / 1600 - 1, 1e-9);
      expect(first.angle).to.be.closeTo(Math.PI / 2, 1e-9);
      // 15 s behind on a 60 s turn is a quarter turn behind, played backward: at turn 0.25 it is at 360 degrees
      expect(second.angle).to.be.closeTo(2 * Math.PI, 1e-9);
      expect(swirlLayers({ ...view, turn: 1.25 }, linear, 1600, 900)[0].angle).to.be.closeTo(Math.PI / 2, 1e-9);
      expect(swirlLayers({ ...view, turn: 0.5 }, timingFunction('ease-in-out'), 900, 1600)[0].angle).to.be.closeTo(Math.PI, 1e-6);
    });
  });

  it('plays from a line at its time with the offset applied, and only lines with a time', () => {
    expect(lineStart({ time: 5000 }, 0)).to.equal(5000);
    expect(lineStart({ time: 5000 }, 250)).to.equal(5250);
    expect(lineStart({ time: 100 }, -250)).to.equal(0);
    expect(lineStart({ time: null }, 0)).to.equal(null);
    expect(lineStart(undefined, 0)).to.equal(null);
  });

  it('follows a target the same at any frame rate, and settles on it', () => {
    let fast = 0;
    for (let frame = 0; frame < 6; frame++) fast = follow(fast, 100, 16, 110);
    const slow = follow(0, 100, 96, 110);
    expect(fast).to.be.closeTo(slow, 1e-9);
    expect(follow(99.99, 100, 16, 110)).to.equal(100);
    expect(follow(5, 100, 0, 110)).to.equal(5);
    expect(follow(5, 100, 16, 0)).to.equal(100);
  });

  it('formats offsets and progress', () => {
    expect([formatOffset(100), formatOffset(-250), formatOffset(1500), formatOffset(-2000), formatOffset(0)]).to.deep.equal(['+100 ms', '-250 ms', '+1.5 s', '-2 s', '0 ms']);
    expect([progress(50, 100), progress(-5, 100), progress(500, 100), progress(50, undefined)]).to.deep.equal([0.5, 0, 1, 0]);
  });

  it('says what is shown, and what stands in for lyrics', () => {
    expect(status(state(), false)).to.deep.equal({ title: '', source: '', message: 'Waiting for sleeved' });
    expect(status(state({ playback: null }), true).message).to.equal('Nothing playing');
    expect(status(state(), true)).to.deep.equal({ title: 'A - T', source: 'lrclib', message: null });
    expect(status(state({ result: result({ pinned: true, offsetMs: -300 }) }), true).source).to.equal('lrclib · pinned · -300 ms');
    expect(status(state({ result: null, loading: true }), true).message).to.equal('Looking up lyrics');
    expect(status(state({ result: result({ best: null, marked: 'none' }) }), true)).to.deep.equal({ title: 'A - T', source: 'marked', message: 'No correct lyrics' });
    expect(status(state({ result: result({ best: null, marked: 'instrumental' }) }), true).message).to.equal('Instrumental');
    expect(status(state({ result: null, error: 'disk full' }), true).message).to.equal('Lookup failed: disk full');
    expect(status(state({ result: null, query: null }), true).message).to.equal('No artist or title to look up');
    expect(status(state({ result: result({ best: null }) }), true).message).to.equal('No lyrics found');
    const instrumental = candidate('lrclib', '1', { lyrics: { synced: false, instrumental: true, lines: [] } });
    expect(status(state({ result: result({ best: instrumental }) }), true)).to.deep.include({ source: 'lrclib · unsynced', message: 'Instrumental' });
    // A reload keeps the lyrics shown
    expect(status(state({ loading: true }), true).message).to.equal(null);
  });

  it('scrolls back by wheel within the lyrics, and returns to the current line a while after the last turn', () => {
    // Down a step of 100 px from where playback puts the lines: they move up
    let back = wheel(NO_SCROLL_BACK, 100, 0, 1000, -500, 300);
    expect(back).to.deep.equal({ offset: -100, until: 1000 + SCROLL_BACK_MS });
    // Up three lines (deltaMode 1), stopped at the first line
    back = wheel(back, -3, 1, 2000, -500, 300);
    expect(back.offset).to.equal(20);
    back = wheel(back, -1000, 0, 2500, -500, 300);
    expect(back.offset).to.equal(300);
    expect(scrollBackOffset(back, 2500 + SCROLL_BACK_MS - 1)).to.equal(300);
    expect(scrollBackOffset(back, 2500 + SCROLL_BACK_MS)).to.equal(0);
    // A turn after it has gone back starts from the current line again
    expect(wheel(back, 50, 0, 9000, -500, 300).offset).to.equal(-50);
  });

  it('works out the colors behind the lyrics from the cover as it shows: faded over the page and dimmed', () => {
    // Three white pixels and one red, fully opaque
    const pixels = [255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 255];
    const plain = coverColors(pixels, { opacity: 1, dim: 0, base: [0, 0, 0] });
    expect(plain.main).to.deep.equal([{ color: '#ffffff', share: 0.75 }, { color: '#ff0000', share: 0.25 }]);
    expect(plain.background).to.equal('#ffbfbf');
    // Half over black, then half dimmed: white shows as a quarter grey
    const shown = coverColors(pixels, { opacity: 0.5, dim: 0.5, base: [0, 0, 0] });
    expect(shown.main[0].color).to.equal('#404040');
    expect(coverColors([], { opacity: 1, dim: 0.5, base: [16, 18, 24] })).to.deep.equal({ background: '#08090c', main: [] });
  });

  // Sunamu's --color-bg, which its background multiplies each turning copy with
  it('picks the cover\'s dark vibrant color as node-vibrant does, else the commonest color made dark', () => {
    const repeat = (rgb: number[], times: number) => Array.from({ length: times }, () => [...rgb, 255]).flat();
    // Pale cream mostly, some dark saturated red, a little bright blue: the dark red is the dark vibrant
    expect(darkVibrant([...repeat([235, 225, 205], 80), ...repeat([140, 20, 30], 15), ...repeat([60, 140, 255], 5)])).to.equal('#8c141e');
    // Of two dark saturated reds, the one nearer lightness 0.26 wins over a commoner one near black
    expect(darkVibrant([...repeat([25, 2, 8], 50), ...repeat([90, 10, 20], 10)])).to.equal('#5a0a14');
    // None saturated and dark enough: the commonest color at lightness 0.26, here a grey
    expect(darkVibrant(repeat([200, 200, 200], 10))).to.equal('#424242');
    // Transparent pixels count for nothing, and no pixels give nothing
    expect(darkVibrant([...repeat([140, 20, 30], 3), 255, 255, 255, 0])).to.equal('#8c141e');
    expect(darkVibrant([])).to.equal(null);
  });

  // A dark cover's dark vibrant was near black, and the tinted swirl with it
  it('brings the cover\'s tint to full strength, keeping its hue', () => {
    expect(fullTint('#110e07')).to.equal('#ffd269');
    expect(fullTint('#692c1c')).to.equal('#ff6b44');
    expect(fullTint('#ff0000')).to.equal('#ff0000');
    // Colorless: white, which tints nothing; black alike, rather than dividing by nothing
    expect(fullTint('#404040')).to.equal('#ffffff');
    expect(fullTint('#000000')).to.equal('#ffffff');
    expect(fullTint('cover')).to.equal('cover');
  });

  // The colors behind the text follow the tint, so white text is not set on a light cover the tint has made dark blue
  it('tints the cover\'s color sample as the swirl tints its copies', () => {
    expect(tintPixels([255, 255, 255, 255, 200, 100, 50, 128], '#0086ff')).to.deep.equal([0, 134, 255, 255, 0, 53, 50, 128]);
    expect(tintPixels([10, 20, 30, 255], 'none')).to.deep.equal([10, 20, 30, 255]);
    const white = Array.from({ length: 16 }, () => [255, 255, 255, 255]).flat();
    expect(coverColors(tintPixels(white, '#0086ff'), { opacity: 1, dim: 0, base: [0, 0, 0] }).background).to.equal('#0086ff');
  });

  it('lists candidates as sleeve lyrics --all numbers them, leaving out those without an id', () => {
    const shown = candidate('lrclib', '1');
    const entries = candidateEntries(result({ candidates: [shown, candidate('local', undefined)], rejected: [candidate('netease', '9', { score: 0.3 })] }), shown);
    expect(entries).to.deep.equal([
      { ref: 'lrclib:1', label: 'lrclib: A - T (Al) 3:05, synced, 1 lines, score 0.90', shown: true, rejected: false },
      { ref: 'netease:9', label: 'netease: A - T (Al) 3:05, synced, 1 lines, score 0.30', shown: false, rejected: true }
    ]);
  });

  it('backs off reconnecting up to five seconds', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(reconnectDelay)).to.deep.equal([250, 500, 1000, 2000, 4000, 5000, 5000]);
  });
});

describe('renderer files', () => {
  it('serves the page and the browser-safe sources only', () => {
    const root = '/r';
    expect(sourceFor('/', root)).to.equal('/r/renderer/index.html');
    expect(sourceFor('/src/renderer/main.ts', root)).to.equal('/r/renderer/main.ts');
    expect(sourceFor('/src/protocol/mirror.ts', root)).to.equal('/r/protocol/mirror.ts');
    expect(sourceFor('/src/now/lines.ts', root)).to.equal('/r/now/lines.ts');
    for (const refused of ['/src/now/session.ts', '/src/daemon/server.ts', '/src/renderer/../daemon/server.ts', '/src/renderer/%2e%2e/daemon/server.ts',
      '/src/../package.json', '/package.json', '/src/renderer/notes.md', '/src/renderer/%zz', '/src/renderer/a%00.ts']) {
      expect(sourceFor(refused, root), refused).to.equal(null);
    }
  });

  describe('over HTTP', () => {
    let dir: string, daemon: SleeveDaemon, session: NowPlaying;
    const get = (urlPath: string, method = 'GET') => new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: daemon.port!, path: urlPath, method }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });

    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'sleeve-static-'));
      await mkdir(path.join(dir, 'renderer'));
      await writeFile(path.join(dir, 'renderer', 'index.html'), '<!DOCTYPE html><p>hi</p>');
      await writeFile(path.join(dir, 'renderer', 'a.ts'), 'import type { X } from "./x.ts";\nexport const a: number = 1;\n');
      session = new NowPlaying(new PlayerHub([fakePlayer('mpd')]));
      session.start();
      daemon = new SleeveDaemon(session, { port: 0, socketPath: null, renderer: new StaticFiles(dir, path.join(dir, 'user.css')) });
      await daemon.listen();
    });
    afterEach(async () => {
      await daemon.close();
      session.close();
      await rm(dir, { recursive: true, force: true });
    });

    it('serves HTML as it is and TypeScript as JavaScript, again after an edit', async () => {
      const page = await get('/');
      expect(page).to.deep.include({ status: 200, body: '<!DOCTYPE html><p>hi</p>' });
      expect(page.headers).to.deep.include({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
      expect(page.headers['content-security-policy']).to.match(/connect-src 'self'/);
      const script = await get('/src/renderer/a.ts');
      expect(script.headers['content-type']).to.equal('text/javascript; charset=utf-8');
      expect(script.body).to.not.include('import type');
      expect(script.body).to.match(/export const a\s*= 1;/);
      await writeFile(path.join(dir, 'renderer', 'a.ts'), 'export const b: string = "x";\n');
      const later = new Date(Date.now() + 5000);
      await utimes(path.join(dir, 'renderer', 'a.ts'), later, later);
      expect((await get('/src/renderer/a.ts')).body).to.match(/export const b\s*= "x";/);
      expect(await get('/src/renderer/a.ts', 'HEAD')).to.deep.include({ status: 200, body: '' });
    });

    it('serves the user\'s stylesheet, or an empty one', async () => {
      expect(await get('/user.css')).to.deep.include({ status: 200, body: '' });
      await writeFile(path.join(dir, 'user.css'), ':root { --art-animation: sleeve-art-drift; }');
      const css = await get('/user.css');
      expect(css).to.deep.include({ status: 200, body: ':root { --art-animation: sleeve-art-drift; }' });
      expect(css.headers['content-type']).to.equal('text/css; charset=utf-8');
    });

    it('answers 404 for anything else', async () => {
      for (const urlPath of ['/src/renderer/missing.ts', '/src/daemon/server.ts', '/favicon.ico']) {
        expect((await get(urlPath)).status, urlPath).to.equal(404);
      }
      expect((await get('/', 'POST')).status).to.equal(404);
    });

    it('serves the real renderer\'s sources', async () => {
      await daemon.close();
      daemon = new SleeveDaemon(session, { port: 0, socketPath: null });
      await daemon.listen();
      for (const urlPath of ['/', '/src/renderer/main.ts', '/src/renderer/style.css', '/src/protocol/mirror.ts', '/src/players/types.ts']) {
        expect((await get(urlPath)).status, urlPath).to.equal(200);
      }
      expect(SOURCE_ROOT).to.equal(path.resolve(import.meta.dirname, '../../src'));
    });
  });
});

describe('renderer connection', () => {
  it('mirrors the daemon, answers commands, and reconnects when it comes back', async () => {
    const player = fakePlayer('mpd', { playback: { player: 'mpd', state: 'paused', track: { key: 'k', artist: 'A', title: 'T' }, positionMs: 4000, at: 0, rate: 1, changedAt: 0 } });
    const session = new NowPlaying(new PlayerHub([player]), { lookup: async () => result() });
    session.start();
    await session.settled();
    let daemon = new SleeveDaemon(session, { port: 0, socketPath: null });
    await daemon.listen();
    const port = daemon.port!;
    const connection = new Connection(`ws://127.0.0.1:${port}/ws`);
    const changes: boolean[] = [];
    connection.onConnected(connected => changes.push(connected));
    try {
      expect(await connection.send({ type: 'state' })).to.deep.include({ ok: false, error: 'Not connected to sleeved' });
      connection.start();
      await until(() => connection.connected);
      expect(connection.mirror.current().result).to.deep.equal(result());
      expect(connection.mirror.position()).to.equal(4000);
      expect(await connection.send({ type: 'nudge', ms: 200 })).to.deep.include({ ok: true, data: { offsetMs: 200 } });
      await until(() => connection.mirror.current().result?.offsetMs === 200);

      await daemon.close();
      await until(() => !connection.connected);
      daemon = new SleeveDaemon(session, { port, socketPath: null });
      await daemon.listen();
      await until(() => connection.connected, 3000);
      expect(changes).to.deep.equal([true, false, true]);
    } finally {
      connection.close();
      await daemon.close();
      session.close();
    }
  });
});
