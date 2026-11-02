import { expect } from 'chai';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { musicmanPathsFile, MusicmanLibrary, readMusicmanPaths } from '../../src/players/musicman.ts';
import { mpdSettings } from '../../src/players/settings.ts';

const paths = { mpd: { host: 'mpdhost', port: 6601, baseDirectory: '/music' }, db: { path: '/music/musicman.sqlite' } };

describe('musicman contract', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'sleeve-musicman-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('reads paths.json from $XDG_STATE_HOME/musicman, version 1 only', async () => {
    expect(musicmanPathsFile({ XDG_STATE_HOME: '/state' })).to.equal('/state/musicman/paths.json');
    const file = path.join(dir, 'paths.json');
    expect(readMusicmanPaths(file)).to.equal(null);
    await writeFile(file, JSON.stringify({ version: 1, ...paths }));
    expect(readMusicmanPaths(file)).to.deep.include(paths);
    await writeFile(file, JSON.stringify({ version: 2, ...paths }));
    expect(() => readMusicmanPaths(file)).to.throw('is version 2; this sleeve reads version 1');
  });

  it('finds the library file for a Spotify track, a kept copy before an excluded one', () => {
    const file = path.join(dir, 'musicman.sqlite');
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE rows (track_id TEXT, path TEXT, duration REAL, excluded INTEGER);
      CREATE VIEW spotify_track_files AS SELECT * FROM rows;
      INSERT INTO rows VALUES ('t1', 'A/a copy.mp3', 200.1, 1), ('t1', 'B/b.mp3', 200.25, 0), ('t2', 'C/c.mp3', NULL, 0);
    `);
    db.close();
    const library = new MusicmanLibrary(file, '/music');
    expect(library.fileFor('t1')).to.deep.equal({ file: '/music/B/b.mp3', durationMs: 200_250 });
    expect(library.fileFor('t2')).to.deep.equal({ file: '/music/C/c.mp3' });
    expect(library.fileFor('t3')).to.equal(null);
    library.close();
  });

  it('refuses a database without the view, and has no library without a database', () => {
    const file = path.join(dir, 'old.sqlite');
    new DatabaseSync(file).close();
    expect(() => new MusicmanLibrary(file, '/music')).to.throw('has no spotify_track_files view; update musicman to 1.55.0 or later');
    expect(MusicmanLibrary.fromPaths({ ...paths, db: { path: null } })).to.equal(null);
  });
});

describe('mpdSettings', () => {
  it('takes the option, then MPD_HOST and MPD_PORT, then musicman, then localhost:6600', () => {
    expect(mpdSettings({ env: {} })).to.deep.equal({ host: 'localhost', port: 6600 });
    expect(mpdSettings({ env: {}, musicman: paths })).to.deep.equal({ host: 'mpdhost', port: 6601, musicDirectory: '/music' });
    expect(mpdSettings({ env: { MPD_HOST: 'pw@other', MPD_PORT: '7000' }, musicman: paths })).to.deep.equal({ host: 'other', port: 7000, password: 'pw', musicDirectory: '/music' });
    expect(mpdSettings({ mpd: 'box:6602', musicDirectory: '/m', env: { MPD_HOST: 'other' }, musicman: paths })).to.deep.equal({ host: 'box', port: 6602, musicDirectory: '/m' });
    expect(mpdSettings({ env: { MPD_HOST: '/run/mpd/socket' } })).to.deep.equal({ host: 'localhost', socket: '/run/mpd/socket', port: 6600 });
  });
});
