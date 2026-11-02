### sleeve lyrics viewer

- this project is based on Sunamu `(~/git/Sunamu)` and my attempted fork `(~/git/lyricist)` since the original
  maintainer has left the project
- i want to start from scratch and reconsider the tech stack
- the main things i want (but not limited to):
  - a way to query time-associated lyrics from several sources for a song
    - that song could be playing in mpd or spotify
    - it could be part of a process that adds the lyrics to the id3 tags of multiple songs
  - a way to display the lyrics in a normal window or as a background overlay
  - sunamu takes the album artwork and does animating css transformations to it for display behind the lyrics
    - want to be able to do this and change the specs of the animation seamlessly
  - sunamu colors the lyrics to stand out from whatever the background color is
- i'm using a program i made called backdrop, ~/git/backdrop, that is already handling wallpaper and glava
- having a version that works in web would be nice too at least just for testing visualizations on the root window. i
  figured this deserved it's own project but i want it integrated with this
- go through the Sunamu code and identify other features that we may want to use
  - look at lyricist to see my changes
  - determine if we should still use typescript, electron, etc
- first things i would like to work on after we plan the stack is lyrics fetching
- after we decide on the stack, create TODOs for the remaining features, including suggestions you have
