# Changelog

All notable changes to sleeve are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-11-02

### Added

- Answers from online providers, with or without lyrics, are stored in `$XDG_DATA_HOME/sleeve/sleeve.db` and
  reused instead of asking again (180 days for lyrics, 7 days for none); `--no-cache` and `--refresh` on
  `sleeve lyrics` skip or renew them, and the stderr line says when lyrics came from the store.
- `sleeve cache` shows what is stored by provider (also `--json`); `sleeve cache clear` forgets answers, for
  one provider (`-p`) or only those without lyrics (`--not-found`).

## [0.1.0] - 2026-11-02

### Added

- `sleeve lyrics [file]`: the best lyrics for a local file (from its tags) or for `--artist` and `--title`,
  printed as LRC or plain text, with `--all` to list every candidate and its score, `--json` for scripts,
  `--providers` to pick sources and `--timeout` per provider.
- Lyrics from an `.lrc` next to the file, from the file's own `SYLT`/`USLT` tags, and from LRCLIB, each a
  fallback for the others; local synced lyrics are used without going online.
- Matching that compares normalized titles and artists, the album and the duration, and rejects wrong
  versions; synced lyrics are preferred among good matches.
- Reads the audio's measured duration, ISRC and musicman's Spotify fields (`TXXX:sp_*`) from mp3 tags.
- Project outline, roadmap (TODO.md), README and agent guidance.
