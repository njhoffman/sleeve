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
import { candidateEntries, coverColors, displaySettings, flowSettings, flowStep, follow, formatOffset, formatTime, lineStart, lyricsInsets, nowText, resolveArea, NO_SCROLL_BACK, progress, reconnectDelay, SCROLL_BACK_MS, scrollBackOffset, status, wheel } from '../../src/renderer/view.ts';
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
      expect(displaySettings(css, params(), true, { nowArea: '100x100+0+0' }).nowArea).to.equal('100x100+0+0');
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
    });
  });

  describe('the flow background', () => {
    const settings = (values: Record<string, string> = {}) => flowSettings(name => values[name] ?? '');

    it('takes its settings from CSS variables, its defaults for what is missing or unreadable, within range', () => {
      expect(settings()).to.deep.equal({ speed: 1, amount: 1, detail: 1, zoom: 1.4, saturation: 1.3, resolution: 0.25, fps: 30 });
      expect(settings({ '--flow-speed': ' 2.5 ', '--flow-fps': '20', '--art-saturation': '0.5' })).to.deep.include({ speed: 2.5, fps: 20, saturation: 0.5 });
      expect(settings({ '--flow-speed': 'fast' }).speed).to.equal(1);
      expect(settings({ '--flow-resolution': '9', '--flow-fps': '0', '--flow-zoom': '0' })).to.deep.include({ resolution: 1, fps: 1, zoom: 1 });
    });

    it('moves at the speed shown, so a new speed carries on from where the picture is', () => {
      const start = { ...settings(), phase: 10 };
      expect(flowStep(start, settings(), 500).phase).to.be.closeTo(10.5, 1e-9);
      const faster = flowStep(start, settings({ '--flow-speed': '20' }), 16);
      expect(faster.phase).to.be.closeTo(10.016, 1e-9);
      expect(faster.speed).to.be.greaterThan(1).and.lessThan(2);
    });

    it('glides to a changed setting and settles on it, the same at any frame rate; resolution and fps apply at once', () => {
      const target = settings({ '--flow-amount': '3', '--flow-resolution': '0.5', '--flow-fps': '60' });
      const steps = (count: number, dtMs: number) => {
        let view = { ...settings(), phase: 0 };
        for (let at = 0; at < count; at++) view = flowStep(view, target, dtMs);
        return view;
      };
      expect(steps(1, 16)).to.deep.include({ resolution: 0.5, fps: 60 });
      expect(steps(1, 16).amount).to.be.lessThan(1.1);
      expect(steps(30, 16).amount).to.be.closeTo(steps(15, 32).amount, 1e-6);
      expect(steps(500, 16).amount).to.equal(3);
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
