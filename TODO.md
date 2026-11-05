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
      Tag writing settled 2026-11-02 in the contract's "Lyrics in the library's tags" (musicman 1.55.1):
      sleeve writes `USLT`/`SYLT` itself, not through musicman, and musicman's node-id3 rewrites carry both over.
- [x] **Check license obligations.** (p3) [docs] Sunamu is MPL-2.0: any file copied or closely ported from it
      (LRC parser, Musixmatch client) stays MPL-2.0 with its notice. Pick sleeve's license with that in mind.
      Done 2026-11-04 in 0.29.2: MPL-2.0 for the whole project. Comparing every file with Sunamu's found at most
      2% of lines shared, all incidental, so no file needed its own notice.

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
- [x] **Seamless, cheap background animation.** (p2) [chore] CSS keyframes restart when edited and the
      `blur(180px)` layers cost GPU all day. Prototype a WebGL shader on a downscaled cover with
      parameters interpolated over the socket, and compare its GPU use against Sunamu's CSS.
      Measured 2026-11-04 on Iris Xe in Chrome, 1245x1205, render engine time of Chrome's GPU process from fdinfo, three
      16 s rounds each: no cover 1.2%, static cover (the default) 1.8%, `sleeve-art-drift` 9.3%, a WebGL warp of the
      64 px cover at quarter resolution and 30 fps 4.9%, the same at full resolution and frame rate 12.4%. The blur that
      prompted this item is Sunamu's; sleeve's default already costs next to nothing.
      Done in 0.30.0: `sleeve-art-flow`, the quarter-resolution warp, opt-in; the still cover stays the default.
- [ ] **Weak lyrics sources and first-hit selection.** (p2) [chore] Musixmatch's token is unofficial, NetEase
      mismatches, Genius has no timing, LRCLIB is missing, and Sunamu takes the first synced hit.
      Settle the scoring rules and provider order before porting providers.
- [x] **MPD protocol versus MPRIS.** (p2) [chore] MPD gives idle events, exact elapsed time and the file path
      (needed for sidecar LRC, embedded lyrics, tag IDs and cover art). Confirm MPD direct as the primary
      player and MPRIS for Spotify and the rest.
      Confirmed in 0.5.0: MPD directly, MPRIS for Spotify (any other player by name); mpd's MPRIS bridge and
      playerctld are refused so MPD is not seen twice.
- [x] **ID3 lyrics frame: USLT or SYLT.** (p2) [chore] USLT with LRC text is read by most players but is
      officially unsynced; SYLT is synced but poorly supported. Proposed default: USLT with LRC text,
      SYLT as an option. Check what mpd, ncmpcpp and the phone player read.
      Decided 2026-11-02: USLT with LRC text (0.14.0). MPD serves no lyrics and ncmpcpp fetches its own; the phone
      (Android) plays Spotify so far, not the library. SYLT stays a possible option (see Write SYLT too).
- [ ] **Write SYLT too.** (p3) [feature] `sleeve tag --sylt`: a SYLT frame next to the USLT, for players that read
      only synced frames. musicman's contract already allows it (node-id3 keeps several). Wait for a player that needs it.
- [x] **MPL-2.0 obligations from Sunamu.** (p3) [docs] Files ported closely from Sunamu stay MPL-2.0 with their
      notice. Decide sleeve's license and mark ported files.
      Done 2026-11-04 in 0.29.2, with the item above.

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
- [x] **LRCLIB is overloaded for uncached lookups.** (p2) [bug] In a 10-file sample of the library on 2026-11-02,
      2 lookups failed with 503 "ServerOverloaded" after both retries; cached ones answer at once. Misses are
      what other providers and the cache are for: port Musixmatch/NetEase next, cache found and not-found
      results, and in batch tagging back off and retry later instead of failing the file.
      Mitigated in 0.2.0 (cache) and 0.3.0 (NetEase covers the misses); batch tagging defers files (0.14.0).
      Sampled again 2026-11-02: 8 of 12 uncached `/api/get` answered 503; some recover within seconds, some
      stay 503 for minutes on `/api/search` too (1 of 3 back after two minutes). Done in 0.13.0 for playback:
      the lookup shows the first provider's answer (`onPartial`), retries LRCLIB once, and sleeved asks failed
      providers again after 20 s, 1, 3 and 10 min (`takeLater` in `src/now/session.ts` decides whether the
      answer replaces what is shown). Batch tagging (0.14.0) defers such files in `tag_retries` (path,
      attempts, next attempt) and spaces online lookups with `--delay`, so a run skips and comes back.
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
      Sampled 2026-11-02: no word-synced record among 160, and 2026-11-03: none among 100 for five popular tracks
      (all have a `lyricsfile`), and 2026-11-04: none among 400 for 20 tracks, popular and recent, with no `words:` in any
      `lyricsfile`, and none in the 12265 answers cached. Wait until some exist to record a fixture.
- [x] **Queries without a duration cannot tell versions apart.** (p3) [feature] `sleeve lyrics -a -t` without `-d`
      scores live and album versions alike (all 1.0 for "Everything In Its Right Place"). Prefer the record
      whose album matches, or the most common duration among candidates, when no duration is given.
      Done in 0.19.0: `typicalDuration` (match.ts), the length at least two passing candidates share with no
      rival as common; candidates are scored against it without the veto. The album already counts (weight 0.05).
- [x] **Port the NetEase provider.** (p1) [feature] Decided 2026-11-02: NetEase next, to cover LRCLIB's misses.
      Done in 0.3.0: `src/core/providers/netease.ts`; search results scored before fetching the
      best two lyrics, credit lines dropped. A 10-file library sample found synced lyrics for all 10, NetEase
      covering the 3 LRCLIB "server busy" answers.
- [ ] **Lyrics for harmonic.** (p3) [feature] harmonic (`~/git/harmonic`) is a visualizer driven by separated stems,
      and wants timed lyrics for its scenes. It has just started, and its real separation waits on AWS GPU quota (noted
      2026-11-04), so nothing here is decided. Ideas, to settle with it: sleeve as its source of lyrics, instead of its
      planned "import line-timed lyrics" and `lyric_tracks` fetching a second time (`sleeve lyrics FILE --json` may be
      most of it; its fields for source, timing granularity and offset match what sleeve knows, and picks, marks and
      offsets come along). Identity differs: harmonic knows a recording by checksums and a 48 kHz sample timeline, sleeve
      by artist, title and length, in milliseconds. In the other direction, aligning lyrics to its vocal stem could give
      the word timings no provider has (see "A source of word timings"); untried. A contract goes in writing first, as
      with musicman.
- [x] **Report lyrics as wrong or mistimed.** (p2) [feature] Tell sleeve the lyrics shown are not this song's, or are
      timed wrong, so it stops showing them and tries the next best. Only for this track, kept until taken back.
      Done in 0.39.0: `src/core/reports.ts`, schema 8; the `x` and `t` keys and the pick panel, `sleeve ctl wrong`,
      `mistimed`, `unreport`, `sleeve reports`, `sleeve tag --fix-reported`. Lyrics are caught by id and by content, since
      the file holds what LRCLIB gave. Nothing is sent to LRCLIB.
- [ ] **Port the Genius provider.** (p3) [feature] Unsynced lyrics only, as the last fallback; Sunamu scrapes its
      pages (`src/main/lyricproviders/genius.ts` there). Check whether its API gives lyrics without scraping.
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
- [x] **"No correct lyrics" pick.** (p3) [feature] A negative pick: the user marks a track as having no right
      lyrics anywhere (or as instrumental), so the display stays empty instead of showing the ranking's wrong
      choice. Left out of 0.4.0.
      Done in 0.25.0: `TrackPrefs.setMark`, `sleeve pick --none`/`--instrumental`, `sleeve ctl mark`, the pick panel.
      Lyrics already in a marked file stay there; `sleeve tag` reports them. Emptying them could be a later flag.
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

- [x] **Batch-write lyrics into ID3 tags.** (p2) [feature] `sleeve tag DIR [--missing-only] [--dry-run]` over the
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
      Done in 0.14.0: `sleeve tag PATH... [--write] [--force] [--unsynced]` (src/core/tagger.ts, the frame writer
      in src/core/tags/id3.ts and lyricsTag.ts, deferred files in `tag_retries`, schema 4). Changed on the user's
      word (contract updated, musicman 1.56.1): synced lyrics replace beets' plain ones without `--force`; LRC
      already there stays. Checked against musicman's node-id3 on a copy of a library file: it reads the lyrics,
      keeps them through an update, and the audio and the other frames are unchanged. A preview of one album with
      beets lyrics: 9 of 9 would get synced lyrics. Written 2026-11-02 (La Roux, Trouble In Paradise): 9 of 9 in
      23 s, audio and every other frame identical to a backup, node-id3 reads the LRC, a second run passes them by.
- [x] **Faster library runs.** (p2) [perf] `sleeve tag` took 73 s for 9 uncached files. Measured 2026-11-02:
      answers are fast (LRCLIB 180 ms, NetEase 650 ms for search and two lyrics); the cost was the 1 s pause
      per file and LRCLIB's retry, and LRCLIB's 503 for lookups it has not cached (half of a random sample)
      lasts minutes, so the retry a second later almost never helped. Done in 0.15.0: `--jobs` (2) files at once,
      requests to each host 300 ms apart across them (src/core/throttle.ts, `--delay`), reports in file order,
      `--limit` never overshot, LRCLIB without its retry in batch runs. 24 random files, no cache: 70-91 s before,
      22-33 s after; `-j 3` gave 19 s but 7 deferred instead of 3-4, so 2 stays the default.
- [ ] **Library dry run, 2026-11-02.** (p1) [chore] 7551 files (188 of them in `.musicman`, now left out): 5512
      would write, 1762 deferred (all LRCLIB), 118 not found, 101 has lyrics, 58 instrumental; 410 NetEase answers
      were "纯音乐" stand-ins (provider fixed, cache rows deleted). An audit of the first 833 written from the
      cache: LRCLIB 203, none under 0.85; NetEase 630, about 50 under 0.85, 133 more than 2 s off, 36 ending early
      or late (remixes given the original's lyrics, a Korean song under Gorillaz' "Intro"). Fixed in
      0.16.0: version markers in match.ts, `doubtful` in the tagger, providers waited for in order.
      A second dry run (`--retry-now`) was stopped at 1809 files: 1317 deferred, LRCLIB answering 429 "Too many
      requests from this IP" (its limit is about 90 a minute; 0.15.0 sent up to 200, two at a time). Fixed in
      0.16.1 (provider `rateLimit`, serial hosts in the throttle).
      Fourth dry run, 2026-11-03 (0.16.2, 7363 files, 1 h 54 min): 2884 would write (1689 LRCLIB, 1195 NetEase;
      1881 replacing unsynced lyrics), 3838 deferred (about 3650 LRCLIB 503s, 180 429s, 5 502s; 1910 with NetEase
      lyrics held, 157 with a NetEase instrumental), 225 instrumental, 180 not found, 172 has lyrics, 64 doubtful.
      `--write` run the same night. 0.17.0 takes the later provider's answer after a day and three tries.
      Written 2026-11-03: 3456 overnight, 586 more at 10:03. 110 of the 4042 held non-Latin letters (NetEase
      credits and notes in Chinese, Cyrillic look-alikes, 4 songs wrong outright); after 0.19.0 104 were
      rewritten and 6 had their USLT emptied (no lyrics in Latin script; Talking Heads' "Animals" and Cypress
      Hill's "Bitter" have unsynced English ones on LRCLIB).
      Next: repeat runs for the deferred files over the following days.
- [x] **Honor LRCLIB's `Retry-After`.** (p1) [fix] Its docs say clients must: on a 429 (and a 503, usually 1 s)
      wait at least that many seconds, with up to 30% jitter, or risk a temporary ban. sleeve ignores it: the
      daemon's retry waits a fixed second, and `sleeve tag` goes on with the next file. The throttle could hold
      the host until it runs out; lrclib.ts's retry could wait for it.
      Done in 0.16.1, in the provider rather than the throttle, so sleeved and `sleeve tag` share it: a hold
      until Retry-After plus up to 30% jitter, during which requests fail at once (`LrclibHeldError`) unsent.
      0.16.2: a hold ending within 5 s is waited out; the third dry run showed 1 s holds after 503s deferring
      416 of the first 1000 files unasked.
- [ ] **Register sleeve with LRCLIB.** (p2) [chore] An app in https://lrclib.net/developers gets an `Lrclib-App-Id`
      (public, safe to ship) and about 180 requests a minute instead of 90, and a way for them to reach us.
      sleeve would send the header when one is configured. LRCLIB still answered 429 about 180 times in the
      fourth dry run at about 85 requests a minute, below the 90 its docs give; the registered allowance would
      cover that. 0.29.0 sends the header when `~/.config/sleeve/lrclib-app-id` holds an id; registering is left.
- [x] **Waited-out fallbacks.** (p3) [feature] Files written from NetEase after LRCLIB failed for a day (0.17.0) keep
      those lyrics even once LRCLIB answers. Could record them (their report says "failing since") and offer a
      run that asks LRCLIB again for just those, replacing the lyrics when LRCLIB's fit.
      Done in 0.26.0: `TagFallbacks` (schema 7), `sleeve tag --recheck-fallbacks`.
- [ ] **LRCLIB's refusals in library runs.** (p3) [perf] About half the less-known tracks get a 503 from LRCLIB on
      first ask and are deferred when NetEase has nothing synced; with the 10 min / 1 h / 6 h / 24 h backoff a
      library run needs several passes. Watch how many stay deferred after a full run before tuning the backoff
      or adding a `--until-done` that loops over deferred files.

## 5. Players

- [x] **Headless daemon over the session.** (p1) [feature] `sleeved`: `NowPlaying` (`src/now/session.ts`)
      behind the WebSocket protocol the renderer and Electron shell will use (state, current line, nudge,
      pick). Decide the protocol messages and how the daemon is started (systemd user unit like musicman's).
      Done in 0.6.0: `src/daemon/` (own RFC 6455 server on `node:http`, NDJSON Unix socket), protocol in
      `src/protocol/` and `docs/protocol.md`, `just install-service`; `sleeve now` is a client when it runs.
- [x] **Unit's node path goes stale.** (p3) [chore] `just install-service` writes the absolute path of the
      `node` on PATH (pnpm's) into the unit, as musicman's does; a node upgrade or a moved checkout breaks
      the service until it is run again. A wrapper that finds node at start would avoid it.
      Done in 0.19.1: `ExecStart=/usr/bin/env node ...`, node from the user manager's PATH (imported at login,
      pnpm's included). Without that import the default PATH has no pnpm; add a wrapper if that ever happens.
      A moved checkout still needs `just install-service` again.
- [x] **`sleeve line` for status bars.** (p3) [feature] Print the current line each time it changes, from a
      `subscribe` on the daemon's socket, so polybar/i3blocks need no socat and jq (docs/protocol.md showed
      that pipeline).
      Done in 0.27.0; it waits for sleeved and survives its restarts.
- [x] **Prefetch the next track's lyrics.** (p3) [perf] MPD's queue (`playlistinfo`) and Spotify's (no MPRIS
      queue; Web API only) could warm the cache, so lyrics are ready when a track starts. Lookups that wait
      on LRCLIB's "server busy" retries take several seconds today.
      Done in 0.8.0 for MPD: `nextsongid` and `playlistid` give the song queued next (random included), the
      session looks it up once the current track is settled and adopts the lookup when the track starts.
- [x] **Prefetch for Spotify.** (p3) [perf] MPRIS has no queue. Spotify's Web API does (`/me/player/queue`),
      which needs an OAuth token; musicman manages Spotify and may have one. Any such data would have to be
      added to musicman's contract (`docs/09-contract.md`) first, not read from its tables.
      Done in 0.24.0 with musicman's `spotify queue --format json` (its contract, version 1; musicman keeps the
      token): `spotifyNext` in src/players/musicman.ts, asked once per Spotify track by MprisPlayer's `next`
      option and given as `playback.next`, so the session prefetches it as it does MPD's. Needs the musicman
      release that has the command.
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
- [x] **Sandbox without a profile.** (p3) [chore] On Ubuntu 25.10 AppArmor blocks the user namespaces Chromium's
      sandbox needs, so the shell runs only after `just shell-sandbox` (a profile, sudo) or with
      `--no-sandbox`. The profile names the binary's path, so it breaks when the checkout moves; Ubuntu's
      own Electron apps ship one per app. Revisit if Electron or Ubuntu change this.
      Done in 0.19.1: the profile globs `@{HOME}/**/shell/node_modules/electron/dist/electron`, as Ubuntu's
      code profile globs its path, so moves and reinstalls keep it; `just shell` explains instead of letting
      Electron abort when namespaces are restricted and neither the profile nor a root SUID chrome-sandbox exists.
      The profile still takes one sudo; defaulting to --no-sandbox was turned down.
- [x] **Start the overlay with the session.** (p3) [feature] Today it is `exec just -f .../justfile shell` in the i3
      config. A systemd user unit bound to graphical-session.target would restart it and order it after
      sleeved and backdrop.
      Done in 0.22.0: `just install-shell-service` (sleeve-shell.service: PartOf and WantedBy
      graphical-session.target, after and wanting sleeved, Restart=on-failure). backdrop is started by i3, not
      systemd, so the unit cannot be ordered after it: the shell's `--wait-backdrop 20` waits for backdrop's
      state.json to name a live pid before stacking the overlay itself. A backdrop unit would be cleaner.
- [x] **Word-by-word highlight.** (p2) [feature] Lines carry `words` (enhanced LRC, later LRCLIB's lyricsfile and
      Musixmatch richsync); the renderer shows whole lines only. Fill each word as it comes due, from the same
      per-frame position.
      Done in 0.12.0: `wordTimings` in `src/now/lines.ts`; each word of the current line is drawn twice, a
      full-color copy clipped to how much is sung, so the overlay's shadow stays whole. `?words=estimate`
      (`--estimate-words`) times lines without words by word length, capped at 250 ms a letter. Few lyrics
      have word times yet (see A source of word timings).
- [x] **Word highlight in the terminal.** (p3) [feature] `sleeve now` shows whole lines; it could color the sung
      part of the current line with the same `wordTimings`.
      Done in 0.20.0: in a terminal (not NO_COLOR) the current line is redrawn in place, word by word as each
      starts, the rest dim (`LivePrinter`); `--estimate-words` for lines without word times; every other message
      ends the line first.
- [x] **Mouse in the renderer.** (p3) [feature] Click a candidate in the pick panel, scroll back through the
      lyrics by wheel (returning to the current line after a few seconds), click a line to seek (needs a seek
      command and player support).
      Done in 0.21.0 without the seek (see Click a line to seek): candidates take a click, and the wheel shifts
      the scroll target (`wheel`, `scrollBackOffset` in view.ts), kept between first and last line, until 4 s
      after the last turn. Window mode and browsers only; the overlay stays click-through.
- [x] **Click a line to seek.** (p3) [feature] A `seek` protocol message (messages.ts and docs/protocol.md; an
      addition, so PROTOCOL_VERSION stays), sent to the active player: MPD `seekcur`, MPRIS `SetPosition`
      (Spotify supports it). Then a click on a line in the renderer seeks to its time, offset applied.
      Done in 0.28.0; tried in the renderer with a fake player and against the fake MPD, and on real Spotify
      and MPD on 2026-11-04 (both work).
- [x] **Three window modes.** (p2) [feature] `overlay` under backdrop: backdrop places and stacks the window like a
      GLava instance. `overlay` without backdrop: sleeve stacks its own transparent, click-through,
      desktop-type window above the root. `window`: borderless, focusable, resizable, remembers its
      geometry; backdrop ignores it. Needs a way to detect backdrop (its daemon socket or `status --json`).
      0.10.0 has overlay under backdrop and window (detected by the live pid in backdrop's `state.json`).
      Without backdrop the overlay falls back to a window: i3 has no desktop layer, and an unmanaged window
      would need something to keep it at the bottom as backdrop does (a small restack of our own on map and
      on every new top-level window).
      Done in 0.18.0: without backdrop, and with a compositor (`_NET_WM_CM_S0` owned), the override-redirect
      overlay is lowered to the bottom once it maps (`shell/x11.ts`); later windows map over it, so nothing more is
      needed. `--position above` raises it over every window, again on each MapNotify or ConfigureNotify of a
      managed window; override-redirect windows (menus, notifications) stay over it. `--stack auto|backdrop|self`;
      monitors from `xrandr --listactivemonitors`. Window mode is borderless, class `sleeve`. Not handled: a
      wallpaper window (xwinwrap, GLava without backdrop) that does not lower itself covers the overlay.
- [x] **Album-art background without the GPU cost.** (p2) [perf] Sunamu rotates two 200vmax pseudo-elements with
      `blur(180px)` all the time (`Background.css`). Draw a downscaled cover in WebGL or canvas instead,
      where blur is nearly free. Take the cover's palette from the same canvas, in the renderer: no sharp or
      node-vibrant (Sunamu's needed a rebuild hack), and nothing to install.
      Done in 0.23.0: sleeved serves `/art/current?key=` for the track playing only (src/daemon/art.ts: MPRIS
      artUrl, the file's APIC through `TagReader.picture`, cover/folder/front beside it). The renderer draws it
      blurred into a 64 px canvas, stretched and cross-faded, an optional animation on transform only; text
      colors from `coverColors` (view.ts) through contrast.ts, as over the wallpaper. Every setting is a CSS
      variable, overridable in ~/.config/sleeve/style.css (served at /user.css).
- [x] **Live, seamless animation parameters.** (p2) [feature] Changing CSS keyframes restarts the animation.
      Drive the animation from a clock with parameters pushed over the socket and interpolated, so edits
      from the config or a dev panel apply without a jump. The renderer's scroll already works this way
      (`follow` in `src/renderer/view.ts`); the line highlight is still a CSS transition.
      Done in 0.30.0 for `sleeve-art-flow`: `style.css` is watched by the page and values glide. CSS keyframes still
      restart when edited, and the line highlight is still a CSS transition; no dev panel.
- [x] **Control how quickly the lyrics fade toward the edges.** (p3) [feature] Asked for 2026-11-04: `--lyrics-fade-top`, `--lyrics-fade-bottom`,
      `--lyrics-clear-top` and `--lyrics-clear-bottom` in `style.css`, applied live. Done in 0.38.0.
- [x] **Lyric colors by contrast against what is actually behind them.** (p2) [feature] Sunamu picks from the cover
      palette; in overlay mode the background is the wallpaper. Choose text color by APCA/WCAG contrast
      against the wallpaper region (from backdrop) or the cover, with a shadow as fallback.
      The overlay half is done in 0.11.0 (`src/renderer/contrast.ts`); the cover half in 0.23.0, from the cover
      as it shows (faded and dimmed, `coverColors` in view.ts).
- [x] **Areas inside the window, for running as backdrop's wallpaper layer.** (p2) [feature] Asked for 2026-11-04: backdrop wants to give sleeve a whole
      monitor and have the lyrics only in part of it (the left third, say), leaving the rest for GLava and whatever else. Spec in backdrop's `docs/specs/sleeve.md`:
      `--lyrics-area` and `--now-area` (`WxH+X+Y`, pixels or percent of the window) on `sleeve shell` and `sleeve ctl display`, text sized to its area.
      Done in 0.34.0.
- [x] **A background for the window.** (p2) [feature] `--background transparent|#rrggbb|#rrggbbaa|cover|cover@0.6`, on the shell and over `ctl`, so sleeve can be the
      wallpaper with no mpv behind it, or a see-through layer over mpv with GLava above it. The alpha is the background's alone, text stays solid. `--hide` hides the content and keeps the
      background. Text colors follow it, blended over the stdin line when see-through. In backdrop's `docs/specs/sleeve.md`.
      Done in 0.35.0.
- [x] **`--map-below`.** (p2) [feature] A full-monitor opaque window mapped on top covers every other window for the 2 s until backdrop places it. Map it at
      the bottom of the stack once, as GLava does for itself, and still never restack after. In backdrop's `docs/specs/sleeve.md`, Stacking.
      Done in 0.36.0.
- [x] **Measure a full-monitor transparent window.** (p3) [perf] It runs all day under the compositor. Measure on Iris Xe, repaint only the areas if it matters, and
      put the figures in the contract in `~/git/backdrop/docs/specs/sleeve.md`.
      Measured 2026-11-04: figures in backdrop's `docs/specs/sleeve.md`, Cost; `just bench-gpu` measures them again. Electron's share is small;
      picom's could not be told from its noise.
- [ ] **A window the size of the screen comes out 1 px short.** (p3) [bug] Found from backdrop 2026-11-04 under Xvfb at 1280x720: `sleeve shell --managed --geometry 1280x720+0+0` gives a
      1279x719 window (xwininfo), while 858x720+422+0 beside it is exact. Nothing in `shell/main.ts` shrinks it, so it may be Electron treating it as fullscreen. An opaque window as the wallpaper would
      leave a 1 px seam on the right and bottom. Check on the real desktop first, since this was seen only under Xvfb, with no window manager.

