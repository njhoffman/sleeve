import { chmod, open, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeUslt, encodeUslt, Id3Error, id3Size, parseId3, usltFrames, withUslt, type Uslt } from './id3.ts';

// Reading and writing the lyrics (USLT) in an mp3's ID3 tag, as musicman's contract allows: the file is rewritten
// through a temporary file renamed over it, only if its mtime and size are still what they were when it was read,
// so a write by musicman (or anyone) in between is never lost. The new mtime is left alone: musicman notices
// changes by it.

export class FileChangedError extends Error {}

export interface LyricsTag {
  // The file itself, symlinks followed, so a rename replaces it and not the link
  file: string;
  mtimeMs: number;
  size: number;
  // null for a file without an ID3v2 tag
  version: 3 | 4 | null;
  uslt: Uslt | null;
  // How many USLT frames the tag has; more than one cannot be replaced (the contract wants one)
  usltCount: number;
}

// The lyrics frame of a file, reading only its tag. Throws Id3Error for a tag that cannot be changed frame by frame.
export async function readLyricsTag(file: string): Promise<LyricsTag> {
  const real = await realpath(file);
  const handle = await open(real, 'r');
  try {
    const info = await handle.stat();
    const head = Buffer.alloc(10);
    await handle.read(head, 0, 10, 0);
    const size = id3Size(head);
    const base = { file: real, mtimeMs: info.mtimeMs, size: info.size };
    if (size === null) return { ...base, version: null, uslt: null, usltCount: 0 };
    const bytes = Buffer.alloc(Math.min(size, info.size));
    await handle.read(bytes, 0, bytes.length, 0);
    const tag = parseId3(bytes)!;
    const frames = usltFrames(tag);
    return { ...base, version: tag.version, uslt: frames.length ? decodeUslt(tag, frames[0]) : null, usltCount: frames.length };
  } finally {
    await handle.close();
  }
}

async function unchanged(read: LyricsTag): Promise<void> {
  const now = await stat(read.file);
  if (now.mtimeMs !== read.mtimeMs || now.size !== read.size) throw new FileChangedError(`${read.file} changed while sleeve worked on it`);
}

// Writes text as the file's one USLT frame (its language kept, "XXX" for a new one; no description), the rest of the
// tag and the audio untouched. read is what readLyricsTag gave before the lookup; a file changed since throws
// FileChangedError and is left as it is.
export async function writeLyricsTag(read: LyricsTag, text: string): Promise<void> {
  await unchanged(read);
  const bytes = await readFile(read.file);
  const tag = parseId3(bytes);
  let head: Buffer;
  let audio: Buffer;
  if (tag) {
    if (usltFrames(tag).length > 1) throw new Id3Error(`${usltFrames(tag).length} USLT frames`);
    head = withUslt(tag, encodeUslt(tag.version, { language: read.uslt?.language || 'XXX', description: '', text }));
    audio = bytes.subarray(tag.size);
  } else {
    // No tag yet: an ID3v2.3 one with only the lyrics, as musicman's node-id3 writes them
    const empty = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]);
    head = withUslt(parseId3(empty)!, encodeUslt(3, { language: 'XXX', description: '', text }));
    audio = bytes;
  }
  const temporary = path.join(path.dirname(read.file), `.${path.basename(read.file)}.sleeve-${process.pid}.tmp`);
  try {
    await writeFile(temporary, Buffer.concat([head, audio]), { flag: 'wx' });
    await chmod(temporary, (await stat(read.file)).mode & 0o7777);
    const handle = await open(temporary, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await unchanged(read);
    await rename(temporary, read.file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
