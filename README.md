# sleeve

Synced lyrics for the song playing in MPD or Spotify, from several sources, shown in a window or as a
desktop overlay above [backdrop](https://github.com/njhoffman/backdrop)'s wallpaper. A restart of
[Sunamu](https://github.com/NyaomiDEV/Sunamu), whose maintainer has left it.

> **Status:** the lyrics core, `sleeve now` (lyrics for what MPD or Spotify plays, in the terminal), the
> `sleeve lyrics`, `pick` and `offset` commands, the daemon (`sleeved`) and its web renderer work. The
> Electron overlay and writing lyrics into tags are planned; see [TODO.md](TODO.md).

## Requirements

- Node.js 24 or later (runs the TypeScript sources directly, no build step)

## Install

```bash
git clone git@github.com:njhoffman/sleeve.git
cd sleeve
npm install
npm link        # installs the `sleeve` and `sleeved` commands
just install-service && systemctl --user enable --now sleeved   # optional: run the daemon at login
```

## Usage

```bash
sleeve lyrics song.mp3                         # the best lyrics for a file, as LRC, from its tags
sleeve lyrics -a "Radiohead" -t "Everything In Its Right Place" -d 4:11
sleeve lyrics song.mp3 --format plain          # text without timestamps
sleeve lyrics song.mp3 --all                   # every candidate, numbered, with its ref and score, rejected ones too
sleeve lyrics song.mp3 --json                  # the query and every candidate, for scripts
sleeve lyrics song.mp3 -p sidecar,embedded     # only the providers named
sleeve lyrics song.mp3 --refresh               # ask online providers again instead of using stored answers
sleeve pick song.mp3 2                         # show candidate 2 of --all for this track from now on
sleeve pick song.mp3 lrclib:321980             # the same by provider:id
sleeve pick --reset song.mp3                   # let the ranking decide again
sleeve offset song.mp3 -250                    # show this track's lyrics 250 ms sooner (+250: later)
sleeve offset song.mp3                         # show the offset; 0 or --reset removes it
sleeve now                                     # lyrics for what MPD or Spotify plays, line by line
sleeve now --once                              # the track, where it is, and the current line
sleeve now --once --json                       # the same with the lyrics, for scripts and status bars
sleeved                                        # the daemon: serve what plays to displays (sleeve daemon)
sleeve cache                                   # how many answers are stored, by provider (also --json)
sleeve cache clear --not-found                 # forget "no lyrics" answers so those tracks are asked again
sleeve tag ~/Music/Sorted/Some/Album           # what synced lyrics would go into these mp3s (nothing written)
sleeve tag --write ~/Music/Sorted              # write them into the library's tags
```

The lyrics go to stdout and a line naming their source to stderr, so `sleeve lyrics song.mp3 > song.lrc`
writes a clean LRC file. The exit status is 0 with lyrics and 1 without; usage errors exit 2.

## How lyrics are found

Providers, in order:

| Provider   | Source                                              | Notes                                         |
| ---------- | --------------------------------------------------- | --------------------------------------------- |
| `sidecar`  | an `.lrc` next to the file, with the same name      | exact; needs a file                           |
| `embedded` | the file's own tags: `SYLT`, or `USLT` (LRC or text) | exact; needs a file                           |
| `lrclib`   | [LRCLIB](https://lrclib.net), free and keyless      | synced LRC; matches on artist, title, duration |
| `netease`  | NetEase Cloud Music, no account                    | synced LRC; covers many LRCLIB misses          |

Local providers run first. When one of them has synced lyrics, nothing goes online (`--all` asks every
provider anyway). Online providers run in parallel, each with its own timeout (`--timeout`, 10 seconds), and
one that fails is reported without stopping the others.

Each candidate is scored from 0 to 1 against the track: title and artist after normalizing (accents, case,
punctuation, "feat." credits and same-recording suffixes such as "2009 Remaster" are ignored), the album when
both sides have one, and the duration (full marks within 2 seconds, none at 10 seconds apart). A wrong
duration, title or artist keeps a candidate under the 0.6 threshold, whatever the rest says, and so does
another version of the song: titles must agree on what their bracketed or dashed suffix calls it (remix or mix,
live, acoustic, unplugged, stripped, edit, demo, instrumental, karaoke, cover, rework, bootleg, dub, VIP), so
"Hey Now (SBMRGE Remix)" does not get the original's lyrics, while "Live Forever" and "Strobe (Original Mix)"
count as no version at all. Of the candidates that pass, synced lyrics come first, then the higher score.

A file's duration is measured from its audio, since synced lyrics are timed against what plays; musicman's
`sp_duration_ms` is the fallback. The file's ISRC and Spotify id (`TSRC`, `TXXX:sp_isrc`,
`TXXX:sp_track_id`) are read for providers that look tracks up by them; LRCLIB does not.

## Stored answers

What online providers answer, found or not, is stored in `$XDG_DATA_HOME/sleeve/sleeve.db` (SQLite) and
used instead of asking again: answers with lyrics for 180 days, answers without for 7 days. A track is its
ISRC or Spotify id when it has one (from the file's tags, or from Spotify), else its normalized artist and
title plus the duration asked with, within 2 seconds. So a file and Spotify share what is stored for one
recording even when they name it differently, and two recordings with the same name but different ISRCs
(a live take, a re-recording) are kept apart. Entries stored by name pick up the IDs of the first track that
matches them. Candidates are stored unscored,
so scoring changes apply to stored answers too. Failures (timeouts, "server busy") are not stored, and
local providers are never cached. `--no-cache` neither reads nor stores; `--refresh` asks again and replaces
the stored answer; `sleeve cache clear [-p provider] [--not-found]` forgets answers.

## What plays

`sleeve now` follows MPD and Spotify at once and shows lyrics for the active one: the one playing (Spotify
when both are, as musicman decides), else the one paused last. Each line prints as it comes due; `+` and `-`
move the lyrics 100 ms later or sooner and save it for the track (as `sleeve offset` does), `q` quits.

- **MPD** is read through its own protocol: exact elapsed time, and changes (play, pause, seek, next song) the
  moment they happen. Its address comes from `--mpd`, then `MPD_HOST`/`MPD_PORT`, then musicman, then
  `localhost:6600`; the file playing is found under `--music-dir` or musicman's library directory, so its
  `.lrc`, its own tags and its measured length are used.
- **Prefetch:** while a song plays, the lyrics for the one MPD has queued next are looked up, so they are ready
  when it starts; `--no-prefetch` turns that off. Spotify's queue cannot be read over MPRIS, so it is not
  prefetched.
- **Spotify** (or any MPRIS player, `--mpris spotify,vlc`) is read over D-Bus: its track, play state and
  position, read again on every change and seek and every 5 seconds while playing. `--no-mpd` and
  `--no-mpris` leave one side out.
- **musicman**, when installed (1.55.0 or later), tells sleeve where MPD and the library are
  (`~/.local/state/musicman/paths.json`) and which library file a Spotify track is. The file's lyrics and tags
  are used if its length is within 2 seconds of Spotify's, since a different master would put them out of
  time. Without musicman, Spotify tracks are looked up online only.

## The daemon

`sleeved` (or `sleeve daemon`, `just daemon`) follows the players as `sleeve now` does, takes the same player,
provider and store options, and serves what plays to any number of displays: over a WebSocket at
`ws://127.0.0.1:6620/ws` for the browser renderer and the Electron shell, and over a Unix socket at
`$XDG_RUNTIME_DIR/sleeve/sleeved.sock`, one JSON message per line, for scripts and status bars. It sends the
lyrics once per change and the playback clock as it changes, and each display works out the current line;
nudges, picks and refreshes go the other way. [docs/protocol.md](docs/protocol.md) has the messages.

While sleeved runs, `http://127.0.0.1:6620/` shows the lyrics in a browser, scrolling as each line comes due.
`+` and `-` move them 100 ms (saved for the track), `0` removes the offset, `p` lists every provider's
candidates to pick from, `r` looks the track up again online, and `?` lists the keys. The page is served from
the sources (sleeved strips the TypeScript types as it sends each file), so there is nothing to build.

Lyrics with word times (enhanced LRC, such as a word-timed `.lrc` next to the file) fill word by word as they
are sung. Few lyrics online have word times, so `http://127.0.0.1:6620/?words=estimate` fills every line that
way, spreading the line's time over its words by their length: it reads well on most lines, but runs ahead of
held notes.

### The overlay

`just shell-install` installs Electron into `shell/` (about 100 MB, apart from the rest). `just shell` then
shows the lyrics on the desktop: a transparent, click-through window just above backdrop's wallpaper and under
its visualizer, from 15% of the monitor down to where the visualizer starts. i3 never manages it, so it is on
every workspace and under every window, as the visualizer is. backdrop stacks it again when its daemon
restarts. Options: `--position above` (over the visualizer), `--geometry 1200x500+360+200`, `--monitor
HDMI-1`, `--url`, `--estimate-words` (the page's `?words=estimate`). The text color follows the wallpaper: backdrop samples the colors behind the overlay, and the
lyrics turn light or dark by contrast against every part that covers a tenth of it, with a stronger shadow when
no color reads well over all of it (a picture half dark, half bright). Without backdrop running it opens as a plain window instead; `just shell --window` always
does, and remembers where it was.

Ubuntu's AppArmor blocks the user namespaces Electron's sandbox needs, so Electron stops at once with a
`chrome-sandbox` error. `just shell-sandbox` installs a profile that allows them for this checkout's Electron
(it asks for sudo); `just shell --no-sandbox` runs without the sandbox instead.

The overlay takes no keys, since clicks and keys go to the windows under it. `sleeve ctl` sends sleeved one
command and prints the outcome, for i3 bindings:

```
bindsym $mod+equal exec --no-startup-id sleeve ctl nudge +100
bindsym $mod+minus exec --no-startup-id sleeve ctl nudge -100
bindsym $mod+0     exec --no-startup-id sleeve ctl offset 0
bindsym $mod+r     exec --no-startup-id sleeve ctl refresh
```

`sleeve ctl candidates` lists every provider's lyrics for what plays, numbered, and `sleeve ctl pick 2` (or
`pick provider:id`) shows one of them from then on; `sleeve ctl unpick` goes back to the ranking.

While sleeved runs, `sleeve now` shows its session instead of opening the players itself, so a nudge in the
terminal moves the lyrics in every display. Any player, provider or store option (`--mpd`, `-p`,
`--no-cache`, ...) or `--no-daemon` makes `sleeve now` run its own session; `--daemon` fails rather than run
one.

`just install-service` writes a systemd user unit for this checkout and the `node` on your PATH (run it
again after moving either); `systemctl --user enable --now sleeved` starts it, `just logs` follows its log.
The WebSocket refuses pages from other sites (`403`), since they could otherwise nudge and pick for you;
`--allow-origin` lets one in.

## Picks and offsets

When the ranking chooses the wrong lyrics, `sleeve pick` chooses for it: the candidate, by its number in
`sleeve lyrics --all` or its `provider:id`, is shown for the track from then on, even if it scores under the
threshold. Nothing else is asked while a pick stands: an online pick is kept with a copy of its lyrics, so it
outlives the stored answer, and a local one (`sidecar`, `embedded`) is read from its file again, so edits to
an `.lrc` count. If that file is gone, the ranking decides and stderr says so. `--all` still asks everyone and
lists the pick first; `-p` without the pick's provider leaves it out.

When lyrics run ahead of or behind the music, `sleeve offset` shifts them, in milliseconds: positive shows
them later, negative sooner. (LRC's own `[offset:]` tag runs the other way.) An offset belongs to the
candidate it was set for, so picking other lyrics leaves it stored but unused. `sleeve lyrics` prints the
shifted LRC and says `pinned` / `offset -250ms` on stderr; `--json` gives the lyrics unshifted with
`offsetMs` and `pinned`, for displays that shift them live. `--no-prefs` ignores both. Picks and offsets
live in the same database as the stored answers, match tracks the same way, and are kept until reset;
`sleeve cache clear` leaves them alone.

LRCLIB answers "server busy" (503) under load, mostly for lookups it has not cached, and stays busy for those
for minutes; sleeve retries once after a second and then reports it (`sleeve tag` does not retry, see below).
When LRCLIB says how long to wait (`Retry-After`, on a 503 or a 429 "Too many requests"), sleeve sends it nothing
until that has run out, plus up to 30% more, as LRCLIB's docs require of clients; a lookup in the meantime waits
when the hold ends within 5 seconds (a 503 usually asks for one), and otherwise fails at once ("asked to wait
until ...") and is asked again later,
and NetEase usually has the song. NetEase's search ranks loosely (live versions and covers come first), so its
results are scored by title, artist and length before any lyrics are fetched, and only the best two are
fetched; credit lines at the top of its lyrics ("作词 : ...") are dropped, and lyrics that only say the song is
instrumental ("纯音乐，请欣赏", pure music, please enjoy) make it an instrumental.

## Lyrics in the files

`sleeve tag PATH...` looks up synced lyrics for mp3 files (directories are gone through) and says what it would
write; `--write` writes them into each file's `USLT` frame as LRC text, with your offset applied and without
word times. Most players and taggers read lyrics there. Synced lyrics replace plain ones (beets' lyrics plugin
writes those on import) and fill an empty frame; lyrics a file already has in LRC stay unless `--force`, and
plain lyrics are written only with `--unsynced`, never over others. Instrumentals are left alone. Hidden
directories are not gone through (musicman keeps its trash and downloads under the library's `.musicman`)
unless named on the command line.

What goes into a file is held to more than what is shown on screen, since it stays there (a second run passes
LRC by unless `--force`):

- **It must fit the audio.** Synced lyrics whose track is more than about 4 seconds longer or shorter than the
  file, or whose last line comes before 15% of the way through or after the end, are `doubtful` and not written;
  the next candidate that fits is taken instead. These catch other versions with the same name, and lyrics a
  provider files under the wrong song. A pick you made (`sleeve pick`) is written as it is.
- **Providers are waited for in order.** When a provider fails, lyrics (or an instrumental) from a provider after
  it in the list are held and the file is deferred until the earlier one answers. A run while LRCLIB is
  overloaded therefore does not fill the library with NetEase's lyrics, which match less well; NetEase's are
  written once LRCLIB has answered that it has none. Lyrics from LRCLIB are written whatever NetEase does.

Only the `USLT` frame changes: every other frame stays byte for byte, the tag keeps its version, and the file is
replaced through a temporary file only if nothing else changed it meanwhile. That is what sleeve promises
[musicman](https://github.com/njhoffman/musicman) (its `docs/09-contract.md`), whose tags share the files.

A run lists only the files that need attention (`-v`: every file) and ends with counts; a second run passes by
what the first wrote, so stopping it (Ctrl-C finishes the files in hand) loses nothing. Files a provider failed for
(LRCLIB is often overloaded, for about a quarter of a library's first run) are deferred: a later run asks about
them again after 10 minutes, then 1, 6 and 24 hours (`--retry-now` at once), so a library takes a few runs.
LRCLIB is asked once per file, with no retry, since a second ask a moment later hardly ever gets through.

Two files are looked up at once (`-j`), and requests to each service are at least 300 ms apart (`--delay`). A
service's own rate limit comes first: LRCLIB allows about 90 requests a minute from one IP for a client that
names itself, as sleeve does, and asks batch clients to send them one at a time
([its docs](https://lrclib.net/docs), "Rate Limiting"), so its requests go one at a time, at least 700 ms apart
(`--delay` can only make that longer). Going over it gets "429 Too many requests" for every lookup, and the files
are deferred. Files LRCLIB has to be asked about take about a second each; those the cache answers go at once.
More jobs gain little. `--limit` stops after that many files.

## Development

```bash
just                 # the recipes
just check           # tests (dot reporter) and typecheck, as before every commit
just test-file test/players/mpd.test.ts   # only these files
just now --once      # the CLI from the sources
npm test             # mocha, offline, spec reporter
```

Tests never reach the network, MPD or D-Bus: provider tests replay recorded responses from `test/fixtures/`,
tagged mp3s are built by `test/helpers/id3.ts`, MPD is a local fake server (`test/helpers/fakeMpd.ts`) and
MPRIS players a fake bus.
