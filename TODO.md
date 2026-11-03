# TODO

Roadmap and open issues for sleeve, a synced-lyrics fetcher and viewer that starts over from Sunamu
(`~/git/Sunamu`, the working fork) and lyricist. Items that depend on the stack wait until it is decided.

Reviewed: 2026-11-02

## 1. Planning

- [x] **Decide the stack.** (p1) [chore] Decided 2026-11-02: TypeScript run directly by Node 24 (no backend build
      step), a headless daemon (`sleeved`) with one WebSocket protocol, a web renderer, Electron only as a
      thin shell for window and overlay modes, a CLI over the core library, mocha + chai + sinon.
- [x] **Decide the backdrop integration boundary.** (p1) [chore] Decided 2026-11-02: backdrop places the overlay
      when it runs; without backdrop, sleeve stacks its own overlay; in window mode backdrop is not involved.
- [x] **Decide which Sunamu features to drop.** (p2) [chore] Decided 2026-11-02: drop Discord RPC, Last.fm play
      counts, Spotify links, track logging, i18n and Windows support.
- [ ] **Decide on OBS mode.** (p3) [chore] In Sunamu it is only a preset scene picked when `window.obsstudio`
      exists (widget, non-interactive, no lyrics). With scenes selectable by URL it costs nothing to keep.
- [x] **Salvage the uncommitted fork work.** (p2) [chore] `~/git/Sunamu` (origin njhoffman/lyricist) has 24 modified files
      (leveled logger, MPRIS fixes, provider logging) that are not committed or pushed; `~/git/lyricist`
      is a stale clone with only lockfile changes. Commit or stash them before they are lost, so they
      can be read for reference.
- [x] **Decide the musicman integration.** (p2) [chore] `~/git/musicman` (v1.51.0, plain JS, pnpm workspace)
      already detects the active player across MPD and Spotify (`musicman status --format json`,
      `common/mpd/`), keeps a SQLite library and writes ID3 tags, including custom fields synced
      with Spotify playlists. Overlaps sleeve's player layer and tag writing. Decide whether sleeve
      reads now-playing from musicman (or shares `common/mpd`) and writes lyrics through musicman's tag
      writer, so two programs never rewrite the same files' ID3 tags independently.
      Decided 2026-11-02 for players (0.5.0): sleeve reads MPD and MPRIS itself, since lyrics need exact,
      immediate position and musicman's adapters are one-shot reads; musicman shares a contract
      (its docs/09-contract.md, 1.55.0): `paths.json` (MPD and the database) and the `spotify_track_files` view,
      so Spotify tracks get their library file. Tag writing is still open (see Batch-write lyrics).
      Tag writing settled 2026-11-02 in the contract's "Lyrics in the library's tags" (musicman, unreleased):
      sleeve writes `USLT`/`SYLT` itself, not through musicman, and musicman's node-id3 rewrites carry both over.
- [ ] **Check license obligations.** (p3) [docs] Sunamu is MPL-2.0: any file copied or closely ported from it
      (LRC parser, Musixmatch client) stays MPL-2.0 with its notice. Pick sleeve's license with that in mind.

## 2. Plan gaps (address later)

Design questions raised in the stack review of 2026-11-02. Each is a decision to settle before the
build items that depend on it, listed in the later projects.

- [x] **Overlay text contrast against the wallpaper.** (p2) [chore] In overlay mode the lyrics sit on backdrop's
      wallpaper, not the cover. Source settled: backdrop 2.41.0 writes `{ background, main }` per overlay
      into `state.json` (average shown after dim, main colors with shares), rewritten on loads and dim
      changes; it covers the whole overlay window, so ask for a sub-region later if that is too coarse.
      Still open: which contrast measure (APCA or WCAG 2) and the fallback (shadow, outline).
      Done in 0.11.0: WCAG 2 against every color covering 10% or more; the shadow (opposite color) and the
      dim lines' opacity grow as contrast falls. The shell passes the colors to its page (`preload.cjs`).
- [x] **Window stacking ownership.** (p2) [chore] Settled 2026-11-02 with backdrop 2.41.0: sleeve marks its overlay
      window `_BACKDROP_OVERLAY` = `below` or `above` (per overlay, changeable at runtime) and runs
      `backdrop restack` when the window maps, when the mark changes, and when backdrop's daemon pid in
      `state.json` changes. backdrop detected = a live `state.json`; otherwise sleeve stacks itself.
      Contract: Overlays in `~/git/backdrop/docs/specs/visualizer.md`.
- [ ] **Seamless, cheap background animation.** (p2) [chore] CSS keyframes restart when edited and the
      `blur(180px)` layers cost GPU all day. Prototype a WebGL shader on a downscaled cover with
      parameters interpolated over the socket, and compare its GPU use against Sunamu's CSS.
- [ ] **Weak lyrics sources and first-hit selection.** (p2) [chore] Musixmatch's token is unofficial, NetEase
      mismatches, Genius has no timing, LRCLIB is missing, and Sunamu takes the first synced hit.
      Settle the scoring rules and provider order before porting providers.
- [x] **MPD protocol versus MPRIS.** (p2) [chore] MPD gives idle events, exact elapsed time and the file path
      (needed for sidecar LRC, embedded lyrics, tag IDs and cover art). Confirm MPD direct as the primary
      player and MPRIS for Spotify and the rest.
      Confirmed in 0.5.0: MPD directly, MPRIS for Spotify (any other player by name); mpd's MPRIS bridge and
      playerctld are refused so MPD is not seen twice.
- [ ] **ID3 lyrics frame: USLT or SYLT.** (p2) [chore] USLT with LRC text is read by most players but is
      officially unsynced; SYLT is synced but poorly supported. Proposed default: USLT with LRC text,
      SYLT as an option. Check what mpd, ncmpcpp and the phone player read.
- [ ] **MPL-2.0 obligations from Sunamu.** (p3) [docs] Files ported closely from Sunamu stay MPL-2.0 with their
      notice. Decide sleeve's license and mark ported files.

## 3. Lyrics fetching

- [x] **Provider interface and lyrics model.** (p1) [feature] One model for lines, optional word timings
      (enhanced LRC), translations, provider, and a match score; providers return candidates, not one result.
      Done in 0.1.0: `src/core/types.ts`, `Provider` in `src/core/providers/provider.ts`.
- [x] **LRCLIB provider.** (p1) [feature] lrclib.net is free, open, keyless and returns synced LRC with
      duration matching; Sunamu lacks it. Make it the first provider.
      Done in 0.1.0: `/api/get` with the duration, `/api/search` as fallback, retries on 503/429.
- [x] **Candidate matching by duration and fuzzy title/artist.** (p1) [feature] Sunamu takes the first synced
      result from the provider order, which picks wrong songs. Score candidates (duration within ~2 s,
      normalized title without "remaster"/"feat." noise) and keep the alternatives.
      Done in 0.1.0: `src/core/match.ts` (bigram similarity, duration window, vetoes, threshold 0.6).
- [x] **Local sources: sidecar LRC and embedded tags.** (p1) [feature] Read `.lrc` next to the file and USLT/SYLT
      from ID3; needs the real file path, which MPD gives and MPRIS often does not.
      Done in 0.1.0: `sidecar` and `embedded` providers, through the `TagReader` adapter.
- [x] **Fallback chain across all providers.** (p1) [feature] Decided 2026-11-02: use every available source,
      each a fallback for the others. Query in parallel with a per-provider timeout, rank candidates
      by score (synced beats unsynced), and isolate failures so one dead provider never blocks the rest.
      Done in 0.1.0 for sidecar, embedded and LRCLIB: `src/core/fetchLyrics.ts`; more providers plug in.
- [ ] **LRCLIB is overloaded for uncached lookups.** (p2) [bug] In a 10-file sample of the library on 2026-11-02,
      2 lookups failed with 503 "ServerOverloaded" after both retries; cached ones answer at once. Misses are
      what other providers and the cache are for: port Musixmatch/NetEase next, cache found and not-found
      results, and in batch tagging back off and retry later instead of failing the file.
      Mitigated in 0.2.0 (cache) and 0.3.0 (NetEase covers the misses); still open for batch tagging.
      Sampled again 2026-11-02: 8 of 12 uncached `/api/get` answered 503; some recover within seconds, some
      stay 503 for minutes on `/api/search` too (1 of 3 back after two minutes). Done in 0.13.0 for playback:
      the lookup shows the first provider's answer (`onPartial`), retries LRCLIB once, and sleeved asks failed
      providers again after 20 s, 1, 3 and 10 min (`takeLater` in `src/now/session.ts` decides whether the
      answer replaces what is shown). Left for batch tagging: a persisted retry queue in `sleeve.db` (track,
      provider, next attempt) with a shared rate limit, so a run skips and comes back instead of failing files.
- [ ] **A source of word timings.** (p2) [feature] Word-by-word highlight (0.12.0) needs `words`, and almost no
      lyrics have them: on 2026-11-02 none of the 27 cached answers did, nor any of 160 LRCLIB synced records for
      8 popular tracks (no enhanced LRC tags, `hasWordSync` false on all). Today only a word-timed `.lrc`
      sidecar gives them; the rest falls back to `?words=estimate`. Candidates, best first:
      (1) LRCLIB's `lyricsfile` (below): free and allowed, but the data is rare for now; re-sample later.
      (2) Musixmatch's official API, `track.richsync.get`: word timing by ISRC or Spotify id, the best data, but
      richsync and full synced lyrics are commercial plans only, priced on request (no public price; the free
      plan returns about 30% of a lyric, by third-party accounts, unverified). Ask Musixmatch for a quote for
      personal, non-commercial use before anything else (see Look into Musixmatch again).
      (3) NetEase `yrc` (word-by-word, `[start,dur](wordStart,wordDur,0)word`, centiseconds): the public
      `/api/song/lyric` and `/v1` return `lrc`, `tlyric` and an empty `klyric`, no `yrc`; community
      clients get it from the encrypted eapi/weapi endpoints, imitating the app, which is out as for Musixmatch.
      NetEase has an official open platform (developer.music.163.com: app id and private key, lyrics among its
      APIs), but whether it returns `yrc`, costs anything, or takes developers outside mainland China is
      unknown; its docs and sign-up are in Chinese and want a registered developer. Worth one look.
      (4) Alignment: time the words ourselves from the audio (forced alignment of known lyrics, e.g. a
      Whisper-based aligner, after vocal separation) for local files, stored as a sidecar. Heavy, offline only,
      but works for the whole library; fits the planned batch tagging.
- [ ] **Word timing from LRCLIB's lyricsfile.** (p3) [feature] LRCLIB records now carry `hasWordSync` and a
      `lyricsfile` (YAML: lines with `start_ms`/`end_ms`, words when word-synced). Parse it when
      `hasWordSync` is true for karaoke timing; needs a YAML parser and a recorded word-synced fixture.
      Sampled 2026-11-02: no word-synced record among 160, so wait until some exist to record a fixture.
- [ ] **Queries without a duration cannot tell versions apart.** (p3) [feature] `sleeve lyrics -a -t` without `-d`
      scores live and album versions alike (all 1.0 for "Everything In Its Right Place"). Prefer the record
      whose album matches, or the most common duration among candidates, when no duration is given.
- [x] **Port the NetEase provider.** (p1) [feature] Decided 2026-11-02: NetEase next, to cover LRCLIB's misses.
      Done in 0.3.0: `src/core/providers/netease.ts`; search results scored before fetching the
      best two lyrics, credit lines dropped. A 10-file library sample found synced lyrics for all 10, NetEase
      covering the 3 LRCLIB "server busy" answers.
- [ ] **Port the Genius provider.** (p3) [feature] Unsynced lyrics only, as the last fallback; Sunamu scrapes its
      pages (`src/main/lyricproviders/genius.ts` there). Check whether its API gives lyrics without scraping.
- [ ] **NetEase translations.** (p3) [feature] NetEase returns a translation (`tlyric`, Chinese) with the same
      timestamps; attach it as `LyricLine.translation` if translated lyrics become a display option.
- [ ] **Look into Musixmatch again.** (p3) [feature] Wanted for word-level richsync and lookups by ISRC and
      Spotify id. Blocked 2026-11-02: `token.get` now gives anonymous clients a placeholder token of zeros,
      so Sunamu's approach no longer works, and getting past that by imitating the desktop app is out.
      Options: (1) the user's own token from their logged-in Musixmatch account, in a sleeve config file:
      keeps richsync and ID lookups, but still the unofficial API, against its terms, and the token can be
      revoked; (2) the official API with a developer key: allowed, but the free plan has no synced lyrics
      and full lyrics need a paid plan; (3) leave it out. Revisit after NetEase and the daemon.
      Checked 2026-11-02: richsync (`track.richsync.get`) is on the commercial plans only, priced by quote;
      developer.musixmatch.com could not be fetched to confirm the plans. Next step: ask them for a quote.
- [x] **Match by IDs from the file's tags.** (p2) [feature] Files carry `sp_track_id`, `sp_isrc`/`TSRC`,
      `sp_duration_ms` and MusicBrainz IDs (not every file yet). Read them via the MPD path and pass
      them to providers that accept IDs; use the duration for scoring. Exact IDs beat fuzzy text.
      Done in 0.9.0 as track identity: no provider takes IDs (LRCLIB and NetEase search by text), so the
      ISRC and Spotify id identify the track for stored answers, picks and offsets instead (schema 3), and
      the MusicBrainz recording id is read into the query. In a 60-file sample on 2026-11-02, 85% of files had
      ISRC and Spotify id, 75% a MusicBrainz recording id. Looking tracks up by ID waits on a provider that
      takes one (see Look into Musixmatch again).
- [x] **Lyrics cache in SQLite.** (p2) [feature] Replace Sunamu's file cache with `node:sqlite` (as backdrop does):
      track key, chosen candidate, alternatives, user offset, user-pinned flag.
      Done in 0.2.0: online answers found and not found in `$XDG_DATA_HOME/sleeve/sleeve.db`,
      `--no-cache`, `--refresh`, `sleeve cache [clear]`. The pick and offset parts moved to the next item.
- [x] **Per-track timing offset and manual pick.** (p2) [feature] Let the user nudge sync and choose another
      candidate, and remember both. Store them in `sleeve.db` (schema 2) next to the cached answers.
      Done in 0.4.0: `sleeve pick`, `sleeve offset`, `TrackPrefs` (`src/core/prefs.ts`); offsets belong to
      the candidate they were set for and come back as `offsetMs` for the display to apply.
- [ ] **"No correct lyrics" pick.** (p3) [feature] A negative pick: the user marks a track as having no right
      lyrics anywhere (or as instrumental), so the display stays empty instead of showing the ranking's wrong
      choice. Left out of 0.4.0.
- [x] **Relative offset nudges for the daemon.** (p3) [feature] The display will nudge by steps (+/-100 ms);
      add `TrackPrefs.adjustOffset` (or a protocol message) when the daemon exists. `sleeve offset` sets
      absolute values only.
      Done in 0.5.0: `NowPlaying.nudge(deltaMs)`, bound to + and - in `sleeve now`; the daemon will expose it.
- [x] **Recorded HTTP fixtures for provider tests.** (p1) [test] Providers must be testable offline; record real
      responses once and replay them.
      Done in 0.1.0: `test/fixtures/lrclib/` replayed by `test/helpers/fetch.ts`.
- [x] **CLI: fetch lyrics for one track.** (p1) [feature] `sleeve lyrics --artist A --title T --duration S [--json]`
      as the first usable piece, before any player or UI.

      Done in 0.1.0: `sleeve lyrics [file]` with --artist/--title/--duration, --format, --all, --json, --providers.
## 4. Tag writing

- [ ] **Batch-write lyrics into ID3 tags.** (p2) [feature] `sleeve tag DIR [--missing-only] [--dry-run]` over the
      library (7338 mp3 files in `~/Music`). Decide USLT with LRC text (widely read) versus SYLT (proper
      but poorly supported), rate-limit provider calls, and never overwrite user lyrics without a flag.
      Must preserve musicman's custom ID3 fields; see the musicman integration item in Planning.
      Rules from musicman's contract (docs/09-contract.md, "Lyrics in the library's tags"): change `USLT` and
      `SYLT` only, byte for byte nothing else and not the tag version (so a frame-level writer of our own, not
      node-id3); exactly one `USLT`, replaced in place; a `USLT` with text only with `--force`; write through a
      temporary file renamed over the original, only if mtime and size are unchanged since the read; leave the
      new mtime. The library on 2026-11-02 (musicman's db, 7107 songs): 3957 have a `USLT`, 3878 of them empty
      (language `XXX`), 79 plain lyrics from beets' lyrics plugin, none LRC. `beet write`/`beet modify` would
      write beets' own lyrics back over ours; musicman never runs them.

## 5. Players

- [x] **Headless daemon over the session.** (p1) [feature] `sleeved`: `NowPlaying` (`src/now/session.ts`)
      behind the WebSocket protocol the renderer and Electron shell will use (state, current line, nudge,
      pick). Decide the protocol messages and how the daemon is started (systemd user unit like musicman's).
      Done in 0.6.0: `src/daemon/` (own RFC 6455 server on `node:http`, NDJSON Unix socket), protocol in
      `src/protocol/` and `docs/protocol.md`, `just install-service`; `sleeve now` is a client when it runs.
- [ ] **Unit's node path goes stale.** (p3) [chore] `just install-service` writes the absolute path of the
      `node` on PATH (pnpm's) into the unit, as musicman's does; a node upgrade or a moved checkout breaks
      the service until it is run again. A wrapper that finds node at start would avoid it.
- [ ] **`sleeve line` for status bars.** (p3) [feature] Print the current line each time it changes, from a
      `subscribe` on the daemon's socket, so polybar/i3blocks need no socat and jq (docs/protocol.md shows
      that pipeline today).
- [x] **Prefetch the next track's lyrics.** (p3) [perf] MPD's queue (`playlistinfo`) and Spotify's (no MPRIS
      queue; Web API only) could warm the cache, so lyrics are ready when a track starts. Lookups that wait
      on LRCLIB's "server busy" retries take several seconds today.
      Done in 0.8.0 for MPD: `nextsongid` and `playlistid` give the song queued next (random included), the
      session looks it up once the current track is settled and adopts the lookup when the track starts.
- [ ] **Prefetch for Spotify.** (p3) [perf] MPRIS has no queue. Spotify's Web API does (`/me/player/queue`),
      which needs an OAuth token; musicman manages Spotify and may have one. Any such data would have to be
      added to musicman's contract (`docs/09-contract.md`) first, not read from its tables.
- [x] **Native MPD client.** (p1) [feature] Use MPD's protocol directly (idle events, precise elapsed time, file
      path for local lyrics and cover art) instead of going through an MPRIS bridge.
      Done in 0.5.0: `src/players/mpd.ts` (`node:net`, `idle player`, reconnects with backoff, MPD_HOST forms).
- [x] **MPRIS client for Spotify and others.** (p2) [feature] Port Sunamu's `mpris2.ts`, with the fork's fixes;
      interpolate position between polls.
      Done in 0.5.0: `src/players/mpris.ts` on `@jellybrick/dbus-next` (Seeked, PropertiesChanged, a position
      read every 5 s while playing), written anew rather than ported.

## 6. Display

- [x] **Renderer as a web client of the daemon.** (p1) [refactor] One WebSocket protocol for both the browser and
      the Electron shell, dropping Sunamu's separate electron-npapi and browser-npapi paths.
      Done in 0.7.0: `src/renderer/` served by sleeved at `/`, types stripped on request (no build step);
      plain DOM, the line worked out per frame from the mirrored clock, scroll on a time-constant follow;
      keys for nudge, offset reset, pick, unpick and refresh.
- [x] **Electron shell over the renderer.** (p1) [feature] A thin window loading `http://127.0.0.1:6620/`:
      transparent, click-through and marked `_BACKDROP_OVERLAY` for overlay mode, plain for window mode (see
      Three window modes). No IPC: everything goes over the page's WebSocket, as in a browser. (Since 0.11.0
      one exception, one way: the wallpaper colors behind the overlay, which only the shell knows.)
      Done in 0.10.0: `shell/` (its own package, Electron 45, main process in TypeScript); the overlay is made
      override-redirect before it maps (`shell/x11.ts`), so i3 never manages it, and backdrop restacks it on
      map and on every daemon restart (watching `state.json`). `sleeve ctl` gives i3 bindings the keys.
- [ ] **Sandbox without a profile.** (p3) [chore] On Ubuntu 25.10 AppArmor blocks the user namespaces Chromium's
      sandbox needs, so the shell runs only after `just shell-sandbox` (a profile, sudo) or with
      `--no-sandbox`. The profile names the binary's path, so it breaks when the checkout moves; Ubuntu's
      own Electron apps ship one per app. Revisit if Electron or Ubuntu change this.
- [ ] **Start the overlay with the session.** (p3) [feature] Today it is `exec just -f .../justfile shell` in the i3
      config. A systemd user unit bound to graphical-session.target would restart it and order it after
      sleeved and backdrop.
- [x] **Word-by-word highlight.** (p2) [feature] Lines carry `words` (enhanced LRC, later LRCLIB's lyricsfile and
      Musixmatch richsync); the renderer shows whole lines only. Fill each word as it comes due, from the same
      per-frame position.
      Done in 0.12.0: `wordTimings` in `src/now/lines.ts`; each word of the current line is drawn twice, a
      full-color copy clipped to how much is sung, so the overlay's shadow stays whole. `?words=estimate`
      (`--estimate-words`) times lines without words by word length, capped at 250 ms a letter. Few lyrics
      have word times yet (see A source of word timings).
- [ ] **Word highlight in the terminal.** (p3) [feature] `sleeve now` shows whole lines; it could color the sung
      part of the current line with the same `wordTimings`.
- [ ] **Mouse in the renderer.** (p3) [feature] Click a candidate in the pick panel, scroll back through the
      lyrics by wheel (returning to the current line after a few seconds), click a line to seek (needs a seek
      command and player support).
- [ ] **Three window modes.** (p2) [feature] `overlay` under backdrop: backdrop places and stacks the window like a
      GLava instance. `overlay` without backdrop: sleeve stacks its own transparent, click-through,
      desktop-type window above the root. `window`: borderless, focusable, resizable, remembers its
      geometry; backdrop ignores it. Needs a way to detect backdrop (its daemon socket or `status --json`).
      0.10.0 has overlay under backdrop and window (detected by the live pid in backdrop's `state.json`).
      Without backdrop the overlay falls back to a window: i3 has no desktop layer, and an unmanaged window
      would need something to keep it at the bottom as backdrop does (a small restack of our own on map and
      on every new top-level window).
- [ ] **Album-art background without the GPU cost.** (p2) [perf] Sunamu rotates two 200vmax pseudo-elements with
      `blur(180px)` all the time (`Background.css`). Draw a downscaled cover in WebGL or canvas instead,
      where blur is nearly free.
- [ ] **Live, seamless animation parameters.** (p2) [feature] Changing CSS keyframes restarts the animation.
      Drive the animation from a clock with parameters pushed over the socket and interpolated, so edits
      from the config or a dev panel apply without a jump. The renderer's scroll already works this way
      (`follow` in `src/renderer/view.ts`); the line highlight is still a CSS transition.
- [ ] **Lyric colors by contrast against what is actually behind them.** (p2) [feature] Sunamu picks from the cover
      palette; in overlay mode the background is the wallpaper. Choose text color by APCA/WCAG contrast
      against the wallpaper region (from backdrop) or the cover, with a shadow as fallback.
      The overlay half is done in 0.11.0 (`src/renderer/contrast.ts`); the cover half waits on an album-art
      background in window mode (see Album-art background without the GPU cost).
- [ ] **Palette extraction without sharp.** (p3) [chore] Sunamu's sharp + node-vibrant needed a rebuild hack
      (`build:prepare:sharp`). Extract in the renderer from a canvas, or with ffmpeg as backdrop does.
