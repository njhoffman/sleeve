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
- **musicman** (`~/git/musicman`) manages the library, MPD and Spotify, and writes ID3 tags, including
  custom `TXXX:sp_*` fields. sleeve must never clobber them when it writes lyrics. sleeve reads only what
  musicman's `docs/09-contract.md` promises (`paths.json`, the `spotify_track_files` view, read-only); never
  its other tables. A change sleeve needs from musicman goes into that contract first.

## Commands

```bash
just check               # npm run test:brief and npm run typecheck; agents run this before committing
just test-file test/core/match.test.ts   # only these files (plain `npx mocha FILE` runs every file too)
npm test                 # mocha over test/**/*.test.ts (spec reporter)
npm run typecheck        # tsc --noEmit (TypeScript 7)
just now --once          # node src/cli/index.ts now --once
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
  `src/core/tags/musicMetadata.ts` imports music-metadata.
- Players implement `Player` (`src/players/types.ts`) and push a `Playback` on every change; position runs on
  between changes (`positionAt`). Only `src/players/mprisDbus.ts` imports the D-Bus library; tests use a fake
  `MprisBus` and the fake MPD server in `test/helpers/fakeMpd.ts`.
- Tests stay offline: inject `fetch` (`test/helpers/fetch.ts`) and replay recorded responses from
  `test/fixtures/<provider>/`; build tagged mp3s with `test/helpers/id3.ts`.

## Workflow

- Run `just check` (`npm run test:brief` and `npm run typecheck`) before every commit.
- Semantic versioning in `package.json`, an annotated `vX.Y.Z` tag per release; one bump per finished change.
- Keep `CHANGELOG.md` (Keep a Changelog) current under `## [Unreleased]`, written for users.
- Keep `TODO.md` current: `- [ ] **Title.** (pN) [category] summary` under the right project; tick items off.
