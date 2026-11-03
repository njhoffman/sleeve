# Changelog

All notable changes to sleeve are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.12.0] - 2026-11-02

### Added

- Word-by-word highlighting: in lyrics with word times, each word of the current line fills as it is sung, in the
  browser and in the overlay. `?words=estimate` on the page (`just shell --estimate-words`) fills lines without
  word times too, timed by the length of each word over the line.

### Fixed

- Enhanced LRC timed by syllable ("<00:10.00>Hel<00:10.20>lo") reads as "Hello", not "Hel lo", and text before a
  line's first word time is no longer dropped.

## [0.11.0] - 2026-11-02

### Added

- The overlay's lyrics follow the wallpaper behind them: light or dark text by contrast against the colors
  backdrop samples there, with a stronger shadow and less faded lines when no color reads well over all of
  it. A new wallpaper or a dim change restyles the text in place.

## [0.10.0] - 2026-11-02

### Added

- The lyrics overlay: `just shell-install` once, then `just shell` puts the renderer on the desktop, transparent
  and click-through, just above backdrop's wallpaper and under its visualizer (`--position above` for over
  it), in a band from 15% of the monitor down to the visualizer (`--geometry`, `--monitor` to change it).
  backdrop stacks it again whenever its daemon restarts. Without backdrop running it opens as a window.
  `just shell --window` opens a plain window that remembers where it was.
- `sleeve ctl nudge|offset|pick|unpick|refresh|candidates`: one command to the running sleeved, for i3
  bindings (`bindsym $mod+equal exec sleeve ctl nudge +100`) and scripts.
- The renderer shows a short note whenever the offset changes, from any client.
- `just shell-sandbox` installs the AppArmor profile Electron's sandbox needs on Ubuntu (sudo).

## [0.9.0] - 2026-11-02

### Changed

- Stored answers, picks and offsets belong to a recording by its ISRC or Spotify id when the track has one,
  before its names and length. A pick or offset made while MPD plays a file applies when Spotify plays the
  same recording under another name, and recordings that share a name but not an ISRC are kept apart.
  What was stored before picks up the IDs of the first track that matches it by name. The database is
  upgraded in place (schema 3).

### Added

- The MusicBrainz recording id is read from a file's tags into the query (`sleeve lyrics --json` shows it),
  for providers that will look tracks up by it.

## [0.8.0] - 2026-11-02

### Added

- Lyrics for the song MPD plays next are looked up while the current one plays, so they show the moment it
  starts, LRCLIB's "server busy" retries included. It follows queue edits and random mode, and works with
  `--no-cache` too. `--no-prefetch` turns it off. Spotify has no queue to read over MPRIS, so its tracks are
  still looked up as they start.

## [0.7.0] - 2026-11-02

### Added

- The renderer: open `http://127.0.0.1:6620/` while sleeved runs for the lyrics of what plays, scrolling as
  each line comes due. Keys: `+`/`-` move the lyrics 100 ms (saved for the track), `0` removes the offset,
  `p` lists every provider's candidates to pick from (`1`-`9`, `u` back to the ranking), `r` looks the track
  up again online, `?` lists the keys. It reconnects by itself when sleeved restarts.
- sleeved serves the renderer from the sources, with no build step: TypeScript is turned into JavaScript on
  request.

## [0.6.0] - 2026-11-02

### Added

- `sleeved` (also `sleeve daemon`, `just daemon`): follows MPD and Spotify and serves what plays, with its
  lyrics, to any number of displays over a WebSocket (`ws://127.0.0.1:6620/ws`) and a Unix socket
  (`$XDG_RUNTIME_DIR/sleeve/sleeved.sock`, one JSON message per line). Displays get the lyrics once per change
  and the playback clock as it changes, and can nudge, set the offset, list candidates, pick, unpick and
  refresh. Scripts and status bars can subscribe to the current line instead. The messages are in
  `docs/protocol.md`.
- `sleeve now` shows sleeved's session when it runs, so a nudge in the terminal moves the lyrics in every
  display; `--no-daemon` (or any player, provider or store option) runs its own, `--daemon` insists on
  sleeved.
- `just install-service` writes a systemd user unit for sleeved; `just logs` follows its log.

### Changed

- `sleeve now --help` gives the defaults of `--mpris` (spotify) and `--timeout` (10 s) in the descriptions.

## [0.5.0] - 2026-11-02

### Added

- `sleeve now` follows MPD and Spotify and prints the lyrics of what plays, line by line as they come due;
  `+` and `-` move them 100 ms and save it for the track, `q` quits. `--once` prints the track, where it is
  and the current line (`--json` for scripts and status bars).
- MPD is read directly (exact position, changes as they happen, reconnecting when MPD restarts), at the
  address `--mpd`, `MPD_HOST`/`MPD_PORT` or musicman gives; the file it plays supplies its own lyrics and
  length. Spotify and other MPRIS players (`--mpris`) are read over D-Bus.
- With musicman 1.55.0 or later, a Spotify track that is in the library uses the library file's lyrics and
  tags when the lengths agree.
- A `justfile`: `just check`, `just test-file`, `just now`, `just tag` and more.

### Fixed

- Running one test file (now `just test-file FILE`) no longer runs every test file as well.

## [0.4.0] - 2026-11-02

### Added

- `sleeve pick [file] <candidate>` shows the lyrics you choose for a track from then on, by number from
  `sleeve lyrics --all` or by `provider:id`, even ones scored under the threshold; `--reset` hands the choice
  back to the ranking. A pick needs no lookups, keeps working after the provider drops the lyrics, and
  rereads local `.lrc` files so edits show.
- `sleeve offset [file] [ms]` shifts a track's lyrics later (positive) or sooner (negative) and remembers it
  for those lyrics; without a value it shows the offset, `0` or `--reset` removes it.
- `sleeve lyrics --all` numbers candidates and shows each one's `provider:id`; stderr and `--json` say when
  lyrics are pinned or offset; `--no-prefs` ignores picks and offsets.

### Changed

- `sleeve.db` moves to schema 2 (a table for picks and offsets) the first time this version opens it;
  stored answers are kept. Older versions of sleeve refuse the upgraded database.

## [0.3.0] - 2026-11-02

### Added

- NetEase Cloud Music as a lyrics source after LRCLIB (`-p netease`), covering many of LRCLIB's misses and
  "server busy" answers. Its search results are scored before lyrics are fetched, so live versions and covers
  are skipped, and credit lines at the top of its lyrics are dropped.

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
