# AGENTS.md

Guidance for coding agents working in this repository.

## Project

sleeve: synced lyrics for what MPD or Spotify plays, from several sources, shown in a window or as a desktop
overlay. A restart of Sunamu (`~/git/Sunamu` holds the old fork, for reference only). Built so far: the
lyrics core (`src/core/`), the players (`src/players/`: MPD, MPRIS, the hub that picks the active one), the
session that follows them with lyrics (`src/now/`), and the `sleeve now`, `lyrics`, `pick`, `offset` and
`cache` commands (`src/cli/`). Planned: a headless daemon with a WebSocket protocol, a web renderer, a thin
Electron shell, and writing lyrics into ID3 tags. The roadmap and open design questions are in `TODO.md`;
`OUTLINE.md` is the original brief.

Related projects (keep them in mind before designing player, tagging or window features):

- **backdrop** (`~/git/backdrop`) places sleeve's overlay when it runs: the window is marked
  `_BACKDROP_OVERLAY` (`below`/`above`) and sleeve runs `backdrop restack`; backdrop writes the wallpaper
  colors behind the overlay into its `state.json`. Contract: Overlays in `docs/specs/visualizer.md` there.
  Without backdrop, sleeve stacks the overlay itself (`stackSelf` in `shell/x11.ts`) and leaves it unmarked.
  backdrop will also run sleeve as a visualizer engine, like GLava: `sleeve shell --managed` and `sleeve ctl display`, as
  promised in its `docs/specs/sleeve.md`. A change to either goes there first.
- **musicman** (`~/git/musicman`) manages the library, MPD and Spotify, and writes ID3 tags, including
  custom `TXXX:sp_*` fields. sleeve must never clobber them when it writes lyrics. sleeve reads only what
  musicman's `docs/09-contract.md` promises (`paths.json`, the `spotify_track_files` view read-only, and
  `musicman spotify queue --format json`); never its other tables. A change sleeve needs from musicman goes
  into that contract first.
- **harmonic** (`~/git/harmonic`) is a music visualizer in its early days, driven by stems separated offline, and meant
  to take lyrics too. No contract exists yet; `TODO.md` has the ideas ("Lyrics for harmonic"). Keep what it would need
  in mind before changing `sleeve lyrics --json`.

## Commands

```bash
just check               # npm run test:brief and npm run typecheck; agents run this before committing
just test-file test/core/match.test.ts   # only these files (plain `npx mocha FILE` runs every file too)
npm test                 # mocha over test/**/*.test.ts (spec reporter)
npm run typecheck        # tsc --noEmit (TypeScript 7)
just now --once          # node src/cli/index.ts now --once (through sleeved when it runs)
just daemon              # sleeved in the foreground
just install-service     # the systemd user unit for sleeved
```

## Conventions

- Node 24 runs the `.ts` sources directly (type stripping): only erasable TypeScript (no enums, namespaces or
  parameter properties; `erasableSyntaxOnly` enforces it), relative imports with the `.ts` extension, and
  `import type` for types (`verbatimModuleSyntax`). There is no build step.
- Plain ESM, `node:` imports for built-ins, built-in `fetch` for HTTP, commander for the CLI.
- Providers implement `Provider` (`src/core/providers/provider.ts`): return unscored candidates, `[]` when
  they have nothing, throw on failures. Scoring and ranking live in `src/core/match.ts` only.
- `sleeve.db` is opened and migrated only by `src/core/db.ts` (`SleeveDatabase`); `LyricsCache` (answers) and
  `TrackPrefs` (picks, offsets) share it. A schema change is a new entry in `MIGRATIONS` and a bump of
  `SCHEMA_VERSION`.
- Local file tags go through the `TagReader` interface (`src/core/tags/reader.ts`); only
  `src/core/tags/musicMetadata.ts` imports music-metadata. Lyrics are written only by `src/core/tags/lyricsTag.ts`
  (the `USLT` frame, through `src/core/tags/id3.ts`, every other byte of the tag kept), as musicman's contract
  (its `docs/09-contract.md`, "Lyrics in the library's tags") allows; a change to what sleeve writes goes there first.
- Players implement `Player` (`src/players/types.ts`) and push a `Playback` on every change; position runs on
  between changes (`positionAt`). Only `src/players/mprisDbus.ts` imports the D-Bus library; tests use a fake
  `MprisBus` and the fake MPD server in `test/helpers/fakeMpd.ts`.
- The renderer runs in the browser from the sources: sleeved serves `src/renderer/` and the files listed in
  `SERVED` (`src/daemon/static.ts`), stripping types on request. Everything it imports (`src/protocol/`,
  `src/now/lines.ts`, `src/now/state.ts`, `src/players/clock.ts`, `src/players/types.ts`) stays free of Node;
  `src/renderer/tsconfig.json` (DOM lib, no Node types, run by `npm run typecheck`) enforces it. A new file the
  renderer imports goes into `SERVED`. DOM code stays in `main.ts` (WebGL in `flow.ts`); logic goes in `view.ts`, tested in Node. A protocol change is a change to
  `src/protocol/messages.ts` and `docs/protocol.md` together; a breaking one bumps `PROTOCOL_VERSION`.
- The WebSocket server is our own (`src/daemon/websocket.ts`, on `node:http`); do not add ws. Playback goes on
  the wire stamped with the wall clock (`Date.now()`), never `performance.now()`, which differs per process.
- The shell (`shell/`) is a separate package so the root install stays light: Electron and x11 are its
  dependencies only. Its decisions (options, backdrop's state, who stacks the overlay, monitors, geometry) live in `src/shell/layout.ts`, Electron
  free and tested with the rest; `shell/main.ts` is the Electron glue and `shell/x11.ts` the only X11 code.
  The page gets nothing from the shell but the wallpaper colors behind the overlay (`shell/preload.cjs`, one
  way); everything else goes over sleeved's WebSocket, so the page works the same in a browser.
  `just check` typechecks the shell when `shell/node_modules` exists.
- Tests stay offline: inject `fetch` (`test/helpers/fetch.ts`) and replay recorded responses from
  `test/fixtures/<provider>/`; build tagged mp3s with `test/helpers/id3.ts`.

## Workflow

- Run `just check` (`npm run test:brief` and `npm run typecheck`) before every commit.
- Semantic versioning in `package.json`, an annotated `vX.Y.Z` tag per release; one bump per finished change.
- Keep `CHANGELOG.md` (Keep a Changelog) current under `## [Unreleased]`, written for users.
- Keep `TODO.md` current: `- [ ] **Title.** (pN) [category] summary` under the right project; tick items off.
