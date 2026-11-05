# Running under backdrop

The contract for running sleeve as a backdrop visualizer engine, the wallpaper layer included (`--lyrics-area`, `--now-area`, `--background`,
`--map-below`), is in `~/git/backdrop/docs/specs/sleeve.md`. A change to any of it goes there first, with a version note in both CHANGELOGs.

Two things from that contract that are easy to break from this side: backdrop resizes a `--managed` window with `xdotool windowsize` once it finds it, because a window the size of its monitor comes out 1 px short
(see `TODO.md`), so the layout has to follow a resize; and backdrop's `background: auto` arrives as plain `#rrggbbaa` over `sleeve ctl display`, for most new wallpapers, so changing the background has to stay cheap.
