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

# Tests and typecheck, as before every commit (the shell too, once installed)
check: test-brief typecheck shell-typecheck

# Run the CLI from the sources, e.g. just sleeve lyrics song.mp3 --all
sleeve *args:
    node src/cli/index.ts "$@"

# Lyrics for a file or --artist/--title
lyrics *args:
    node src/cli/index.ts lyrics "$@"

# Follow what MPD or Spotify plays
now *args:
    node src/cli/index.ts now "$@"

# Run sleeved in the foreground, e.g. just daemon --port 6621
daemon *args:
    node src/cli/index.ts daemon "$@"

# Write the systemd user unit for sleeved (this checkout, this node) and reload systemd; does not enable it
install-service:
    #!/usr/bin/env bash
    set -euo pipefail
    unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/sleeved.service"
    mkdir -p "$(dirname "$unit")"
    printf '%s\n' \
      '[Unit]' \
      'Description=sleeve lyrics daemon (sleeved)' \
      'After=mpd.service' \
      '' \
      '[Service]' \
      "ExecStart=/usr/bin/env node $PWD/src/cli/index.ts daemon" \
      'Restart=on-failure' \
      'RestartSec=5' \
      '' \
      '[Install]' \
      'WantedBy=default.target' > "$unit"
    systemctl --user daemon-reload
    # node is looked up in the user manager's PATH at each start, so a new node or node manager needs nothing here;
    # a moved checkout does: run this again
    found=none
    IFS=: read -ra dirs <<< "$(systemctl --user show-environment | sed -n 's/^PATH=//p')"
    for dir in "${dirs[@]}"; do [ -x "$dir/node" ] && { found="$dir/node"; break; }; done
    echo "Wrote $unit (node from systemd's PATH: $found)"
    echo "Start it now and at login: systemctl --user enable --now sleeved"

# Install the Electron shell (shell/, ~100 MB; the daemon and CLI never need it)
shell-install:
    cd shell && npm install --no-audit --no-fund

# What each background costs the GPU in the real shell, kept in benchmarks/gpu.jsonl, with the average of every run so far.
# Placeholder lyrics show on the desktop while it runs, ignoring clicks. E.g. just bench-gpu --rounds 3; --show only prints
# the averages; --no-save tries it without keeping the result; --scene flow runs only the scenes with that in their name
bench-gpu *args:
    node src/bench/run.ts "$@"

# The lyrics window: an overlay (stacked by backdrop, else by sleeve), or --window; e.g. just shell --position above
shell *args:
    #!/usr/bin/env bash
    set -euo pipefail
    # Ubuntu's AppArmor blocks the user namespaces Electron's sandbox needs; say what to do rather than let Electron
    # abort with a chrome-sandbox trace
    sandbox="shell/node_modules/electron/dist/chrome-sandbox"
    if [[ " $* " != *" --no-sandbox "* ]] && [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] \
      && [ ! -e /etc/apparmor.d/sleeve-electron ] && ! { [ "$(stat -c %u "$sandbox" 2>/dev/null)" = 0 ] && [ -u "$sandbox" ]; }; then
      echo "AppArmor blocks Electron's sandbox here: run 'just shell-sandbox' once (sudo), or 'just shell --no-sandbox'" >&2
      exit 1
    fi
    exec shell/node_modules/.bin/electron shell "$@"

# A systemd user unit bound to the graphical session, after sleeved, waiting up to 20 s for backdrop (which i3
# starts); extra arguments go to the shell, e.g. just install-shell-service --position above
# The overlay at every login (systemd user unit sleeve-shell)
install-shell-service *args:
    #!/usr/bin/env bash
    set -euo pipefail
    binary="$PWD/shell/node_modules/electron/dist/electron"
    [ -x "$binary" ] || { echo "Run just shell-install first" >&2; exit 1; }
    sandbox="shell/node_modules/electron/dist/chrome-sandbox"
    if [[ " {{args}} " != *" --no-sandbox "* ]] && [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] \
      && [ ! -e /etc/apparmor.d/sleeve-electron ] && ! { [ "$(stat -c %u "$sandbox" 2>/dev/null)" = 0 ] && [ -u "$sandbox" ]; }; then
      echo "AppArmor blocks Electron's sandbox here: run 'just shell-sandbox' once (sudo) first, or pass --no-sandbox" >&2
      exit 1
    fi
    unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/sleeve-shell.service"
    mkdir -p "$(dirname "$unit")"
    printf '%s\n' \
      '[Unit]' \
      'Description=sleeve overlay (Electron shell)' \
      'PartOf=graphical-session.target' \
      'After=graphical-session.target sleeved.service' \
      'Wants=sleeved.service' \
      '' \
      '[Service]' \
      "WorkingDirectory=$PWD" \
      "ExecStart=$binary shell --wait-backdrop 20 {{args}}" \
      'Restart=on-failure' \
      'RestartSec=5' \
      '' \
      '[Install]' \
      'WantedBy=graphical-session.target' > "$unit"
    systemctl --user daemon-reload
    echo "Wrote $unit"
    echo "Start it now and with every session: systemctl --user enable --now sleeve-shell"

# Typecheck the shell, when it is installed
shell-typecheck:
    @if [ -d shell/node_modules/electron ]; then npx tsc --noEmit -p shell; else echo "shell not installed; skipping its typecheck"; fi

# Let Electron's sandbox run on Ubuntu (AppArmor blocks the user namespaces it needs): installs a profile, needs sudo
shell-sandbox:
    #!/usr/bin/env bash
    set -euo pipefail
    [ -x shell/node_modules/electron/dist/electron ] || { echo "Run just shell-install first" >&2; exit 1; }
    # Any sleeve checkout's Electron under your home, so a moved checkout or a reinstall keeps working, as Ubuntu's
    # own profiles for Electron apps do (code, slack): unconfined, with the user namespaces the sandbox needs
    printf '%s\n' 'abi <abi/4.0>,' 'include <tunables/global>' '' \
      'profile sleeve-electron @{HOME}/**/shell/node_modules/electron/dist/electron flags=(unconfined) {' '  userns,' \
      '  include if exists <local/sleeve-electron>' '}' \
      | sudo tee /etc/apparmor.d/sleeve-electron >/dev/null
    sudo apparmor_parser -r /etc/apparmor.d/sleeve-electron
    echo "Installed /etc/apparmor.d/sleeve-electron for every sleeve checkout's Electron under your home"

# sleeved's log
logs:
    journalctl --user -u sleeved -f

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
