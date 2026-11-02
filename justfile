# sleeve tasks; `just` lists them

set positional-arguments

# List the recipes
default:
    @just --list --unsorted

# Every test, spec reporter
test:
    npm test

# Every test, dot reporter (what agents run)
test-brief:
    npm run test:brief

# Only the files given, e.g. just test-file test/core/match.test.ts (.mocharc.json's spec would add every file)
test-file +files:
    npx mocha --no-config --require test/helpers/setup.ts --extension ts --reporter dot "$@"

# TypeScript checks (tsc --noEmit)
typecheck:
    npm run typecheck

# Tests and typecheck, as before every commit
check: test-brief typecheck

# Run the CLI from the sources, e.g. just sleeve lyrics song.mp3 --all
sleeve *args:
    node src/cli/index.ts "$@"

# Lyrics for a file or --artist/--title
lyrics *args:
    node src/cli/index.ts lyrics "$@"

# Follow what MPD or Spotify plays
now *args:
    node src/cli/index.ts now "$@"

# What plays, once, as JSON
status:
    node src/cli/index.ts now --once --json

# The version in package.json
version:
    @node -p "require('./package.json').version"

# Annotated tag for the version in package.json, after the checks; push with git push --follow-tags
tag: check
    #!/usr/bin/env bash
    set -euo pipefail
    version=$(node -p "require('./package.json').version")
    if [ -n "$(git status --porcelain)" ]; then echo "Commit first: the tree has changes" >&2; exit 1; fi
    if git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then echo "v$version is already tagged" >&2; exit 1; fi
    git tag -a "v$version" -m "v$version"
    echo "Tagged v$version"
