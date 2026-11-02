import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { musicMetadataReader, storedLyrics } from '../../src/core/tags/musicMetadata.ts';
import { SILENCE, writeTaggedMp3 } from '../helpers/id3.ts';

describe('music-metadata tag reader', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'sleeve-tags-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('reads artist, title, album, the measured duration, ISRC and musicman\'s Spotify fields', async () => {
    const file = await writeTaggedMp3(path.join(dir, 'song.mp3'), {
      artist: 'Attune', title: 'Reminder', album: 'Love', isrc: 'QZDA81821251',
      custom: { sp_track_id: '0CBShUBd6XzTAH9JMXcJx7', sp_duration_ms: '307000' }
    });
    const tags = await musicMetadataReader.read(file);
    expect(tags).to.deep.include({
      artist: 'Attune', title: 'Reminder', album: 'Love', isrc: 'QZDA81821251',
      spotifyId: '0CBShUBd6XzTAH9JMXcJx7', spotifyDurationMs: 307000, lyrics: []
    });
    expect(tags.durationMs).to.be.within(2900, 3200);
  });

  it('reads USLT and SYLT lyrics', async () => {
    const file = await writeTaggedMp3(path.join(dir, 'song.mp3'), {
      artist: 'A', title: 'T', unsynced: '[00:01.00]One\n[00:02.00]Two',
      synced: [{ time: 1000, text: 'One' }, { time: 2500, text: 'Two' }]
    });
    const { lyrics } = await musicMetadataReader.read(file);
    expect(lyrics).to.deep.include({ frame: 'USLT', synced: false, text: '[00:01.00]One\n[00:02.00]Two', lines: [] });
    expect(lyrics).to.deep.include({ frame: 'SYLT', synced: true, text: '', lines: [{ time: 1000, text: 'One' }, { time: 2500, text: 'Two' }] });
  });

  it('reads a file without tags', async () => {
    const tags = await musicMetadataReader.read(SILENCE);
    expect(tags.artist).to.equal(undefined);
    expect(tags.lyrics).to.deep.equal([]);
  });

  it('skips SYLT timed in MPEG frames, which need the frame rate', () => {
    expect(storedLyrics({ contentType: 1, timeStampFormat: 1, syncText: [{ text: 'x', timestamp: 10 }] } as never)).to.equal(null);
  });
});
