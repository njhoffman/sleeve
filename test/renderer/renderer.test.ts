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
import { candidateEntries, coverColors, follow, formatOffset, lineStart, NO_SCROLL_BACK, progress, reconnectDelay, SCROLL_BACK_MS, scrollBackOffset, status, wheel } from '../../src/renderer/view.ts';
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
