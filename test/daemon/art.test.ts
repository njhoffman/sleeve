import { expect } from 'chai';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Picture, TagReader } from '../../src/core/tags/reader.ts';
import { CoverArt } from '../../src/daemon/art.ts';
import { SleeveDaemon } from '../../src/daemon/server.ts';
import { StaticFiles } from '../../src/daemon/static.ts';
import { NowPlaying } from '../../src/now/session.ts';
import { PlayerHub } from '../../src/players/hub.ts';
import type { Playback, PlayingTrack } from '../../src/players/types.ts';
import { fakeFetch } from '../helpers/fetch.ts';
import { fakePlayer } from '../helpers/players.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 1, 2]);

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
    const fake = fakeFetch([
      { match: /good/, body: JPEG.toString('latin1'), headers: { 'Content-Type': 'image/jpeg' } },
      { match: /page/, body: '<html>', headers: { 'Content-Type': 'text/html' } }
    ]);
    const art = new CoverArt({ tags: tags(null), fetch: fake.fetch });
    expect((await art.cover(track({ key: 'a', artUrl: 'https://i.scdn.co/good' })))!.format).to.equal('image/jpeg');
    expect(await art.cover(track({ key: 'b', artUrl: 'https://example.com/page' }))).to.equal(null);
    await writeFile(path.join(dir, 'art.png'), PNG);
    expect((await art.cover(track({ key: 'c', artUrl: pathToFileURL(path.join(dir, 'art.png')).href })))!.format).to.equal('image/png');
    // Not an image by its name: never read
    await writeFile(path.join(dir, 'notes.txt'), 'secret');
    expect(await art.cover(track({ key: 'd', artUrl: pathToFileURL(path.join(dir, 'notes.txt')).href }))).to.equal(null);
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
    const get = (urlPath: string) => new Promise<{ status: number; type: unknown; size: number }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: daemon.port!, path: urlPath }, response => {
        let size = 0;
        response.on('data', chunk => { size += chunk.length; });
        response.on('end', () => resolve({ status: response.statusCode!, type: response.headers['content-type'], size }));
      });
      req.on('error', reject);
      req.end();
    });
    try {
      expect(await get(`/art/current?key=${encodeURIComponent('/m/song.mp3')}`)).to.deep.equal({ status: 200, type: 'image/png', size: PNG.length });
      expect((await get('/art/current?key=other')).status).to.equal(404);
      expect((await get('/art/current')).status).to.equal(404);
    } finally {
      await daemon.close();
      session.close();
    }
  });
});
