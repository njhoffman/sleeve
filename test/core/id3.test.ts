import { expect } from 'chai';
import { decodeUslt, encodeUslt, Id3Error, parseId3, usltFrames, withUslt } from '../../src/core/tags/id3.ts';
import { id3Tag } from '../helpers/id3.ts';

const tagged = (extra: Parameters<typeof id3Tag>[0] = {}) => id3Tag({ artist: 'Artist', title: 'Title', custom: { sp_track_id: 'abc' }, ...extra });

function withHeader(version: number, flags: number, body: Buffer): Buffer {
  const header = Buffer.from([0x49, 0x44, 0x33, version, 0, flags, 0, 0, 0, 0]);
  for (let index = 0; index < 4; index++) header[6 + index] = (body.length >> (7 * (3 - index))) & 0x7f;
  return Buffer.concat([header, body]);
}

describe('ID3 lyrics frame', () => {
  it('lists the frames of a tag and reads its USLT', () => {
    const tag = parseId3(tagged({ unsynced: '[00:01.00]Hello' }))!;
    expect(tag.version).to.equal(3);
    expect(tag.frames.map(frame => frame.id)).to.deep.equal(['TPE1', 'TIT2', 'TXXX', 'USLT']);
    expect(decodeUslt(tag, usltFrames(tag)[0])).to.deep.equal({ language: 'eng', description: '', text: '[00:01.00]Hello' });
    expect(parseId3(Buffer.from('not a tag at all'))).to.equal(null);
  });

  it('replaces the USLT and keeps every other frame byte for byte, in place when it fits', () => {
    const original = Buffer.concat([tagged({ unsynced: 'a much longer old text than the new one' }), Buffer.alloc(64)]);
    // Padding after the frames, as most taggers leave
    const padded = withHeader(3, 0, Buffer.concat([original.subarray(10, original.length - 64), Buffer.alloc(64)]));
    const tag = parseId3(padded)!;
    const out = withUslt(tag, encodeUslt(3, { language: 'eng', description: '', text: 'new' }));
    expect(out.length).to.equal(tag.size);
    const after = parseId3(out)!;
    expect(after.frames.map(frame => frame.id)).to.deep.equal(['TPE1', 'TIT2', 'TXXX', 'USLT']);
    for (const index of [0, 1, 2]) {
      const before = tag.frames[index], now = after.frames[index];
      expect(out.subarray(now.start, now.end).equals(tag.bytes.subarray(before.start, before.end))).to.equal(true);
    }
    expect(decodeUslt(after, after.frames[3]).text).to.equal('new');
  });

  it('adds a USLT after the other frames, growing the tag with padding to spare', () => {
    const tag = parseId3(tagged())!;
    const text = 'x'.repeat(500);
    const out = withUslt(tag, encodeUslt(3, { language: 'XXX', description: '', text }));
    expect(out.length).to.be.greaterThan(tag.size + 1000);
    const after = parseId3(out)!;
    expect(after.frames.map(frame => frame.id)).to.deep.equal(['TPE1', 'TIT2', 'TXXX', 'USLT']);
    expect(out.subarray(10, tag.size).equals(tag.bytes.subarray(10, tag.size))).to.equal(true);
    expect(decodeUslt(after, after.frames[3])).to.deep.equal({ language: 'XXX', description: '', text });
  });

  it('writes UTF-8 with syncsafe frame sizes in ID3v2.4, and reads every text encoding', () => {
    const frame = encodeUslt(4, { language: 'eng', description: '', text: 'Ünïcode ' + 'y'.repeat(200) });
    const tag = parseId3(withHeader(4, 0, frame))!;
    expect(tag.version).to.equal(4);
    expect(decodeUslt(tag, tag.frames[0]).text).to.equal('Ünïcode ' + 'y'.repeat(200));
    const latin = Buffer.concat([Buffer.from('USLT'), Buffer.from([0, 0, 0, 12, 0, 0]), Buffer.from([0]), Buffer.from('eng'), Buffer.from('d\0caf\xe9', 'latin1'), Buffer.from('ok', 'latin1')]);
    const latinTag = parseId3(withHeader(3, 0, latin))!;
    expect(decodeUslt(latinTag, latinTag.frames[0])).to.deep.equal({ language: 'eng', description: 'd', text: 'café' + 'ok' });
  });

  it('refuses tags it cannot change frame by frame', () => {
    const body = tagged().subarray(10);
    expect(() => parseId3(withHeader(2, 0, body))).to.throw(Id3Error, 'ID3v2.2');
    expect(() => parseId3(withHeader(3, 0x80, body))).to.throw(Id3Error, 'unsynchronised');
    expect(() => parseId3(withHeader(3, 0x40, body))).to.throw(Id3Error, 'extended header');
    expect(() => parseId3(withHeader(3, 0, Buffer.from('tpe1\0\0\0\x01\0\0x', 'latin1')))).to.throw(Id3Error, 'damaged');
    const two = parseId3(withHeader(3, 0, Buffer.concat([encodeUslt(3, { language: 'eng', description: '', text: 'a' }), encodeUslt(3, { language: 'deu', description: '', text: 'b' })])))!;
    expect(() => withUslt(two, encodeUslt(3, { language: 'eng', description: '', text: 'c' }))).to.throw(Id3Error, '2 USLT frames');
  });
});
