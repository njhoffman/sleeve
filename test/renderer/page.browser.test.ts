import { expect } from 'chai';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import type { Browser, Page } from 'playwright-core';
import type { LyricsResult, ScoredCandidate } from '../../src/core/types.ts';
import { CoverArt } from '../../src/daemon/art.ts';
import { SleeveDaemon } from '../../src/daemon/server.ts';
import { SOURCE_ROOT, StaticFiles } from '../../src/daemon/static.ts';
import { NowPlaying } from '../../src/now/session.ts';
import { PlayerHub } from '../../src/players/hub.ts';
import type { Playback } from '../../src/players/types.ts';
import { fakePlayer } from '../helpers/players.ts';

// The real page and its scripts in headless Chrome, served by a real sleeved over a fake player with synced lyrics and a
// cover, so a script error, a request the content security policy blocks, a failed request, or a shader that does not
// compile fails here (main.ts and flow.ts are DOM and WebGL code, which the Node tests cannot load). Skipped when no
// Chrome or Chromium is installed or playwright-core is missing (a devDependency that downloads no browser).
const BROWSERS = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const executablePath = BROWSERS.find(file => existsSync(file));
let chromium: typeof import('playwright-core').chromium | null = null;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  chromium = null;
}

// Chrome asks the session and system buses even headless and waits on a slow one; a missing socket is refused at once
const NO_BUS = 'unix:path=/nonexistent/sleeve-test-bus';
const STEP_MS = 15000;

// The page's root, for a function run in it: typed by hand, since the Node tests' TypeScript has no DOM (and a string
// to evaluate would break on the page's content security policy, which allows no eval)
type PageRoot = { document: { documentElement: { classList: { contains(name: string): boolean } } } };

// Waits until the page's root has every one of these classes; when it never does, the error says what the page
// reported meanwhile (a shader that did not compile leaves the flow class off, and says why only in the console)
async function classes(page: Page, names: string[], problems: string[]): Promise<void> {
  try {
    await page.waitForFunction(wanted => wanted.every(name => (globalThis as unknown as PageRoot).document.documentElement.classList.contains(name)), names);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nThe page reported: ${problems.join('\n') || 'nothing'}`);
  }
}

// A real PNG of one color, so the page can decode and draw it (a cover that fails to load only clears the art)
function png(width: number, height: number, [red, green, blue]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [red, green, blue]).flat())]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}

(executablePath && chromium ? describe : describe.skip)('the page in a browser', function () {
  this.timeout(60000);
  let browser: Browser;
  let dir: string;
  let session: NowPlaying;
  let daemon: SleeveDaemon;
  let base: string;
  // Every page a test opened, closed before sleeved is, so none is left reconnecting into the next test
  let pages: Page[];

  before(async () => {
    // SwiftShader stands in for a GPU, so the cover's shaders compile and run here as on a desktop
    browser = await chromium!.launch({
      executablePath, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
      env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: NO_BUS, DBUS_SYSTEM_BUS_ADDRESS: NO_BUS }
    });
  });

  after(async () => {
    await browser?.close();
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sleeve-browser-'));
    const lines = Array.from({ length: 12 }, (_, at) => ({ time: at * 2000, text: `line ${at + 1} of the song` }));
    const best: ScoredCandidate = {
      provider: 'lrclib', id: '1', track: { artist: 'Artist', title: 'Title' }, score: 1, detail: { title: 1, artist: 1, album: null, duration: null },
      lyrics: { synced: true, instrumental: false, lines }
    };
    const result: LyricsResult = { best, candidates: [best], rejected: [], errors: [], pinned: false, offsetMs: 0 };
    const playback: Playback = {
      player: 'mpd', state: 'playing', positionMs: 5000, at: Date.now(), rate: 1, changedAt: Date.now(),
      track: { key: '/m/song.mp3', artist: 'Artist', title: 'Title', file: '/m/song.mp3', durationMs: 60_000 }
    };
    session = new NowPlaying(new PlayerHub([fakePlayer('mpd', { playback })]), { lookup: async () => result });
    session.start();
    const cover = png(64, 64, [40, 120, 200]);
    daemon = new SleeveDaemon(session, {
      port: 0, socketPath: null,
      renderer: new StaticFiles(SOURCE_ROOT, path.join(dir, 'none.css')),
      art: new CoverArt({ tags: { read: async () => ({ lyrics: [] }), picture: async () => ({ format: 'image/png', data: cover }) } })
    });
    await daemon.listen();
    base = `http://127.0.0.1:${daemon.port}`;
    pages = [];
  });

  afterEach(async () => {
    await Promise.all(pages.map(page => page.close()));
    await daemon.close();
    session.close();
    await rm(dir, { recursive: true, force: true });
  });

  // A page recording what went wrong: script errors, console errors (a CSP violation is one), sleeve's own warnings
  // (a shader that did not compile) and failed requests (/user.css is empty, never missing)
  async function open(query = ''): Promise<{ page: Page; problems: string[] }> {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    pages.push(page);
    page.setDefaultTimeout(STEP_MS);
    const problems: string[] = [];
    page.on('pageerror', error => problems.push(`page error: ${error.message}`));
    page.on('console', message => {
      if (message.type() === 'error' || (message.type() === 'warning' && message.text().startsWith('sleeve:'))) problems.push(`${message.type()}: ${message.text()}`);
    });
    page.on('response', response => {
      if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`);
    });
    page.on('requestfailed', request => problems.push(`failed: ${request.url()}`));
    await page.goto(`${base}/${query}`);
    return { page, problems };
  }

  it('shows the lyrics with the current line, and the cover behind them', async () => {
    const { page, problems } = await open();
    await page.waitForSelector('#lines .line.current');
    expect(await page.locator('#lines .line').count()).to.equal(12);
    await classes(page, ['art'], problems);
    expect(problems).to.deep.equal([]);
  });

  it('places the whole cover beside the lyrics with ?style=', async () => {
    const { page, problems } = await open(`?lyrics-area=${encodeURIComponent('40%x100%+0+0')}&style=${encodeURIComponent('--art-fit:contain')}`);
    await page.waitForSelector('#art-whole img.shown');
    const box = await page.locator('#art-whole').boundingBox();
    // The right 60% (768 px) of a 1280 x 720 window, a 720 square less 8% all round, centered in it
    expect(box!.x).to.be.closeTo(512 + (768 - 604.8) / 2, 1);
    expect(box!.width).to.be.closeTo(604.8, 1);
    expect(problems).to.deep.equal([]);
  });

  it('shows the card: a large cover in the middle of its area, the text and the seek bar beneath it', async () => {
    const { page, problems } = await open('?now=card&now-position=center');
    await page.waitForSelector('#now-art:not([hidden])');
    await page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(id: string): { textContent: string } } }).document.getElementById('total').textContent === '1:00');
    const [status, art, title, seek] = await Promise.all(['#status', '#now-art', '#title', '#seek'].map(selector => page.locator(selector).boundingBox()));
    // 220 px wide at --now-scale 1, square, centered in a 1280 x 720 window
    expect(art!.width).to.be.closeTo(220, 1);
    expect(art!.height).to.be.closeTo(220, 1);
    expect(status!.x + status!.width / 2).to.be.closeTo(640, 1);
    expect(status!.y + status!.height / 2).to.be.closeTo(360, 1);
    expect(title!.y).to.be.greaterThan(art!.y + art!.height);
    expect(seek!.y).to.be.greaterThan(title!.y);
    expect(await page.locator('#title').textContent()).to.equal('Title');
    expect(problems).to.deep.equal([]);
  });

  it('shows the strip along the bottom edge on one line, the lyrics kept above it', async () => {
    const { page, problems } = await open('?now=strip&now-position=center-left');
    await page.waitForSelector('#lines .line.current');
    await page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(id: string): { textContent: string } } }).document.getElementById('total').textContent === '1:00');
    const [status, title, seek, total, viewport] = await Promise.all(['#status', '#title', '#seek', '#total', '#viewport'].map(selector => page.locator(selector).boundingBox()));
    // The window's width less 24 px each side, at its bottom
    expect(status!.x).to.be.closeTo(24, 1);
    expect(status!.width).to.be.closeTo(1280 - 48, 1);
    expect(status!.y + status!.height).to.be.closeTo(720 - 18, 1);
    // One line: the title, then the bar, then the length, all on the same row
    expect(seek!.x).to.be.greaterThan(title!.x + title!.width);
    expect(total!.x).to.be.greaterThan(seek!.x + seek!.width - 1);
    expect(Math.abs((seek!.y + seek!.height / 2) - (title!.y + title!.height / 2))).to.be.lessThan(6);
    expect(seek!.width).to.be.greaterThan(400);
    expect(viewport!.y + viewport!.height).to.be.at.most(status!.y);
    expect(await page.locator('#now-art').isVisible()).to.equal(false);
    expect(problems).to.deep.equal([]);
  });

  it('runs the flow and the swirl shaders without a warning', async () => {
    for (const look of ['sleeve-art-flow', 'sleeve-art-swirl']) {
      const { page, problems } = await open(`?style=${encodeURIComponent(`--art-animation:${look}`)}`);
      await classes(page, ['flow', 'art'], problems);
      // A few frames drawn
      await page.waitForTimeout(500);
        expect(problems, look).to.deep.equal([]);
    }
  });

  it('draws the swirl as Sunamu did, in CSS', async () => {
    const { page, problems } = await open(`?style=${encodeURIComponent('--art-animation:sleeve-art-swirl-css')}`);
    await classes(page, ['swirl-css'], problems);
    expect(await page.locator('#art .swirl > div').count()).to.equal(2);
    expect(problems).to.deep.equal([]);
  });
});
