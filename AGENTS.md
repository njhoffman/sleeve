# AGENTS.md

Guidance for coding agents working in this repository.

## Project

sleeve: synced lyrics for what MPD or Spotify plays, from several sources, shown in a window or as a desktop
overlay. A restart of Sunamu (`~/git/Sunamu` holds the old fork, for reference only). Built so far: the
lyrics core (`src/core/`) and the `sleeve lyrics` command (`src/cli/`). Planned: a headless daemon with a
WebSocket protocol, a web renderer, a thin Electron shell, and writing lyrics into ID3 tags. The roadmap
and open design questions are in `TODO.md`; `OUTLINE.md` is the original brief.

Related projects (keep them in mind before designing player, tagging or window features):

- **backdrop** (`~/git/backdrop`) places sleeve's overlay when it runs: the window is marked
  `_BACKDROP_OVERLAY` (`below`/`above`) and sleeve runs `backdrop restack`; backdrop writes the wallpaper
  colors behind the overlay into its `state.json`. Contract: Overlays in `docs/specs/visualizer.md` there.
- **musicman** (`~/git/musicman`) manages the library, MPD and Spotify, and writes ID3 tags, including
  custom `TXXX:sp_*` fields. sleeve must never clobber them when it writes lyrics.

## Commands

```bash
npm test                 # mocha over test/**/*.test.ts (spec reporter)
npm run test:brief       # the same with the dot reporter; agents use this
npx mocha test/core/match.test.ts   # one file while iterating
npm run typecheck        # tsc --noEmit (TypeScript 7)
node src/cli/index.ts lyrics --help
```

## Conventions

- Node 24 runs the `.ts` sources directly (type stripping): only erasable TypeScript (no enums, namespaces or
  parameter properties; `erasableSyntaxOnly` enforces it), relative imports with the `.ts` extension, and
  `import type` for types (`verbatimModuleSyntax`). There is no build step.
- Plain ESM, `node:` imports for built-ins, built-in `fetch` for HTTP, commander for the CLI.
- Providers implement `Provider` (`src/core/providers/provider.ts`): return unscored candidates, `[]` when
  they have nothing, throw on failures. Scoring and ranking live in `src/core/match.ts` only.
- Local file tags go through the `TagReader` interface (`src/core/tags/reader.ts`); only
  `src/core/tags/musicMetadata.ts` imports music-metadata.
- Tests stay offline: inject `fetch` (`test/helpers/fetch.ts`) and replay recorded responses from
  `test/fixtures/<provider>/`; build tagged mp3s with `test/helpers/id3.ts`.

## Workflow

- Run `npm run test:brief` and `npm run typecheck` before every commit.
- Semantic versioning in `package.json`, an annotated `vX.Y.Z` tag per release; one bump per finished change.
- Keep `CHANGELOG.md` (Keep a Changelog) current under `## [Unreleased]`, written for users.
- Keep `TODO.md` current: `- [ ] **Title.** (pN) [category] summary` under the right project; tick items off.
