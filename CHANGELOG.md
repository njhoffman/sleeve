# Changelog

All notable changes to sleeve are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.39.3] - 2026-11-05

### Changed

- Notes on running under backdrop: since backdrop 2.50.7 it no longer resizes a `--managed` window, now that sleeve sizes it exactly (`docs/backdrop.md`).

## [0.39.2] - 2026-11-05

### Fixed

- An overlay or `--managed` window the size of a monitor is exactly that size, not 1 px short each way, which left a line of wallpaper at the right and bottom under an opaque or veiled background.

## [0.39.1] - 2026-11-05

### Changed

- Notes on running under backdrop: since backdrop 2.50.1 it resizes a `--managed` window after finding it, and its `background: auto` changes the background on most new wallpapers (`docs/backdrop.md`).

## [0.39.0] - 2026-11-04

### Added

- Say the lyrics shown are wrong or mistimed: the `x` and `t` keys, the pick panel's buttons, `sleeve ctl wrong` and
  `sleeve ctl mistimed`, and the `report` command. Wrong lyrics are never shown for that track again and the next best
  shows, or nothing when none is left, without marking the track. For mistimed lyrics other timing is tried, else the
  words stay up without times. The same lyrics are caught from any provider, including the copy in the file.
- `sleeve reports` lists what you reported. Picking those lyrics, `sleeve ctl unreport` or `sleeve reports --reset` takes
  it back.
- `sleeve tag --fix-reported` replaces reported lyrics in the files that hold them, when something else fits. A usual
  `sleeve tag` run leaves a file's lyrics alone, reported or not, and never writes reported ones.

## [0.38.0] - 2026-11-04

### Added

- `--lyrics-fade-top` and `--lyrics-fade-bottom` in `~/.config/sleeve/style.css` set how quickly the lyrics fade out from the center
  toward the top and bottom, and `--lyrics-clear-top` and `--lyrics-clear-bottom` the empty strips past that. The defaults are the
  fade as it was.

## [0.37.0] - 2026-11-04

### Added

- `just bench-gpu` measures what each background costs the GPU in the real shell, with its own placeholder track, so it needs no
  music. Results stay in `benchmarks/gpu.jsonl`, with the first measurements in it, and it shows the average of every run.

## [0.36.0] - 2026-11-04

### Added

- `sleeve shell --managed --map-below` maps the window at the bottom of the stack, so a program placing a whole-monitor window
  does not have it cover everything first.

## [0.35.0] - 2026-11-04

### Added

- `--background` sets what fills the window: `transparent`, `#rrggbb`, `#rrggbbaa`, `cover` or `cover@0.6`, on `sleeve shell`,
  `sleeve ctl display`, `?background=` and in `~/.config/sleeve/style.css`. The alpha is the background's alone, so text stays
  solid, and text colors follow what it stands on. `cover` is the same blurred cover a window shows, moving background included.

### Changed

- `sleeve ctl display --hide` hides the lyrics and the panel but keeps the background, which goes on moving.

## [0.34.0] - 2026-11-04

### Added

- `--lyrics-area` and `--now-area` (`WxH+X+Y`, in pixels or percent of the window) put the lyrics and the now-playing panel
  in part of the window, on `sleeve shell`, `sleeve ctl display` and in `~/.config/sleeve/style.css`. Text wraps and sizes
  to its area, so sleeve can cover a monitor with the lyrics in its left third.

## [0.33.0] - 2026-11-04

### Added

- `sleeve shell` opens the Electron window from anywhere, with `--now`, `--now-position` and `--lyrics-align` for its look.
- `sleeve shell --managed` opens it for a program that places it: at the geometry and with the title given, and it stacks and
  marks nothing. It takes wallpaper colors on stdin. This is sleeve's side of running as a backdrop visualizer engine; the
  contract is in backdrop's `docs/specs/sleeve.md`.
- `sleeve ctl display` changes how a page looks without a reload (`--preset`, `--position`, `--align`, `--hide`, `--show`,
  `--reset`), for one `--instance` or every page, through a new `display` protocol command (an addition; the protocol
  version stays 1).

## [0.32.0] - 2026-11-04

### Added

- Now-playing presets: `lyrics` (nothing else), `minimal` (a line with artist and title) and `full` (cover, title, artist,
  album, a clickable seek bar and the times), from `--now-preset` in `~/.config/sleeve/style.css` or `?now=` in the URL.
  The overlay still shows only lyrics and a window one line unless you choose otherwise.
- `--now-position` puts the panel at any of eight places, and the lyrics keep clear of it. `--lyrics-align` sets the
  lyrics left, center or right; `--now-scale` and `--now-margin` set the panel's size and distance from the edge.

### Fixed

- The title stays readable over a bright cover, using the text colors already worked out for it.

## [0.31.0] - 2026-11-04

### Added

- `sleeve line --between <text>` prints that text instead of an empty line while the track has synced lyrics but no
  line is playing, so a status bar can tell a gap from having no lyrics.

## [0.30.1] - 2026-11-04

### Fixed

- With `sleeve-art-flow`, a track with a cover coming after one without no longer fades in from the older cover.

## [0.30.0] - 2026-11-04

### Added

- `--art-animation: sleeve-art-flow`: the cover behind the lyrics warps slowly, drawn by WebGL at a quarter of the
  window's size. `--flow-speed`, `--flow-amount`, `--flow-detail`, `--flow-zoom`, `--flow-resolution` and `--flow-fps`
  set it from `~/.config/sleeve/style.css`, and it glides to new values rather than restarting.

### Changed

- Edits to `~/.config/sleeve/style.css` now apply to an open page within a few seconds, without a reload.

## [0.29.2] - 2026-11-04

### Changed

- sleeve is now licensed under MPL-2.0 (see `LICENSE`).
- `src/cli/index.ts` is executable, so it can be linked onto your PATH as `sleeve`.

## [0.29.1] - 2026-11-04

### Fixed

- A client subscribed to lines, such as `sleeve line`, could miss a line that came due at the moment sleeved was
  sending the one before it, and a track's last line until the next change in playback.

## [0.29.0] - 2026-11-03

### Added

- sleeve sends LRCLIB an application id when `~/.config/sleeve/lrclib-app-id` holds one, for the higher rate limit of
  a registered client-side application. Without the file nothing changes.

## [0.28.0] - 2026-11-03

### Added

- A click on a line in the window plays from that line, with the track's offset applied, in MPD or Spotify. A new
  `seek` protocol command does the same for any client (an addition; the protocol version stays 1).

## [0.27.0] - 2026-11-03

### Added

- `sleeve line` prints the line playing each time it changes, for status bars such as polybar and i3blocks, so they
  no longer need socat and jq. An empty line stands for no line. It waits for sleeved and comes back to it when it
  restarts.

## [0.26.0] - 2026-11-03

### Added

- `sleeve tag --recheck-fallbacks` asks LRCLIB again about the files written from NetEase after LRCLIB failed for a
  day, and with `--write` replaces their lyrics when LRCLIB's fit the file. Lyrics changed since, and tracks picked
  or marked since, are left alone. Files written that way are recorded from this version on.

## [0.25.0] - 2026-11-03

### Added

- Mark a track as having no correct lyrics, or as instrumental, so nothing shows for it instead of the ranking's
  wrong choice: `sleeve pick --none` or `--instrumental`, `sleeve ctl mark none` or `instrumental`, or `n` and `i` in
  the renderer's pick panel. No provider is asked, the file's own lyrics included. `sleeve tag` never writes a marked
  track, and says so when its file still has lyrics, which stay there. A pick replaces a mark; `sleeve pick --reset`
  and `sleeve ctl unpick` forget it.

## [0.24.0] - 2026-11-03

### Added

- Spotify's next track is looked up ahead, as MPD's is, so its lyrics are ready when it starts. sleeve asks
  musicman for Spotify's queue (`musicman spotify queue --format json`, which needs musicman's Spotify login)
  once per track; without it nothing changes.

## [0.23.0] - 2026-11-03

### Added

- The track's cover lies behind the lyrics in a browser and in window mode, blurred and dimmed, with the text
  colored for it. It comes from the player (Spotify's cover), the file's own picture, or a cover image beside it.
- `~/.config/sleeve/style.css` is loaded after sleeve's own stylesheet: every setting of the cover is a CSS
  variable there, including an optional slow animation (`--art-animation: sleeve-art-drift`) and its duration,
  timing, delay, iteration and direction. `?background=none` turns the cover off for one page.

## [0.22.0] - 2026-11-03

### Added

- `just install-shell-service` starts the overlay with every graphical session, as the systemd user unit
  `sleeve-shell`, after sleeved.
- `just shell --wait-backdrop SECONDS` waits that long for backdrop to come up before stacking the overlay itself;
  the unit waits 20 seconds, since i3 may start backdrop after it.

## [0.21.0] - 2026-11-03

### Added

- In a browser or window mode, the wheel scrolls back through the lyrics, which return to the current line a few
  seconds after the last turn, and a click picks a candidate in the pick panel.

## [0.20.0] - 2026-11-03

### Added

- `sleeve now` fills the current line word by word in a terminal, the words still to come dim, for lyrics with
  word times; `--estimate-words` times every line by word length. Piped output and `NO_COLOR` are unchanged.

## [0.19.1] - 2026-11-03

### Changed

- `just install-service` writes a unit that finds `node` at each start (`/usr/bin/env node`), so upgrading Node
  or switching Node managers no longer breaks sleeved; run it again once to get the new unit.
- `just shell-sandbox` installs a profile for any sleeve checkout's Electron under your home, so moving the
  checkout or reinstalling Electron no longer needs it again; run it once more to replace the old profile.
- `just shell` says how to fix a blocked sandbox instead of Electron aborting with a `chrome-sandbox` trace.

## [0.19.0] - 2026-11-03

### Changed

- Lyrics are shown and written in Latin script only. Lines in another alphabet are dropped (NetEase's uploader
  credits, album notes and translated titles in Chinese), look-alike Cyrillic and Greek letters inside Latin
  words are made Latin, and lyrics mostly in another alphabet, or a track named in one, are left out as not
  found. This applies to stored answers and picks too.
- A lookup without a duration (`sleeve lyrics -a ARTIST -t TITLE`) ranks first the lyrics for the length most
  candidates share, so the album version comes before live ones; other lengths are still offered.

## [0.18.0] - 2026-11-03

### Added

- The overlay works without backdrop: when a compositor runs, sleeve stacks it itself at the bottom, just above
  the wallpaper, or with `--position above` over every window (click-through, menus and notifications still on
  top). Before, it opened as a window whenever backdrop was not running.
- `just shell --stack auto|backdrop|self` chooses who stacks the overlay.

### Changed

- Window mode is borderless, and every sleeve window has the class `sleeve` for window manager rules.

## [0.17.0] - 2026-11-03

### Changed

- `sleeve tag` no longer waits forever for a provider that keeps failing. A file whose lyrics (or instrumental)
  a later provider has, held while an earlier one fails, takes the later provider's answer once it was first
  deferred a day ago and has been tried three times; the report says "lrclib failing since ...". Before, a file
  LRCLIB kept refusing stayed deferred however long NetEase had its lyrics.
- sleeve.db is upgraded to schema 5 (when each file was first deferred). Files deferred before the upgrade count
  from the upgrade.

## [0.16.2] - 2026-11-03

### Fixed

- A lookup made while LRCLIB's `Retry-After` holds requests back waits for the hold to end when that is at most
  5 seconds away, instead of failing at once. LRCLIB's 503s ask for a second, and in a library run every file
  looked up during that second was deferred for an hour without LRCLIB being asked: two thirds of the deferrals.
  Longer holds (a 429's) still fail at once and are asked again later.

## [0.16.1] - 2026-11-02

### Fixed

- `sleeve tag` keeps to LRCLIB's rate limit (about 90 requests a minute from one IP): its requests go one at a
  time, at least 700 ms apart, whatever `--delay` and `--jobs` say. Before, a library run sent up to 200 a minute
  and LRCLIB turned every lookup away ("429 Too many requests") until it slowed down.
- sleeve honors LRCLIB's `Retry-After`: after a 429 or 503 that says how long to wait, nothing is sent to LRCLIB
  until it has run out (with up to 30% jitter), by sleeved and `sleeve tag` alike, and a retry waits at least that
  long. Before, sleeve retried after a second whatever LRCLIB asked, which its docs say may get a client banned.

## [0.16.0] - 2026-11-02

### Changed

- Another version of a song no longer matches: titles must agree on what their suffix calls them (remix, live,
  acoustic, stripped, edit, demo and the like), so a remix does not get the original's lyrics. This applies
  everywhere lyrics are found, the overlay included.
- `sleeve tag` writes only lyrics that fit the file: within about 4 seconds of its length, the last line between
  15% and 105% of the way through. Others are reported `doubtful` and left out, and the next candidate that
  fits is taken. Your picks are written as they are.
- `sleeve tag` waits for providers in order: while LRCLIB fails for a file, NetEase's lyrics for it are held and
  the file is deferred, so an overloaded LRCLIB does not leave the library with NetEase's lyrics.

### Fixed

- NetEase's stand-in for instrumentals ("纯音乐，请欣赏", pure music, please enjoy) counts as an instrumental, not
  as one line of lyrics: `sleeve tag` leaves those files alone, and the overlay shows nothing for them.
- `sleeve tag` on a directory leaves hidden directories out, among them musicman's trash and downloads under
  the library's `.musicman`.

## [0.15.0] - 2026-11-02

### Changed

- `sleeve tag` is about three times faster: two files are looked up at once (`-j, --jobs`), `--delay` is now the
  least time between two requests to one service (300 ms) instead of a pause after every file, and LRCLIB is not
  asked a second time within a lookup when it is overloaded (it stays so for minutes; the file is deferred to a
  later run instead). Lyrics shown by `sleeve now` and sleeved still retry as before.

## [0.14.0] - 2026-11-02

### Added

- `sleeve tag PATH...` writes synced lyrics into mp3 files' `USLT` frame as LRC text, with your offset applied:
  it only says what it would write until `--write`. Synced lyrics replace the plain lyrics beets writes and fill
  empty frames; LRC a file has already stays unless `--force`, `--unsynced` writes plain lyrics where nothing is.
  Only that frame changes (every other one stays byte for byte, as musicman's contract asks), through a temporary
  file, and never over a file that changed meanwhile. Files a provider failed for are asked about again on later
  runs, after 10 minutes, then 1, 6 and 24 hours; `--delay`, `--limit`, `--retry-now` and `-v` tune a run.
  The database is upgraded in place (schema 4).

## [0.13.0] - 2026-11-02

### Added

- When LRCLIB (or another online provider) fails, as it often does under load, sleeved asks it again while the
  track plays: after 20 seconds, then 1, 3 and 10 minutes. Better lyrics that turn up replace the ones shown in
  the first fifth of the track, or at any time when nothing synced is shown; later they wait for the next play,
  already stored.

### Changed

- The lyrics show as soon as one provider has them, instead of waiting on the slowest: an overloaded LRCLIB no
  longer holds NetEase's lyrics back for several seconds.
- LRCLIB is retried once within a lookup, after a second, instead of twice over four and a half seconds.

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
