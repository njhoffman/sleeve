# Running under backdrop

The contract for running sleeve as a backdrop visualizer engine, the wallpaper layer included (`--lyrics-area`, `--now-area`, `--background`,
`--map-below`), is in `~/git/backdrop/docs/specs/sleeve.md`. A change to any of it goes there first, with a version note in both CHANGELOGs.

One thing from that contract that is easy to break from this side: backdrop's `background: auto` arrives as plain `#rrggbbaa` over `sleeve ctl display`, for most new wallpapers, so changing the background has to
stay cheap. backdrop no longer resizes the window (since 2.50.7), now that sleeve 0.39.2 sizes it exactly.
