import { expect } from 'chai';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Picture, TagReader } from '../../src/core/tags/reader.ts';
import { CoverArt, rasterFormat } from '../../src/daemon/art.ts';
import { SleeveDaemon } from '../../src/daemon/server.ts';
import { StaticFiles } from '../../src/daemon/static.ts';
import { NowPlaying } from '../../src/now/session.ts';
import { PlayerHub } from '../../src/players/hub.ts';
import type { Playback, PlayingTrack } from '../../src/players/types.ts';
import { fakeFetch } from '../helpers/fetch.ts';
import { fakePlayer } from '../helpers/players.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 1, 2]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe('cover art', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'sleeve-art-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const tags = (picture: Picture | null): TagReader & { asked: string[] } => {
    const asked: string[] = [];
    return { asked, read: async () => ({ lyrics: [] }), picture: async file => { asked.push(file); return picture; } };
  };
  const track = (extra: Partial<PlayingTrack>): PlayingTrack => ({ key: 'k', artist: 'A', title: 'T', ...extra });

  it('takes the embedded picture first, then cover.jpg and the like beside the file', async () => {
    const file = path.join(dir, 'song.mp3');
    const embedded = await new CoverArt({ tags: tags({ format: 'image/png', data: PNG }) }).cover(track({ file }));
    expect(embedded).to.deep.equal({ format: 'image/png', data: PNG });

    await writeFile(path.join(dir, 'Folder.JPG'), JPEG);
    await writeFile(path.join(dir, 'cover.png'), PNG);
    await writeFile(path.join(dir, 'back.jpg'), JPEG);
    const beside = await new CoverArt({ tags: tags(null) }).cover(track({ file }));
    expect(beside).to.deep.equal({ format: 'image/png', data: new Uint8Array(PNG) });
    await rm(path.join(dir, 'cover.png'));
    expect((await new CoverArt({ tags: tags(null) }).cover(track({ file })))!.format).to.equal('image/jpeg');
  });

  it('fetches the player\'s https cover, refusing what is not an image, and reads a file:// one', async () => {
    // Bytes as they are: fakeFetch's string bodies go out as UTF-8
    const fetch = (async (url: string | URL | Request) => String(url).includes('good')
      ? new Response(new Uint8Array(JPEG), { headers: { 'Content-Type': 'image/jpeg' } })
      : new Response('<html>', { headers: { 'Content-Type': 'text/html' } })) as typeof globalThis.fetch;
    const art = new CoverArt({ tags: tags(null), fetch });
    expect((await art.cover(track({ key: 'a', artUrl: 'https://i.scdn.co/good' })))!.format).to.equal('image/jpeg');
    expect(await art.cover(track({ key: 'b', artUrl: 'https://example.com/page' }))).to.equal(null);
    await writeFile(path.join(dir, 'art.png'), PNG);
    expect((await art.cover(track({ key: 'c', artUrl: pathToFileURL(path.join(dir, 'art.png')).href })))!.format).to.equal('image/png');
    // Not an image by its name: never read
    await writeFile(path.join(dir, 'notes.txt'), 'secret');
    expect(await art.cover(track({ key: 'd', artUrl: pathToFileURL(path.join(dir, 'notes.txt')).href }))).to.equal(null);
  });

  it('knows a raster image by its first bytes, whatever it claims to be', () => {
    expect(rasterFormat(JPEG)).to.equal('image/jpeg');
    expect(rasterFormat(PNG)).to.equal('image/png');
    expect(rasterFormat(Buffer.from('GIF89a...'))).to.equal('image/gif');
    expect(rasterFormat(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).to.equal('image/webp');
    for (const data of [SVG, Buffer.from('RIFF\0\0\0\0WAVE'), PNG.subarray(0, 6), Buffer.alloc(0)]) expect(rasterFormat(data)).to.equal(null);
  });

  it('serves a cover as what its bytes are, and no SVG from any source', async () => {
    const file = path.join(dir, 'song.mp3');
    expect(await new CoverArt({ tags: tags({ format: 'image/svg+xml', data: SVG }) }).cover(track({ file }))).to.equal(null);
    expect(await new CoverArt({ tags: tags({ format: 'image/jpeg', data: PNG }) }).cover(track({ file }))).to.deep.equal({ format: 'image/png', data: PNG });
    const fake = fakeFetch([{ match: /svg/, body: SVG.toString('latin1'), headers: { 'Content-Type': 'image/svg+xml' } }]);
    expect(await new CoverArt({ tags: tags(null), fetch: fake.fetch }).cover(track({ key: 's', artUrl: 'https://example.com/svg' }))).to.equal(null);
    await writeFile(path.join(dir, 'cover.jpg'), SVG);
    expect(await new CoverArt({ tags: tags(null) }).cover(track({ file }))).to.equal(null);
  });

  it('refuses a download past 8 MB by its length, and cuts off one that says none once it passes', async () => {
    let pulled = 0;
    let cancelled = 0;
    const endless = () => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(JPEG)); },
      pull(controller) { pulled += 1 << 20; controller.enqueue(new Uint8Array(1 << 20)); },
      cancel() { cancelled++; }
    });
    const fetchOf = (response: () => Response) => (async () => response()) as typeof globalThis.fetch;
    const declared = new CoverArt({ tags: tags(null), fetch: fetchOf(() => new Response(endless(), { headers: { 'Content-Length': String(9 << 20) } })) });
    expect(await declared.cover(track({ key: 'big', artUrl: 'https://example.com/big' }))).to.equal(null);
    expect(pulled).to.be.at.most(2 << 20);
    pulled = 0;
    const silent = new CoverArt({ tags: tags(null), fetch: fetchOf(() => new Response(endless())) });
    expect(await silent.cover(track({ key: 'endless', artUrl: 'https://example.com/endless' }))).to.equal(null);
    expect(pulled).to.be.within(8 << 20, 10 << 20);
    expect(cancelled).to.equal(2);
  });

  it('looks a track up once while it is among the last few', async () => {
    const reader = tags({ format: 'image/png', data: PNG });
    const art = new CoverArt({ tags: reader });
    for (let round = 0; round < 3; round++) await art.cover(track({ file: '/m/a.mp3' }));
    expect(reader.asked).to.have.length(1);
  });

  it('serves only the track playing, at /art/current', async () => {
    const file = path.join(dir, 'song.mp3');
    const playback: Playback = { player: 'mpd', state: 'playing', positionMs: 0, at: 0, rate: 1, changedAt: 0, track: track({ key: '/m/song.mp3', file }) };
    const session = new NowPlaying(new PlayerHub([fakePlayer('mpd', { playback })]), { lookup: async () => null as never });
    session.start();
    const daemon = new SleeveDaemon(session, {
      port: 0, socketPath: null, renderer: new StaticFiles(dir, path.join(dir, 'none.css')), art: new CoverArt({ tags: tags({ format: 'image/png', data: PNG }) })
    });
    await daemon.listen();
    let headers: Record<string, unknown> = {};
    const get = (urlPath: string) => new Promise<{ status: number; type: unknown; size: number }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: daemon.port!, path: urlPath }, response => {
        let size = 0;
        headers = response.headers;
        response.on('data', chunk => { size += chunk.length; });
        response.on('end', () => resolve({ status: response.statusCode!, type: response.headers['content-type'], size }));
      });
      req.on('error', reject);
      req.end();
    });
    try {
      expect(await get(`/art/current?key=${encodeURIComponent('/m/song.mp3')}`)).to.deep.equal({ status: 200, type: 'image/png', size: PNG.length });
      expect(headers).to.include({ 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" });
      expect((await get('/art/current?key=other')).status).to.equal(404);
      expect((await get('/art/current')).status).to.equal(404);
    } finally {
      await daemon.close();
      session.close();
    }
  });
});
