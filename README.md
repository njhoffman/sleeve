# sleeve

Synced lyrics for the song playing in MPD or Spotify, from several sources, shown in a window or as a
desktop overlay above [backdrop](https://github.com/njhoffman/backdrop)'s wallpaper. A restart of
[Sunamu](https://github.com/NyaomiDEV/Sunamu), whose maintainer has left it.

> **Status:** the lyrics core and the `sleeve lyrics`, `pick` and `offset` commands work. The player daemon, the display and
> writing lyrics into tags are planned; see [TODO.md](TODO.md).

## Requirements

- Node.js 24 or later (runs the TypeScript sources directly, no build step)

## Install

```bash
git clone git@github.com:njhoffman/sleeve.git
cd sleeve
npm install
npm link        # installs the `sleeve` command
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
sleeve cache                                   # how many answers are stored, by provider (also --json)
sleeve cache clear --not-found                 # forget "no lyrics" answers so those tracks are asked again
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
punctuation, "feat." credits and same-recording suffixes such as "2009 Remaster" are ignored; "Live" or
"Acoustic" are not), the album when both sides have one, and the duration (full marks within 2 seconds,
none at 10 seconds apart). A wrong duration, title or artist keeps a candidate under the 0.6 threshold,
whatever the rest says. Of the candidates that pass, synced lyrics come first, then the higher score.

A file's duration is measured from its audio, since synced lyrics are timed against what plays; musicman's
`sp_duration_ms` is the fallback. The file's ISRC and Spotify id (`TSRC`, `TXXX:sp_isrc`,
`TXXX:sp_track_id`) are read for providers that look tracks up by them; LRCLIB does not.

## Stored answers

What online providers answer, found or not, is stored in `$XDG_DATA_HOME/sleeve/sleeve.db` (SQLite) and
used instead of asking again: answers with lyrics for 180 days, answers without for 7 days. A track is its
normalized artist and title plus the duration asked with, within 2 seconds. Candidates are stored unscored,
so scoring changes apply to stored answers too. Failures (timeouts, "server busy") are not stored, and
local providers are never cached. `--no-cache` neither reads nor stores; `--refresh` asks again and replaces
the stored answer; `sleeve cache clear [-p provider] [--not-found]` forgets answers.

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

LRCLIB answers "server busy" (503) under load, mostly for lookups it has not cached; sleeve retries twice
and then reports it, and NetEase usually has the song. NetEase's search ranks loosely (live versions and
covers come first), so its results are scored by title, artist and length before any lyrics are fetched,
and only the best two are fetched; credit lines at the top of its lyrics ("作词 : ...") are dropped.

## Development

```bash
npm test             # mocha, offline
npm run test:brief   # the same with the dot reporter
npm run typecheck    # tsc --noEmit
```

Tests never reach the network: provider tests replay recorded responses from `test/fixtures/`, and tagged
mp3s are built by `test/helpers/id3.ts`.
