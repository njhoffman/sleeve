import { parseLrc } from '../lrc.ts';
import { scoreCandidate, THRESHOLD } from '../match.ts';
import type { Candidate, Lyrics, MatchedTrack, TrackQuery } from '../types.ts';
import { ProviderHttpError, type Provider, type ProviderContext } from './provider.ts';

// NetEase Cloud Music (music.163.com): synced LRC with no account. Its search ranks loosely (live versions,
// covers and other songs of the artist come first), so the search results, which carry each song's length,
// are scored against the query before any lyrics are fetched, and lyrics are fetched only for the best few
// that could pass. Its lyrics often open with credit lines ("作词 : Thom Yorke", lyricist; "作曲", composer),
// which are dropped. The Chinese translation (tlyric) is not used.

const BASE = 'https://music.163.com/api';
// Search results asked for, and how many of the best-scored get their lyrics fetched
const SEARCH_LIMIT = 20;
const LYRIC_FETCHES = 2;

export interface NeteaseSong {
  id: number;
  name: string;
  artists: Array<{ name: string }>;
  album?: { name?: string | null } | null;
  // Milliseconds
  duration?: number;
}

interface NeteaseLyricResponse {
  code: number;
  nolyric?: boolean;
  uncollected?: boolean;
  lrc?: { lyric?: string };
}

// Credit lines: a role in Chinese or English, a colon (either width) and names
const CREDIT = /^(作词|作曲|编曲|制作人|制作|监制|混音|母带|录音|和声|吉他|贝斯|鼓|键盘|弦乐|出品|发行|词|曲|lyricist|lyrics by|composer|composed by|arranger|producer)\s*[:：]/i;

export function stripCredits(lyrics: Lyrics): Lyrics {
  return { ...lyrics, lines: lyrics.lines.filter(line => !CREDIT.test(line.text.trim())) };
}

export function trackOf(song: NeteaseSong): MatchedTrack {
  return {
    artist: song.artists.map(artist => artist.name).join(', '),
    title: song.name,
    ...(song.album?.name ? { album: song.album.name } : {}),
    ...(song.duration ? { durationMs: song.duration } : {})
  };
}

async function request(path: string, params: Record<string, string>, context: ProviderContext): Promise<{ code?: number; message?: string; msg?: string }> {
  const response = await context.fetch(`${BASE}${path}?${new URLSearchParams(params)}`, {
    headers: { 'User-Agent': context.userAgent, Accept: 'application/json' }, signal: context.signal
  });
  if (!response.ok) throw new ProviderHttpError('NetEase', response.status, (await response.text().catch(() => '')).slice(0, 200));
  const body = await response.json() as { code?: number; message?: string; msg?: string };
  // Errors also come as HTTP 200 with their own code (e.g. -460 when it refuses a client)
  if (body.code !== undefined && body.code !== 200) throw new ProviderHttpError('NetEase', body.code, body.message ?? body.msg ?? '');
  return body;
}

// The search results most likely to be the track, best first, without the ones that cannot pass
export function bestSongs(query: TrackQuery, songs: NeteaseSong[], count = LYRIC_FETCHES): NeteaseSong[] {
  const placeholder: Lyrics = { synced: true, instrumental: false, lines: [] };
  return songs
    .map(song => ({ song, score: scoreCandidate(query, { provider: 'netease', track: trackOf(song), lyrics: placeholder }).score }))
    .filter(item => item.score >= THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map(item => item.song);
}

async function lyricsFor(song: NeteaseSong, context: ProviderContext): Promise<Candidate | null> {
  const body = await request('/song/lyric', { id: String(song.id), lv: '-1', kv: '-1', tv: '-1' }, context) as NeteaseLyricResponse;
  if (body.nolyric) return { provider: 'netease', id: String(song.id), track: trackOf(song), lyrics: { synced: false, instrumental: true, lines: [] } };
  const text = body.lrc?.lyric?.trim();
  if (!text) return null;
  const lyrics = stripCredits(parseLrc(text));
  if (!lyrics.lines.length) return null;
  return { provider: 'netease', id: String(song.id), track: trackOf(song), lyrics };
}

export const netease: Provider = {
  name: 'netease',
  local: false,

  async search(query: TrackQuery, context: ProviderContext): Promise<Candidate[]> {
    const body = await request('/search/get', { s: `${query.title} ${query.artist}`, type: '1', limit: String(SEARCH_LIMIT), offset: '0' }, context) as {
      result?: { songs?: NeteaseSong[] };
    };
    const songs = bestSongs(query, body.result?.songs ?? []);
    const found = await Promise.all(songs.map(song => lyricsFor(song, context)));
    return found.filter((candidate): candidate is Candidate => candidate !== null);
  }
};
