// The part of ID3v2 sleeve writes: the USLT (unsynchronised lyrics) frame of an ID3v2.3 or 2.4 tag, replaced or
// added without touching any other byte of the tag. musicman's contract (its docs/09-contract.md, "Lyrics in the
// library's tags") asks for exactly that: one USLT, every other frame as it was, and the tag's version kept.
// Tags this cannot change frame by frame (ID3v2.2, tag-level unsynchronisation, an extended header, a footer, a
// damaged frame list, a USLT compressed or encrypted) are refused with an Id3Error rather than guessed at.

export class Id3Error extends Error {}

export interface Id3Frame {
  id: string;
  // Byte offsets in the tag, from the frame's header to its end
  start: number;
  end: number;
}

export interface Id3Tag {
  version: 3 | 4;
  // Header and frames and padding: where the audio starts
  size: number;
  frames: Id3Frame[];
  // The whole tag, header included
  bytes: Buffer;
}

export interface Uslt {
  language: string;
  description: string;
  text: string;
}

const HEADER = 10;
// Room left after a tag that has to grow, so the next change fits without moving the audio again
const PADDING = 1024;

const syncsafe = (bytes: Buffer, at: number) =>
  (bytes[at] & 0x7f) << 21 | (bytes[at + 1] & 0x7f) << 14 | (bytes[at + 2] & 0x7f) << 7 | (bytes[at + 3] & 0x7f);

function writeSyncsafe(bytes: Buffer, at: number, value: number): void {
  if (value >= 2 ** 28) throw new Id3Error('tag too large');
  for (let index = 0; index < 4; index++) bytes[at + index] = (value >> (7 * (3 - index))) & 0x7f;
}

// The tag's total size from its first 10 bytes, or null when the file has no ID3v2 tag
export function id3Size(head: Buffer): number | null {
  if (head.length < HEADER || head.toString('latin1', 0, 3) !== 'ID3') return null;
  return HEADER + syncsafe(head, 6);
}

// The tag at the start of bytes (a whole file, or at least its tag), or null without one
export function parseId3(bytes: Buffer): Id3Tag | null {
  const size = id3Size(bytes);
  if (size === null) return null;
  const version = bytes[3];
  if (version !== 3 && version !== 4) throw new Id3Error(`ID3v2.${version} tag`);
  const flags = bytes[5];
  if (flags & 0x80) throw new Id3Error('unsynchronised tag');
  if (flags & 0x40) throw new Id3Error('tag with an extended header');
  if (version === 4 && flags & 0x10) throw new Id3Error('tag with a footer');
  if (bytes.length < size) throw new Id3Error('tag runs past the end of the file');
  const frames: Id3Frame[] = [];
  let at = HEADER;
  while (at + HEADER <= size && bytes[at] !== 0) {
    const id = bytes.toString('latin1', at, at + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) throw new Id3Error(`damaged frame list at byte ${at}`);
    const length = version === 4 ? syncsafe(bytes, at + 4) : bytes.readUInt32BE(at + 4);
    const end = at + HEADER + length;
    if (end > size) throw new Id3Error(`${id} frame runs past the end of the tag`);
    frames.push({ id, start: at, end });
    at = end;
  }
  return { version, size, frames, bytes: bytes.subarray(0, size) };
}

function decodeText(bytes: Buffer, encoding: number): string {
  if (encoding === 0) return bytes.toString('latin1');
  if (encoding === 3) return bytes.toString('utf8');
  let body = bytes;
  let bigEndian = encoding === 2;
  if (encoding === 1 && body.length >= 2) {
    if (body[0] === 0xfe && body[1] === 0xff) bigEndian = true;
    if ((body[0] === 0xfe && body[1] === 0xff) || (body[0] === 0xff && body[1] === 0xfe)) body = body.subarray(2);
  }
  if (bigEndian) body = Buffer.from(body).swap16();
  return body.subarray(0, body.length - (body.length % 2)).toString('utf16le');
}

// Where the null that ends a string in this encoding starts (one byte, or two aligned ones for UTF-16)
function terminator(bytes: Buffer, from: number, encoding: number): number {
  if (encoding === 0 || encoding === 3) {
    const at = bytes.indexOf(0, from);
    return at < 0 ? bytes.length : at;
  }
  for (let at = from; at + 1 < bytes.length; at += 2) if (bytes[at] === 0 && bytes[at + 1] === 0) return at;
  return bytes.length;
}

export function decodeUslt(tag: Id3Tag, frame: Id3Frame): Uslt {
  const flags = tag.bytes[frame.start + 9];
  // ID3v2.3: compression, encryption, grouping; ID3v2.4: grouping, compression, encryption, unsynchronisation,
  // data length
  if (tag.version === 3 ? flags & 0xe0 : flags & 0x4f) throw new Id3Error('USLT frame is compressed, encrypted or grouped');
  const data = tag.bytes.subarray(frame.start + HEADER, frame.end);
  if (data.length < 4) return { language: '', description: '', text: '' };
  const encoding = data[0];
  if (encoding > 3) throw new Id3Error(`USLT frame has an unknown text encoding ${encoding}`);
  const language = data.toString('latin1', 1, 4);
  const end = terminator(data, 4, encoding);
  const description = decodeText(data.subarray(4, end), encoding);
  const text = decodeText(data.subarray(Math.min(data.length, end + (encoding === 0 || encoding === 3 ? 1 : 2))), encoding);
  return { language, description, text: text.replace(/\0+$/, '') };
}

// A USLT frame for the tag's version: UTF-16 with a byte order mark in ID3v2.3 (it has no UTF-8), UTF-8 in 2.4
export function encodeUslt(version: 3 | 4, uslt: Uslt): Buffer {
  const language = Buffer.from((uslt.language + 'XXX').slice(0, 3), 'latin1');
  const parts = version === 3
    ? [Buffer.from([1]), language, Buffer.from([0xff, 0xfe]), Buffer.from(uslt.description, 'utf16le'), Buffer.from([0, 0]),
      Buffer.from([0xff, 0xfe]), Buffer.from(uslt.text, 'utf16le')]
    : [Buffer.from([3]), language, Buffer.from(uslt.description, 'utf8'), Buffer.from([0]), Buffer.from(uslt.text, 'utf8')];
  const data = Buffer.concat(parts);
  const header = Buffer.alloc(HEADER);
  header.write('USLT', 0, 'latin1');
  if (version === 4) writeSyncsafe(header, 4, data.length);
  else header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

export function usltFrames(tag: Id3Tag): Id3Frame[] {
  return tag.frames.filter(frame => frame.id === 'USLT');
}

// The tag with its one USLT frame replaced by frame (or frame added after the others), every other frame byte for
// byte as it was. It keeps the tag's size when the frames still fit, so the audio stays where it is; otherwise it
// grows, with PADDING to spare.
export function withUslt(tag: Id3Tag, frame: Buffer): Buffer {
  const existing = usltFrames(tag);
  if (existing.length > 1) throw new Id3Error(`${existing.length} USLT frames`);
  const parts = tag.frames.map(item => item.id === 'USLT' ? frame : tag.bytes.subarray(item.start, item.end));
  if (!existing.length) parts.push(frame);
  const body = Buffer.concat(parts);
  const size = HEADER + body.length <= tag.size ? tag.size : HEADER + body.length + PADDING;
  const out = Buffer.alloc(size);
  tag.bytes.copy(out, 0, 0, HEADER);
  writeSyncsafe(out, 6, size - HEADER);
  body.copy(out, HEADER);
  return out;
}
