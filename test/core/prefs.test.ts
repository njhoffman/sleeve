import { expect } from 'chai';
import { formatRef, parseRef, sameCandidate, TrackPrefs } from '../../src/core/prefs.ts';
import type { Candidate, ScoredCandidate } from '../../src/core/types.ts';

const lyrics = { synced: true, instrumental: false, lines: [{ time: 1000, text: 'In the next world war' }] };
const candidate: Candidate = { provider: 'lrclib', id: '12', track: { artist: 'Radiohead', title: 'Airbag', durationMs: 284_000 }, lyrics };
const scored: ScoredCandidate = { ...candidate, cachedAt: 5, score: 0.4, detail: { title: 1, artist: 1, album: null, duration: 0 } };
const other: Candidate = { ...candidate, provider: 'netease', id: '99' };

describe('TrackPrefs', () => {
  let time: number, prefs: TrackPrefs;
  beforeEach(() => {
    time = 1000;
    prefs = new TrackPrefs(':memory:', { now: () => time });
  });
  afterEach(() => prefs.close());

  const query = { artist: 'Radiohead', title: 'Airbag', durationMs: 284_400 };

  it('keeps a pick as the candidate the provider gave, for the same track', () => {
    prefs.setPick(query, scored);
    expect(prefs.get({ artist: 'radiohead', title: 'Airbag (Remastered)', durationMs: 286_000 })).to.deep.equal({ pick: candidate, offset: null, updatedAt: 1000 });
    expect(prefs.get({ ...query, durationMs: 287_000 })).to.equal(null);
    expect(prefs.get({ artist: 'Radiohead', title: 'Airbag' })).to.equal(null);
  });

  it('keeps a mark in place of a pick, and a pick in place of a mark', () => {
    expect(prefs.markCount()).to.equal(0);
    prefs.setPick(query, candidate);
    prefs.setMark(query, 'none');
    expect(prefs.get(query)).to.deep.equal({ pick: null, offset: null, updatedAt: 1000, mark: 'none' });
    expect(prefs.markCount()).to.equal(1);
    prefs.setPick(query, other);
    expect(prefs.get(query)).to.deep.equal({ pick: other, offset: null, updatedAt: 1000 });
    expect(prefs.markCount()).to.equal(0);
  });

  it('forgets a mark with the pick, and the track once nothing is left for it', () => {
    prefs.setMark(query, 'instrumental');
    expect(prefs.clearPick(query)).to.equal(true);
    expect(prefs.get(query)).to.equal(null);
    expect(prefs.clearPick(query)).to.equal(false);
    prefs.setMark(query, 'none');
    prefs.setOffset(query, 100, candidate);
    prefs.clearPick(query);
    expect(prefs.get(query)?.offset?.ms).to.equal(100);
  });

  it('replaces a pick, and removes the track once nothing is left for it', () => {
    prefs.setPick(query, candidate);
    time = 2000;
    prefs.setPick({ ...query, durationMs: 284_000 }, other);
    expect(prefs.get(query)).to.deep.equal({ pick: other, offset: null, updatedAt: 2000 });
    prefs.setOffset(query, -300, other);
    expect(prefs.clearPick(query)).to.equal(true);
    expect(prefs.get(query)).to.deep.equal({ pick: null, offset: { ms: -300, provider: 'netease', id: '99' }, updatedAt: 2000 });
    expect(prefs.clearPick(query)).to.equal(false);
    expect(prefs.clearOffset(query)).to.equal(true);
    expect(prefs.get(query)).to.equal(null);
    expect(prefs.clearOffset(query)).to.equal(false);
  });

  it('sets an offset against a candidate without picking it', () => {
    prefs.setOffset(query, 250, candidate);
    expect(prefs.get(query)).to.deep.include({ pick: null, offset: { ms: 250, provider: 'lrclib', id: '12' } });
    prefs.setOffset(query, 400, other);
    expect(prefs.get(query)?.offset).to.deep.equal({ ms: 400, provider: 'netease', id: '99' });
  });

  it('takes the stored track with the closest duration when several match', () => {
    prefs.setOffset({ ...query, durationMs: 280_000 }, 1, candidate);
    prefs.setOffset({ ...query, durationMs: 283_500 }, 2, candidate);
    expect(prefs.get({ ...query, durationMs: 281_600 })?.offset?.ms).to.equal(1);
    expect(prefs.get({ ...query, durationMs: 283_000 })?.offset?.ms).to.equal(2);
  });

  it('refuses candidates without an id and fractional offsets', () => {
    const { id: _id, ...anonymous } = candidate;
    expect(() => prefs.setPick(query, anonymous)).to.throw('lrclib gave this candidate no id');
    expect(() => prefs.setOffset(query, 1.5, candidate)).to.throw('Offset must be whole milliseconds');
  });
});

describe('candidate refs', () => {
  it('print and parse as provider:id, splitting at the first colon', () => {
    expect(formatRef(candidate)).to.equal('lrclib:12');
    expect(parseRef('Embedded:/m/a:b.mp3#USLT')).to.deep.equal({ provider: 'embedded', id: '/m/a:b.mp3#USLT' });
    expect(parseRef('lrclib')).to.equal(null);
    expect(parseRef(':12')).to.equal(null);
    expect(parseRef('lrclib:')).to.equal(null);
    expect(sameCandidate(candidate, { provider: 'lrclib', id: '12' })).to.equal(true);
    expect(sameCandidate(candidate, { provider: 'lrclib', id: '13' })).to.equal(false);
  });
});

describe('reports on TrackPrefs', () => {
  let time: number, prefs: TrackPrefs;
  beforeEach(() => {
    time = 1000;
    prefs = new TrackPrefs(':memory:', { now: () => time });
  });
  afterEach(() => prefs.close());

  const query = { artist: 'Radiohead', title: 'Airbag', durationMs: 284_400, path: '/m/a.mp3' };

  it('keeps one report per kind and candidate, with what is needed to catch the same lyrics again', () => {
    prefs.addReport(query, 'wrong', candidate);
    time = 2000;
    prefs.addReport(query, 'wrong', candidate);
    prefs.addReport(query, 'mistimed', candidate);
    const reports = prefs.get(query)!.reports!;
    expect(reports.map(report => report.kind)).to.deep.equal(['wrong', 'mistimed']);
    expect(reports[0]).to.deep.include({ provider: 'lrclib', id: '12', artist: 'Radiohead', title: 'Airbag', path: '/m/a.mp3', times: [1000], reportedAt: 2000 });
    expect(reports[0].words).to.match(/^[0-9a-f]{32}$/);
    expect(prefs.reportCount()).to.equal(1);
  });

  it('takes a pick away when it is what was reported, and a report away when it is picked', () => {
    prefs.setPick(query, candidate);
    prefs.addReport(query, 'wrong', other);
    expect(prefs.get(query)!.pick).to.deep.equal(candidate);
    prefs.addReport(query, 'mistimed', candidate);
    expect(prefs.get(query)!.pick).to.equal(null);
    prefs.setPick(query, candidate);
    expect(prefs.get(query)!.reports).to.equal(undefined);
  });

  it('keeps a track with only reports, lists them latest first, and forgets them', () => {
    prefs.addReport(query, 'wrong', candidate);
    time = 2000;
    prefs.addReport({ artist: 'B', title: 'C' }, 'mistimed', other);
    expect(prefs.allReports().map(report => report.provider)).to.deep.equal(['netease', 'lrclib']);
    expect(prefs.clearReports(query)).to.equal(true);
    expect(prefs.clearReports(query)).to.equal(false);
    expect(prefs.get(query)).to.equal(null);
    prefs.setOffset(query, 100, candidate);
    prefs.addReport(query, 'wrong', candidate);
    expect(prefs.clearAllReports()).to.equal(2);
    expect(prefs.reportCount()).to.equal(0);
    expect(prefs.get(query)!.offset!.ms).to.equal(100);
    expect(prefs.get({ artist: 'B', title: 'C' })).to.equal(null);
  });
});
