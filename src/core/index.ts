// The lyrics core: everything the CLI, and later the daemon, use.
export { fetchLyrics, queryForFile, DEFAULT_PROVIDERS, DEFAULT_TIMEOUT_MS, USER_AGENT } from './fetchLyrics.ts';
export type { FetchOptions } from './fetchLyrics.ts';
export { parseLrc, formatLrc, plainText, looksLikeLrc } from './lrc.ts';
export { scoreCandidate, rankCandidates, normalizeTitle, normalizeArtist, similarity, durationScore, THRESHOLD } from './match.ts';
export { lrclib, createLrclib } from './providers/lrclib.ts';
export { sidecar, embedded, sidecarPath } from './providers/local.ts';
export type { Provider, ProviderContext } from './providers/provider.ts';
export type { TagReader, FileTags, StoredLyrics } from './tags/reader.ts';
export { musicMetadataReader } from './tags/musicMetadata.ts';
export type * from './types.ts';
