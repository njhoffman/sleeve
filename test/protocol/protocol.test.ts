import { expect } from 'chai';
import type { LyricsResult, ScoredCandidate } from '../../src/core/types.ts';
import { parseCommand } from '../../src/protocol/messages.ts';
import { fromWire, SessionMirror } from '../../src/protocol/mirror.ts';

const best: ScoredCandidate = {
  provider: 'lrclib', id: '1', track: { artist: 'A', title: 'T' }, score: 1, detail: { title: 1, artist: 1, album: null, duration: null },
  lyrics: { synced: true, instrumental: false, lines: [{ time: 1000, text: 'one' }, { time: 3000, text: 'two' }] }
};
const result: LyricsResult = { best, candidates: [best], rejected: [], errors: [], pinned: false, offsetMs: 0 };
const track = { key: 'k', artist: 'A', title: 'T', durationMs: 60_000 };

describe('parseCommand', () => {
  it('takes every command with what it needs', () => {
    expect(parseCommand('{"type":"nudge","ms":-100,"id":3}')).to.deep.equal({ command: { type: 'nudge', ms: -100, id: 3 } });
    expect(parseCommand('{"type":"pick","ref":"lrclib:1","id":"a"}')).to.deep.equal({ command: { type: 'pick', ref: 'lrclib:1', id: 'a' } });
    expect(parseCommand('{"type":"subscribe","lines":true}')).to.deep.equal({ command: { type: 'subscribe', lines: true } });
    expect(parseCommand('{"type":"mark","mark":"instrumental"}')).to.deep.equal({ command: { type: 'mark', mark: 'instrumental' } });
    expect(parseCommand('{"type":"mark","mark":"maybe"}')).to.deep.equal({ error: 'mark needs mark, none or instrumental' });
    for (const type of ['unpick', 'refresh', 'candidates', 'state']) expect(parseCommand(JSON.stringify({ type }))).to.have.property('command');
  });

  it('says what is wrong, with the id when there is one', () => {
    expect(parseCommand('nope')).to.deep.equal({ error: 'Not JSON' });
    expect(parseCommand('[1]')).to.deep.equal({ error: 'Not a JSON object' });
    expect(parseCommand('{"type":"jump","id":7}')).to.deep.equal({ error: 'Unknown command: jump', id: 7 });
    expect(parseCommand('{"type":"nudge","ms":1.5}')).to.deep.equal({ error: 'nudge needs ms, whole milliseconds' });
    expect(parseCommand('{"type":"offset"}')).to.deep.equal({ error: 'offset needs ms, whole milliseconds' });
    expect(parseCommand('{"type":"pick","ref":""}')).to.deep.equal({ error: 'pick needs ref, as provider:id' });
    expect(parseCommand('{"type":"subscribe"}')).to.deep.equal({ error: 'subscribe needs lines, true or false' });
    expect(parseCommand('{"type":"state","id":{}}')).to.deep.equal({ error: 'id must be a string or a number' });
  });
});

describe('SessionMirror', () => {
  it('puts the daemon\'s wall-clock stamp on the local monotonic clock', () => {
    // Sent 250 ms ago by the wall clock; locally that is monotonic 750
    const playback = fromWire({ player: 'mpd', state: 'playing', track, positionMs: 5000, at: 1_000_000, rate: 1 }, { wall: () => 1_000_250, monotonic: () => 1000 });
    expect(playback).to.deep.include({ at: 750, changedAt: 750, positionMs: 5000 });
  });

  it('rebuilds the session state from messages and finds the line playing', () => {
    let wall = 10_000;
    const mirror = new SessionMirror({ wall: () => wall, monotonic: () => wall });
    const changes: unknown[] = [];
    mirror.onChange(state => changes.push(state));
    expect(mirror.apply({ type: 'hello', protocol: 1, version: '9.9.9' })).to.equal(false);
    expect(mirror.version).to.equal('9.9.9');
    expect(mirror.apply({ type: 'offset', offsetMs: 100 })).to.equal(false);
    mirror.apply({ type: 'playback', playback: { player: 'mpd', state: 'playing', track, positionMs: 500, at: 10_000, rate: 1 } });
    mirror.apply({ type: 'lyrics', key: 'mpd:k', query: { artist: 'A', title: 'T' }, loading: false, error: null, result });
    mirror.apply({ type: 'players', problems: [{ player: 'spotify', problem: 'not running' }] });
    expect(mirror.problems()).to.deep.equal([{ player: 'spotify', problem: 'not running' }]);
    expect(mirror.line(wall).index).to.equal(-1);
    expect(mirror.line(wall + 600)).to.deep.include({ index: 0, time: 1000 });
    expect(mirror.position(wall + 600)).to.equal(1100);
    mirror.apply({ type: 'offset', offsetMs: 2000 });
    expect(mirror.current().result!.offsetMs).to.equal(2000);
    expect(mirror.line(wall + 600).index).to.equal(-1);
    mirror.apply({ type: 'playback', playback: null });
    expect(mirror.position()).to.equal(0);
    expect(changes).to.have.length(4);
  });
});
