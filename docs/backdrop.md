# Running as backdrop's wallpaper layer

Proposed 2026-11-04, not built yet. backdrop runs sleeve as a visualizer engine under the contract in
`~/git/backdrop/docs/specs/sleeve.md` (`sleeve shell --managed`, `sleeve ctl display`, shipped in 0.33.0). That contract
assumes the window and the page are the same size. This note asks for what it takes to separate them. Add to the
options below freely; once shipped, changing or removing one needs a version note in both CHANGELOGs, as for the rest.

## The ways the user runs it

They want to choose between these, sometimes on the same day, so none replaces the others:

1. **In its own window over the wallpaper.** A window about the size of the lyrics, over mpv's wallpaper. This works today.
2. **As the backdrop itself.** The window takes the whole monitor, and the lyrics take only part of it, for example
   the left third. The rest is left for GLava and whatever else the user thinks of, which backdrop stacks above it.
3. **As a layer between the two.** mpv's wallpaper at the back, sleeve over the whole monitor with a see-through
   background, and GLava on top of sleeve. The wallpaper shows through sleeve's background while the lyrics stay solid.

The last two need sleeve to be told: "your window is all of this, but put the lyrics only here." The third also needs
the background's transparency apart from the text's. backdrop already stacks any order the user lists, with each
window's opacity, so none of this asks sleeve to know what is above or below it.

## The model: areas inside the window

`--geometry` stays where the window is. New options say where content goes inside it. sleeve never needs to know what
fills the rest, so a new neighbour on the desktop asks nothing more of it.

| Option on `sleeve shell` | `sleeve ctl display` | Meaning |
| --- | --- | --- |
| `--lyrics-area AREA` | `--lyrics-area AREA` | where the lyrics lay out and wrap; default the whole window |
| `--now-area AREA` | `--now-area AREA` | the area the now-playing panel stands in, `--now-position` placing it inside; default the whole window |
| `--background BG` | `--background BG` | what fills the window behind the content; default `transparent` |
| `--map-below` | none | see Stacking |

- `AREA` is `WxH+X+Y` relative to the window, each part pixels or a percentage of the window: `33%x100%+0+0` is the left
  third, `67%x100%+33%+0` the rest.
- `BG` is `transparent`, `#rrggbb`, `#rrggbbaa`, or `cover` (the current track's cover, as window mode draws it), with
  `cover@0.6` for a cover at that opacity. The alpha applies to the background alone: text and the panel stay solid.
  `_NET_WM_WINDOW_OPACITY`, which backdrop sets, fades the whole window, so it cannot do this.
- The same fields go over the socket, as `lyricsArea`, `nowArea` and `background` on the `display` command, with the
  instance rules and `--reset` as they are for `preset`, `position` and `align` now.

Behaviour to hold to:

- Nothing but the background paints outside the areas. Text wraps and sizes to its area, not the window, so a left third
  looks like a window that size rather than a clipped full-width layout.
- When both areas are the default, or overlap, the lyrics keep clear of the panel as they do now. Apart, they ignore it.
- An area partly outside the window is clipped to it. One with no size, or a form it cannot read, is a bad option:
  status 2 at the start and status 1 from `ctl`, naming the value, as for other values.
- Any geometry works, including one spanning monitors. backdrop will normally run one window per monitor rather than cover
  the whole X root, but that is its choice.
- `--hide` hides the lyrics and the panel and keeps the background, since on an opaque window that background is the
  wallpaper. A `transparent` window still draws nothing while hidden, as promised today.

## Stacking

backdrop still owns stacking; sleeve still never restacks once running, and marks nothing. The one change comes from the
window now being able to cover a monitor and be opaque: a window mapped on top hides every other window until backdrop
finds and places it, about 2 s later.

`--map-below` asks sleeve to map the window at the bottom of the stack, once, as GLava does for itself. backdrop then
places it from there. Without the option nothing changes.

## Colors

The stdin line is unchanged. With a transparent background it describes what shows behind the window, and backdrop will
sample the strip under `--lyrics-area` rather than the whole window, or the left third would get colors from the
entire monitor. With an opaque background sleeve should pick text colors against its own background and ignore the
line; it is free to keep reading it. With a see-through background the text sits on a blend, so pick against the
background composited over the line's colors at that alpha. GLava above sleeve does not affect any of this.

## Cost

A full-monitor transparent window costs the compositor more than a small one, and that cost runs all day. Worth
measuring on Iris Xe when this is built, as the 2 s start was, and repainting only the areas if it matters. Note the
figures in the contract.

## What backdrop does once this ships

Typed `visualizer.sleeve` settings for the areas and background (per instance), live changes over `sleeve ctl display`, a
version check so an older sleeve is reported rather than exiting 2 on an unknown option, and the colors above. Its own
half is tracked in `TODO.md`, section 9, in backdrop.

Examples of what the user would configure there. The lyrics as the backdrop and bars beside them, no mpv wallpaper:

```yaml
visualizer:
  enabled: true
  instances:
    - name: lyrics
      engine: sleeve
      opacity: 1
      placement: {anchor: fill}
      sleeve: {lyrics_area: 33%x100%+0+0, background: cover}
    - name: bars
      module: bars
      rect: {x: 33%, y: 0, width: 67%, height: 100%}
```

The wallpaper at the back, sleeve over it, GLava on top (list order is stacking order, first lowest):

```yaml
visualizer:
  enabled: true
  instances:
    - name: lyrics
      engine: sleeve
      opacity: 1
      placement: {anchor: fill}
      sleeve: {lyrics_area: 33%x100%+0+0, background: '#10203099'}
    - name: bars
      module: bars
      placement: {anchor: bottom, width: 100%, height: 25%}
```

## Open questions for this side

- Does `cover` mean the plain cover, or the blurred treatment window mode uses? Whichever looks right at full monitor.
