import { parseFile, type IAudioMetadata, type ILyricsTag } from 'music-metadata';
import type { LyricLine } from '../types.ts';
import type { FileTags, StoredLyrics, TagReader } from './reader.ts';

// The TagReader on music-metadata (read-only). ID3 custom frames such as musicman's TXXX:sp_track_id come
// from the native tags; the rest from music-metadata's common tags.

// SYLT timestamp formats (ID3v2.4 4.9): 1 is MPEG frames, which need the frame rate to convert; 2 is milliseconds
const SYLT_MILLISECONDS = 2;

type NativeTag = { id: string; value: unknown };

function nativeValue(metadata: IAudioMetadata, id: string): string | undefined {
  for (const tags of Object.values(metadata.native) as NativeTag[][]) {
    const found = tags.find(tag => tag.id === id);
    if (found && typeof found.value === 'string' && found.value.trim()) return found.value.trim();
  }
  return undefined;
}

export function storedLyrics(tag: ILyricsTag): StoredLyrics | null {
  if (tag.syncText?.length) {
    if (tag.timeStampFormat !== SYLT_MILLISECONDS) return null;
    const lines: LyricLine[] = tag.syncText
      .filter(item => typeof item.timestamp === 'number' && item.text.trim())
      .map(item => ({ time: item.timestamp as number, text: item.text.trim() }));
    return lines.length ? { frame: 'SYLT', synced: true, text: '', lines } : null;
  }
  if (tag.text?.trim()) return { frame: 'USLT', synced: false, text: tag.text, lines: [] };
  return null;
}

export function fromMetadata(metadata: IAudioMetadata): FileTags {
  const { common, format } = metadata;
  const spotifyDuration = Number(nativeValue(metadata, 'TXXX:sp_duration_ms'));
  return {
    ...(common.artist ? { artist: common.artist } : {}),
    ...(common.title ? { title: common.title } : {}),
    ...(common.album ? { album: common.album } : {}),
    ...(format.duration ? { durationMs: Math.round(format.duration * 1000) } : {}),
    ...(common.isrc?.[0] ?? nativeValue(metadata, 'TXXX:sp_isrc') ? { isrc: common.isrc?.[0] ?? nativeValue(metadata, 'TXXX:sp_isrc') } : {}),
    ...(nativeValue(metadata, 'TXXX:sp_track_id') ? { spotifyId: nativeValue(metadata, 'TXXX:sp_track_id') } : {}),
    ...(Number.isFinite(spotifyDuration) && spotifyDuration > 0 ? { spotifyDurationMs: spotifyDuration } : {}),
    lyrics: (common.lyrics ?? []).map(storedLyrics).filter((item): item is StoredLyrics => item !== null)
  };
}

export const musicMetadataReader: TagReader = {
  async read(file: string): Promise<FileTags> {
    // duration: true measures the audio when the header does not state it (common for VBR mp3s)
    return fromMetadata(await parseFile(file, { duration: true, skipCovers: true }));
  }
};
