import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Writes small tagged mp3s for tests: an ID3v2.3 tag built by hand in front of an untagged 3-second mp3
// (test/fixtures/audio/silence-3s.mp3). ffmpeg cannot write USLT frames, and tests should not depend on a tag
// writing library, so the frames are encoded here.

export const SILENCE = fileURLToPath(new URL('../fixtures/audio/silence-3s.mp3', import.meta.url));

function frame(id: string, data: Buffer): Buffer {
  const header = Buffer.alloc(10);
  header.write(id, 0, 'latin1');
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

// Encoding byte 1 (UTF-16 with BOM) followed by the text, for text frames
function text(value: string): Buffer {
  return Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(value, 'utf16le')]);
}

function utf16z(value: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, 'utf16le'), Buffer.from([0, 0])]);
}

export interface TestTags {
  artist?: string;
  title?: string;
  album?: string;
  isrc?: string;
  // TXXX frames by description, e.g. { sp_track_id: '...' }
  custom?: Record<string, string>;
  // USLT text
  unsynced?: string;
  // SYLT lines with millisecond timestamps
  synced?: Array<{ time: number; text: string }>;
}

export function id3Tag(tags: TestTags): Buffer {
  const frames: Buffer[] = [];
  if (tags.artist) frames.push(frame('TPE1', text(tags.artist)));
  if (tags.title) frames.push(frame('TIT2', text(tags.title)));
  if (tags.album) frames.push(frame('TALB', text(tags.album)));
  if (tags.isrc) frames.push(frame('TSRC', text(tags.isrc)));
  for (const [description, value] of Object.entries(tags.custom ?? {})) {
    frames.push(frame('TXXX', Buffer.concat([Buffer.from([1]), utf16z(description), Buffer.from([0xff, 0xfe]), Buffer.from(value, 'utf16le')])));
  }
  if (tags.unsynced !== undefined) {
    frames.push(frame('USLT', Buffer.concat([Buffer.from([1]), Buffer.from('eng', 'latin1'), utf16z(''), Buffer.from([0xff, 0xfe]), Buffer.from(tags.unsynced, 'utf16le')])));
  }
  if (tags.synced) {
    // Encoding, language, timestamp format 2 (milliseconds), content type 1 (lyrics), empty descriptor
    const parts = [Buffer.from([1]), Buffer.from('eng', 'latin1'), Buffer.from([2, 1]), utf16z('')];
    for (const line of tags.synced) {
      const time = Buffer.alloc(4);
      time.writeUInt32BE(line.time);
      parts.push(utf16z(line.text), time);
    }
    frames.push(frame('SYLT', Buffer.concat(parts)));
  }
  const body = Buffer.concat(frames);
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]);
  // Syncsafe size: 7 bits per byte
  for (let index = 0; index < 4; index++) header[6 + index] = (body.length >> (7 * (3 - index))) & 0x7f;
  return Buffer.concat([header, body]);
}

export async function writeTaggedMp3(file: string, tags: TestTags): Promise<string> {
  await writeFile(file, Buffer.concat([id3Tag(tags), await readFile(SILENCE)]));
  return file;
}
