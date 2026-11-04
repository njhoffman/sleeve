# sleeved protocol

sleeved (`sleeve daemon`) follows MPD and Spotify, looks up lyrics for what plays, and serves both to any
number of clients. This is protocol version 1. The types live in `src/protocol/messages.ts`; a client in
TypeScript (browser or Node) can rebuild the session from the messages with `SessionMirror`
(`src/protocol/mirror.ts`).

## Transports

The same JSON messages go over two transports:

| Transport  | Where                                                            | Framing                        | For                          |
| ---------- | ---------------------------------------------------------------- | ------------------------------ | ---------------------------- |
| WebSocket  | `ws://127.0.0.1:6620/ws` (`--host`, `--port`; `--no-websocket`) | one message per text frame     | the renderer, Electron       |
| Unix socket| `$XDG_RUNTIME_DIR/sleeve/sleeved.sock` (`--socket`; `--no-socket`)| one JSON object per line (NDJSON) | `sleeve now`, scripts, bars |

The WebSocket accepts browser pages only from `localhost`, `127.0.0.1`, `[::1]` and `file://`, plus the origins
given to `--allow-origin` (`*` for any); clients that send no `Origin` (non-browsers) are let in. Other pages
get `403`. The Unix socket's directory is created `0700`.

From the shell:

```sh
# Everything, as it happens
socat - UNIX-CONNECT:$XDG_RUNTIME_DIR/sleeve/sleeved.sock
# The current line whenever it changes, for a status bar
echo '{"type":"subscribe","lines":true}' | socat -t 86400 - UNIX-CONNECT:$XDG_RUNTIME_DIR/sleeve/sleeved.sock \
  | jq --unbuffered -r 'select(.type == "line") | .line.text // ""'
```

## Timing

The daemon does not push lines on a clock of its own by default: it sends the lyrics once per change and the
playback whenever it changes (play, pause, seek, track, a resync from the player), and each client works out the
current line itself. That keeps line changes exact to the frame in the renderer, whatever the socket's delay.

A playback carries `positionMs` at `at`, a **wall-clock** time in epoch milliseconds (`Date.now()`), and `rate`.
Daemon and clients run on one machine and share its wall clock, so the position now is

```
positionMs + (Date.now() - at) * rate      while state is "playing"
positionMs                                  otherwise
```

kept within `track.durationMs`. A client that times animations on `performance.now()` converts once on receipt
(`fromWire` in `mirror.ts`). The line playing is the last synced line whose `time + offsetMs` is at or before
the position (`lineAt` in `src/now/lines.ts`).

Clients that cannot do that (shell scripts) send `subscribe` with `lines: true` and get a `line` message each
time the current line changes; the daemon sets a timer for the next line's start rather than polling.

## Daemon to client

On connecting, a client is sent `hello`, then `playback`, `lyrics` and `players` (in that order: `players` ends
the greeting), then each change as it happens.

| type       | Fields                                                                                    | Sent                                   |
| ---------- | ----------------------------------------------------------------------------------------- | -------------------------------------- |
| `hello`    | `protocol` (1), `version` (sleeve's)                                                      | first                                  |
| `playback` | `playback`: `{ player, state, track, positionMs, at, rate }` or `null`                    | on every playback change               |
| `lyrics`   | `key`, `query`, `loading`, `error`, `result`                                              | track change, lookup start and end, pick, refresh, a provider answering late |
| `offset`   | `offsetMs`                                                                                | after a nudge or offset: the rest of the last `lyrics` stands |
| `players`  | `problems`: `[{ player, problem }]`, players that cannot be reached                       | when that list changes                 |
| `line`     | `key`, `line`: `{ index, text, timeMs }` (`index` -1 before the first line)               | to subscribers, as the line changes    |
| `reply`    | `id` (the command's), `ok`, `error` or `data`                                             | once per command                       |

`key` names the track as `player:track key` (`null` when nothing plays). `track` is
`{ key, artist, title, album?, durationMs?, file?, spotifyId? }`. `result` is the lookup's `LyricsResult`
(`src/core/types.ts`): `best` (the candidate shown, with `lyrics.lines[]` of `{ time, text, words? }`),
`candidates`, `rejected`, `errors`, `pinned` and `offsetMs`. Lyrics are as the provider gave them; apply
`offsetMs` (positive: later) when showing them. While a pick or refresh reloads, `lyrics` comes with
`loading: true` and the old `result`, so a display keeps what it shows. A lookup sends what the first providers
found while the others are still out (`loading: true` with a `result`), and sleeved asks a provider that failed
again while the track plays (after 20 s, 1, 3 and 10 minutes): each answer that changes the result comes as
another `lyrics`. Synced lyrics shown are replaced only in the first fifth of the track.

## Client to daemon

Each command is one JSON object with a `type`, and an optional `id` (string or number) that its `reply` carries
back. Replies may come after the broadcasts the command caused.

| type         | Fields              | Does                                                                                         | `data`                 |
| ------------ | ------------------- | -------------------------------------------------------------------------------------------- | ---------------------- |
| `nudge`      | `ms` (integer)      | moves the lyrics shown by `ms` (positive: later), saved for the track like `sleeve offset`   | `{ offsetMs }`         |
| `offset`     | `ms` (integer)      | sets the offset; `0` removes it                                                              | `{ offsetMs }`         |
| `candidates` |                     | asks every provider for the track (the cache still answers for online ones)                  | a `LyricsResult`       |
| `pick`       | `ref` (`provider:id`)| shows that candidate for the track from now on, like `sleeve pick`, and reloads              | `{ ref }`              |
| `mark`       | `mark` (`none`, `instrumental`) | shows nothing for the track from now on, like `sleeve pick --none`, and reloads  | `{ mark }`             |
| `unpick`     |                     | forgets the pick or mark and reloads                                                         | `{ removed }`          |
| `refresh`    |                     | looks the track up again, asking online providers instead of their stored answers            |                        |
| `state`      |                     | sends `playback`, `lyrics` and `players` again (and `line`, to a subscriber)                 |                        |
| `subscribe`  | `lines` (boolean)   | starts or stops `line` messages for this client                                              |                        |

A command that cannot be done is answered `ok: false` with `error`, e.g. `No lyrics to move`, `Nothing playing`,
`Picks are off (--no-prefs)`, `Unknown command: …`.

## HTTP

The WebSocket's HTTP server also serves the renderer: `GET /` is `src/renderer/index.html`, and `/src/...` the
browser-safe sources it imports, TypeScript turned into JavaScript on request. Anything else is `404`.

## WebSocket details

sleeved implements the server side of RFC 6455 itself (`src/daemon/websocket.ts`): text messages only (binary
closes with 1003), fragmented messages reassembled, at most 1 MiB a message (1009), no extensions or
subprotocols. It pings every 30 s and drops a client that has not answered the previous ping, and drops a client
that leaves more than 8 MiB unread. TCP_NODELAY is set.
