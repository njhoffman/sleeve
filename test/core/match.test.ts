import { expect } from 'chai';
import { durationScore, normalizeArtist, normalizeTitle, rankCandidates, scoreCandidate, similarity, THRESHOLD, versionMarkers } from '../../src/core/match.ts';
import type { Candidate, Lyrics, ScoredCandidate } from '../../src/core/types.ts';

const synced: Lyrics = { synced: true, instrumental: false, lines: [{ time: 1000, text: 'a' }] };
const unsynced: Lyrics = { synced: false, instrumental: false, lines: [{ time: null, text: 'a' }, { time: null, text: 'b' }] };

function candidate(track: Partial<Candidate['track']>, extra: Partial<Candidate> = {}): Candidate {
  return { provider: 'test', track: { artist: 'Death Cab for Cutie', title: 'Title and Registration', ...track }, lyrics: synced, ...extra };
}

describe('matching', () => {
  it('normalizes titles: accents, case, punctuation, features and same-recording suffixes', () => {
    expect(normalizeTitle('Beyoncé – Halo')).to.equal('beyonce halo');
    expect(normalizeTitle('Song (feat. Someone)')).to.equal('song');
    expect(normalizeTitle('Song ft. Someone Else')).to.equal('song');
    expect(normalizeTitle('Paranoid Android - 2009 Remaster')).to.equal('paranoid android');
    expect(normalizeTitle('Let It Be (Remastered 2009)')).to.equal('let it be');
    // A different recording keeps its marker
    expect(normalizeTitle('Creep (Acoustic)')).to.equal('creep acoustic');
    expect(normalizeTitle('Creep - Live')).to.equal('creep live');
    expect(normalizeTitle('Rock & Roll')).to.equal('rock and roll');
  });

  it('compares only the first credited artist, without a leading "the"', () => {
    expect(normalizeArtist('Radiohead, RADIOHEAD')).to.equal('radiohead');
    expect(normalizeArtist('Simon & Garfunkel')).to.equal('simon');
    expect(normalizeArtist('Daft Punk feat. Pharrell')).to.equal('daft punk');
    expect(normalizeArtist('The Beatles')).to.equal('beatles');
  });

  it('measures similarity from 0 to 1', () => {
    expect(similarity('abc', 'abc')).to.equal(1);
    expect(similarity('', 'abc')).to.equal(0);
    expect(similarity('night', 'nacht')).to.be.within(0.2, 0.5);
  });

  it('scores durations: full within 2 seconds, nothing from 10, unknown as null', () => {
    expect(durationScore(177000, 178900)).to.equal(1);
    expect(durationScore(177000, 183000)).to.equal(0.5);
    expect(durationScore(177000, 190000)).to.equal(0);
    expect(durationScore(undefined, 177000)).to.equal(null);
  });

  it('scores a close match high and leaves out what is unknown', () => {
    const scored = scoreCandidate({ artist: 'Death Cab For Cutie', title: 'Title and Registration' }, candidate({ durationMs: 220000 }));
    expect(scored.score).to.equal(1);
    expect(scored.detail).to.deep.equal({ title: 1, artist: 1, album: null, duration: null });
  });

  it('keeps a wrong version, a wrong song or a wrong artist under the threshold', () => {
    const query = { artist: 'Death Cab for Cutie', title: 'Title and Registration', durationMs: 220000 };
    expect(scoreCandidate(query, candidate({ durationMs: 260000 })).score).to.be.below(THRESHOLD);
    expect(scoreCandidate(query, candidate({ title: 'Transatlanticism', durationMs: 220000 })).score).to.be.below(THRESHOLD);
    expect(scoreCandidate(query, candidate({ artist: 'The Postal Service', durationMs: 220000 })).score).to.be.below(THRESHOLD);
  });

  it('keeps another version of the song (a remix, live, stripped) under the threshold, whatever its length', () => {
    const query = { artist: 'London Grammar', title: 'Hey Now (SBMRGE Remix)', durationMs: 220000 };
    expect(scoreCandidate(query, candidate({ artist: 'London Grammar', title: 'Hey Now', durationMs: 220000 })).score).to.be.below(THRESHOLD);
    const plain = { artist: 'The Naked and Famous', title: 'Punching in a Dream', durationMs: 220000 };
    expect(scoreCandidate(plain, candidate({ artist: 'The Naked and Famous', title: 'Punching in a Dream (Stripped)', durationMs: 220000 })).score).to.be.below(THRESHOLD);
    expect(scoreCandidate(plain, candidate({ artist: 'The Naked and Famous', title: 'Punching in a Dream - Live at Brixton', durationMs: 220000 })).score).to.be.below(THRESHOLD);
    // The same version, however it is written, still matches
    const live = { artist: 'Portishead', title: 'Mysterons (live)', durationMs: 220000 };
    expect(scoreCandidate(live, candidate({ artist: 'Portishead', title: 'Mysterons [Live]', durationMs: 220000 })).score).to.be.above(0.9);
    const remix = { artist: 'Meg Myers', title: 'Desire (Hucci remix)', durationMs: 220000 };
    expect(scoreCandidate(remix, candidate({ artist: 'Meg Myers', title: 'Desire - Hucci Mix', durationMs: 220000 })).score).to.be.above(THRESHOLD);
  });

  it('reads versions only from suffixes, not from the song\'s name, credits or "original mix"', () => {
    expect([...versionMarkers('Live Forever')]).to.deep.equal([]);
    expect([...versionMarkers('Remix to Ignition')]).to.deep.equal([]);
    expect([...versionMarkers('Three MCs (feat. Mix Master Mike)')]).to.deep.equal([]);
    expect([...versionMarkers('Strobe (Original Mix)')]).to.deep.equal([]);
    expect([...versionMarkers('Strobe (Radio Edit)')]).to.deep.equal(['edit']);
    expect([...versionMarkers('Song - Acoustic Version')]).to.deep.equal(['acoustic']);
    expect([...versionMarkers('Song (Live) [2011 Remaster]')]).to.deep.equal(['live']);
  });

  it('scores exact candidates 1 whatever their text', () => {
    expect(scoreCandidate({ artist: 'A', title: 'B' }, candidate({}, { exact: true })).score).to.equal(1);
  });

  it('ranks synced first, then by score, word timing and length', () => {
    const scored = (score: number, lyrics: Lyrics, provider: string): ScoredCandidate => ({
      ...candidate({}, { lyrics, provider }), score, detail: { title: 1, artist: 1, album: null, duration: null }
    });
    const words: Lyrics = { synced: true, instrumental: false, lines: [{ time: 0, text: 'a', words: [{ time: 0, text: 'a' }] }] };
    const ranked = rankCandidates([scored(1, unsynced, 'plain'), scored(0.8, synced, 'low'), scored(0.9, synced, 'high'), scored(0.9, words, 'words')]);
    expect(ranked.map(item => item.provider)).to.deep.equal(['words', 'high', 'low', 'plain']);
  });
});
