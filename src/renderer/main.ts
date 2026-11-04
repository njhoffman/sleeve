import type { LyricLine, LyricsResult, ScoredCandidate, TrackMark } from '../core/types.ts';
import { nextLineTime, wordFill, wordTexts, wordTimings } from '../now/lines.ts';
import type { NowState } from '../now/state.ts';
import { Connection } from './connection.ts';
import { parseHex, textTheme, themeVariables, validColors } from './contrast.ts';
import { CoverFlow } from './flow.ts';
import { candidateEntries, coverColors, displaySettings, flowSettings, flowStep, follow, formatOffset, formatTime, lineStart, lyricsInsets, NO_SCROLL_BACK, nowText, resolveArea, progress, scrollBackOffset, status, wheel, type CandidateEntry, type DisplaySettings, type FlowSettings, type FlowView, type ScrollBack } from './view.ts';

// The renderer: sleeved's session as scrolling lyrics. The current line is worked out every frame from the
// mirrored playback clock, so line changes land on the frame they are due whatever the socket does; the scroll
// follows its target with a time constant rather than a CSS transition, so a new target (next line, seek, nudge)
// carries on from where the scroll is instead of restarting. The wheel scrolls back through the lyrics for a few
// seconds, a click on a line plays from it, and a click picks a candidate in the pick panel; the overlay takes no mouse at all. Outside the overlay
// the track's cover lies behind the lyrics (see #art in style.css for what /user.css can set).

const NUDGE_MS = 100;
const SCROLL_TAU_MS = 110;

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const linesBox = element<HTMLDivElement>('lines');
const viewport = element<HTMLElement>('viewport');
const message = element<HTMLDivElement>('message');
const title = element<HTMLDivElement>('title');
const source = element<HTMLDivElement>('source');
const artistLine = element<HTMLDivElement>('artist');
const albumLine = element<HTMLDivElement>('album');
const nowArt = element<HTMLImageElement>('now-art');
const statusPanel = element<HTMLElement>('status');
const lyricsArea = element<HTMLDivElement>('lyrics-area');
const nowArea = element<HTMLDivElement>('now-area');
const seekBar = element<HTMLDivElement>('seek');
const seekFill = element<HTMLDivElement>('seek-fill');
const elapsedTime = element<HTMLSpanElement>('elapsed');
const totalTime = element<HTMLSpanElement>('total');
const picker = element<HTMLElement>('picker');
const candidateList = element<HTMLOListElement>('candidates');
const help = element<HTMLElement>('help');
const toast = element<HTMLDivElement>('toast');
const art = element<HTMLDivElement>('art');

// ?mode=overlay: drawn over the wallpaper by the Electron shell, with nothing but the lyrics
const overlay = new URLSearchParams(location.search).get('mode') === 'overlay';
// ?words=estimate: fill lines without word times word by word too, their timing estimated from the line's
const estimateWords = new URLSearchParams(location.search).get('words') === 'estimate';
// ?background=none: no cover behind the lyrics, whatever the stylesheets say
const noBackground = new URLSearchParams(location.search).get('background') === 'none';
document.documentElement.classList.toggle('overlay', overlay);

// The Electron shell's one-way channel (shell/preload.cjs): the wallpaper colors behind the overlay, from backdrop
declare global {
  interface Window {
    sleeveShell?: { onColors(listener: (colors: unknown) => void): void };
  }
}
window.sleeveShell?.onColors(value => {
  const colors = validColors(value);
  if (!colors) return;
  for (const [name, setting] of Object.entries(themeVariables(textTheme(colors)))) document.documentElement.style.setProperty(name, setting);
});

// The cover behind the lyrics

const ART_SIZE = 64;
let artKey: string | null | undefined = undefined;

const setting = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const number = (name: string, fallback: number) => {
  const value = Number.parseFloat(setting(name));
  return Number.isFinite(value) ? value : fallback;
};
const artWanted = () => !overlay && !noBackground && setting('--art-background') !== 'off';

function setTheme(variables: Record<string, string> | null): void {
  const names = ['--overlay-text', '--overlay-shadow', '--overlay-shadow-alpha', '--overlay-upcoming-alpha', '--overlay-past-alpha'];
  for (const name of names) {
    if (variables?.[name]) document.documentElement.style.setProperty(name, variables[name]);
    else document.documentElement.style.removeProperty(name);
  }
}

const artFadeMs = () => number('--art-fade', 900) * (setting('--art-fade').endsWith('ms') ? 1 : 1000);

// Fades the layers out and away; the newest stays when keep is given
function fadeArt(keep: HTMLCanvasElement | null = null): void {
  const fadeMs = artFadeMs();
  for (const layer of art.querySelectorAll<HTMLCanvasElement>('canvas:not(.flow)')) {
    if (layer === keep) continue;
    layer.classList.remove('shown');
    window.setTimeout(() => layer.remove(), fadeMs + 100);
  }
}

function clearArt(): void {
  fadeArt();
  latestCover = null;
  flow?.forgetCover();
  document.documentElement.classList.remove('art');
  setTheme(null);
}

// The cover drawn small and blurred (cropped to a square), faded in over the last, and the text colored for it
function showArt(image: HTMLImageElement): void {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ART_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return;
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  const blur = number('--art-blur', 6);
  // Drawn a little past the edges, so the blur does not fade them to transparent
  const margin = blur * 2;
  context.filter = blur > 0 ? `blur(${blur}px)` : 'none';
  context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, -margin, -margin, ART_SIZE + 2 * margin, ART_SIZE + 2 * margin);
  art.append(canvas);
  requestAnimationFrame(() => canvas.classList.add('shown'));
  fadeArt(canvas);
  document.documentElement.classList.add('art');
  latestCover = canvas;
  if (flowOn) flow?.setCover(canvas, performance.now(), artFadeMs());
  const base = parseHex(setting('--bg')) ?? [15, 18, 24];
  const colors = coverColors(context.getImageData(0, 0, ART_SIZE, ART_SIZE).data, { opacity: number('--art-opacity', 0.6), dim: number('--art-dim', 0.45), base });
  setTheme(themeVariables(textTheme(colors)));
}

function updateArt(state: NowState): void {
  // The overlay's colors come from the wallpaper (the shell), never from a cover
  if (overlay) return;
  const key = state.playback?.track?.key ?? null;
  if (key === artKey) return;
  artKey = key;
  if (!key || !artWanted()) return clearArt();
  const image = new Image();
  image.onload = () => { if (artKey === key) showArt(image); };
  image.onerror = () => { if (artKey === key) clearArt(); };
  image.src = `/art/current?key=${encodeURIComponent(key)}`;
}

// --art-animation: sleeve-art-flow, and its settings read about once a second, so an edit to the stylesheet shows
// without a reload. The WebGL context is only made once it is wanted.

const SETTINGS_READ_MS = 1000;
let flow: CoverFlow | null = null;
let flowOn = false;
let latestCover: HTMLCanvasElement | null = null;
let flowTarget: FlowSettings | null = null;
let flowView: FlowView | null = null;
let settingsReadAt = -Infinity;

function readFlow(now: number): void {
  const wanted = artWanted() && setting('--art-animation').split(',')[0].trim() === 'sleeve-art-flow';
  if (wanted) flow ??= new CoverFlow(art);
  const on = wanted && !!flow?.available;
  if (on && !flowOn && latestCover) flow!.setCover(latestCover, now, 0);
  flowOn = on;
  document.documentElement.classList.toggle('flow', on);
  flowTarget = on ? flowSettings(setting) : null;
  if (flowTarget) flowView ??= { ...flowTarget, phase: 0 };
}

function updateFlow(now: number, dt: number): void {
  if (overlay) return;
  if (!flowOn || !flowTarget || !flowView || !document.documentElement.classList.contains('art')) return;
  flowView = flowStep(flowView, flowTarget, dt);
  flow!.draw(now, flowView);
}

// The now-playing panel and the lyrics' alignment, read as often as the flow's settings

const pageParams = new URLSearchParams(location.search);
const instance = pageParams.get('instance');
let display: DisplaySettings | null = null;
let displaysSeen = 0;
let thumbnailKey: string | null | undefined = undefined;
let shownTimes = '';

function readDisplay(): void {
  const next = displaySettings(setting, pageParams, overlay, connection.mirror.displayFor(instance));
  if (display && next.preset === display.preset && next.position === display.position && next.align === display.align && next.lyricsArea === display.lyricsArea && next.nowArea === display.nowArea && next.visible === display.visible) return;
  if (display && !display.visible && next.visible) snap = true;
  display = next;
  document.documentElement.classList.toggle('page-hidden', !next.visible);
  const { dataset } = document.documentElement;
  dataset.now = next.preset;
  dataset.nowPosition = next.position;
  dataset.lyricsAlign = next.align;
  statusText = '';
  thumbnailKey = undefined;
  placeAreas();
}

function placeAreas(): void {
  if (!display) return;
  const size = { width: innerWidth, height: innerHeight };
  for (const [box, area] of [[lyricsArea, display.lyricsArea], [nowArea, display.nowArea]] as const) {
    const rect = resolveArea(area, size);
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  }
  reservePanel();
}
addEventListener('resize', () => placeAreas());

// Keeps the lyrics clear of the panel
function reservePanel(): void {
  if (!display) return;
  const rect = display.preset === 'lyrics' ? null : statusPanel.getBoundingClientRect();
  const insets = lyricsInsets(display.position, rect, resolveArea(display.lyricsArea, { width: innerWidth, height: innerHeight }));
  const { style } = document.documentElement;
  style.setProperty('--reserve-top', `${insets.top}px`);
  style.setProperty('--reserve-right', `${insets.right}px`);
  style.setProperty('--reserve-bottom', `${insets.bottom}px`);
  style.setProperty('--reserve-left', `${insets.left}px`);
}

function updateThumbnail(key: string | null): void {
  if (key === thumbnailKey) return;
  thumbnailKey = key;
  nowArt.hidden = true;
  nowArt.removeAttribute('src');
  if (key) nowArt.src = `/art/current?key=${encodeURIComponent(key)}`;
}
nowArt.addEventListener('load', () => { nowArt.hidden = false; });
nowArt.addEventListener('error', () => { nowArt.hidden = true; });

function updateProgress(state: NowState, now: number): void {
  const position = connection.mirror.position(now);
  const duration = state.playback?.track?.durationMs;
  seekFill.style.transform = `scaleX(${progress(position, duration).toFixed(4)})`;
  const elapsed = state.playback?.track ? formatTime(position) : '';
  const total = formatTime(duration);
  const times = `${elapsed}/${total}`;
  if (times === shownTimes) return;
  shownTimes = times;
  elapsedTime.textContent = elapsed;
  totalTime.textContent = total;
}

// ~/.config/sleeve/style.css applied when it changes, asked for every few seconds. Its text replaces the link in place,
// so nothing flashes, and the cover is drawn again, for its blur and for the text's colors over it.

const USER_CSS_POLL_MS = 2000;
let userCssText: string | null = null;
let userStyle: HTMLStyleElement | null = null;

async function checkUserCss(): Promise<void> {
  try {
    const response = await fetch('/user.css', { cache: 'no-store' });
    if (!response.ok) return;
    const text = await response.text();
    if (userCssText !== null && text !== userCssText) {
      if (!userStyle) {
        userStyle = document.createElement('style');
        const link = document.querySelector('link[href="/user.css"]');
        link?.after(userStyle);
        link?.remove();
      }
      userStyle.textContent = text;
      settingsReadAt = -Infinity;
      artKey = undefined;
    }
    userCssText = text;
  } catch {
    // sleeved is away: the next try will do
  }
}

const connection = new Connection(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

let lineElements: HTMLDivElement[] = [];
// Per line, its word elements when it is filled word by word (empty otherwise), and the fill last set on each
let wordElements: HTMLSpanElement[][] = [];
let wordFills: number[] = [];
let centers: number[] = [];
let shownLyrics: ScoredCandidate | null | undefined = undefined;
let shownMessage: string | null = null;
let currentIndex = -2;
let scroll = 0;
let snap = true;
let lastFrame = 0;
let back: ScrollBack = NO_SCROLL_BACK;
// Where playback puts the lyrics, and the anchor line's place, last frame: what the wheel scrolls from
let playbackTarget = 0;
let anchorY = 0;
let statusText = '';
let entries: CandidateEntry[] = [];
// The offset last seen for the lyrics shown, to say when it changes (from any client: this page, sleeve ctl)
let seenOffset: { best: ScoredCandidate | null; offsetMs: number } = { best: null, offsetMs: 0 };

function showToast(text: string): void {
  toast.textContent = text;
  toast.classList.add('visible');
  clearTimeout((showToast as unknown as { timer?: number }).timer);
  (showToast as unknown as { timer?: number }).timer = window.setTimeout(() => toast.classList.remove('visible'), 1600);
}

function measure(): void {
  centers = lineElements.map(line => line.offsetTop + line.offsetHeight / 2);
}

// The lines for what is shown now; nothing when a message stands in for them
function rebuild(best: ScoredCandidate | null, text: string | null): void {
  shownLyrics = best;
  shownMessage = text;
  currentIndex = -2;
  snap = true;
  back = NO_SCROLL_BACK;
  const lyrics = text ? null : best?.lyrics;
  viewport.classList.toggle('unsynced', !!lyrics && !lyrics.synced);
  const lines = lyrics?.lines ?? [];
  wordElements = lines.map(line => lyrics?.synced && (line.words?.length || estimateWords) ? wordTexts(line).map(() => document.createElement('span')) : []);
  wordFills = [];
  lineElements = lines.map((line, at) => {
    const div = document.createElement('div');
    div.className = line.text.trim() ? 'line' : 'line blank';
    if (wordElements[at].length) {
      div.classList.add('worded');
      div.append(...wordNodes(line, wordElements[at]));
    } else {
      div.textContent = line.text;
    }
    if (line.translation) {
      const translation = document.createElement('span');
      translation.className = 'translation';
      translation.textContent = line.translation;
      div.append(translation);
    }
    return div;
  });
  linesBox.replaceChildren(...lineElements);
  message.textContent = text ?? '';
  measure();
}

// A word drawn twice: the line's color underneath, and a full-color copy over it clipped to how much is sung
// (--fill), so the fill sweeps through the word while its shadow stays whole underneath
function wordNodes(line: LyricLine, elements: HTMLSpanElement[]): Node[] {
  return wordTexts(line).flatMap((text, at) => {
    const word = text.trimEnd();
    const element = elements[at];
    element.className = 'word';
    const fill = document.createElement('span');
    fill.className = 'fill';
    fill.setAttribute('aria-hidden', 'true');
    fill.textContent = word;
    element.append(word, fill);
    return text.length > word.length ? [element, document.createTextNode(' ')] : [element];
  });
}

// Each word of the current line filled as far as it is sung at positionMs
function fillWords(state: NowState, index: number, positionMs: number): void {
  const line = state.result?.best?.lyrics.lines[index];
  const elements = wordElements[index];
  if (!line || !elements?.length) return;
  const timings = wordTimings(line, state.result!.offsetMs, nextLineTime(state.result, positionMs));
  timings.forEach((timing, at) => {
    const fill = Math.round(wordFill(timing, positionMs) * 1000) / 1000;
    if (wordFills[at] === fill || !elements[at]) return;
    wordFills[at] = fill;
    elements[at].style.setProperty('--fill', String(fill));
  });
}

function mark(index: number): void {
  if (index === currentIndex) return;
  lineElements.forEach((line, at) => {
    line.classList.toggle('current', at === index);
    line.classList.toggle('past', at < index);
  });
  wordFills = [];
  currentIndex = index;
}

function render(now: number): void {
  const dt = lastFrame ? Math.min(now - lastFrame, 250) : 0;
  lastFrame = now;
  const state: NowState = connection.mirror.current();
  if (now - settingsReadAt >= SETTINGS_READ_MS || connection.mirror.displaysSeen !== displaysSeen) {
    settingsReadAt = now;
    displaysSeen = connection.mirror.displaysSeen;
    readDisplay();
    if (!overlay) readFlow(now);
  }
  // Told to hide by whatever places this page: nothing to draw until it shows again
  if (!display!.visible) {
    requestAnimationFrame(render);
    return;
  }
  updateArt(state);
  updateFlow(now, dt);
  const view = status(state, connection.connected);
  const shown = nowText(state, display!.preset, view.title);
  const text = `${shown.title}\n${shown.artist}\n${shown.album}\n${view.source}`;
  if (text !== statusText) {
    statusText = text;
    title.textContent = shown.title;
    artistLine.textContent = shown.artist;
    albumLine.textContent = shown.album;
    source.textContent = view.source;
  }
  if (display!.preset === 'full') {
    updateThumbnail(state.playback?.track?.key ?? null);
    updateProgress(state, now);
  }
  const best = state.result?.best ?? null;
  if (best !== shownLyrics || view.message !== shownMessage) rebuild(best, view.message);
  const offsetMs = state.result?.offsetMs ?? 0;
  if (best && best === seenOffset.best && offsetMs !== seenOffset.offsetMs) showToast(offsetMs ? `Offset ${formatOffset(offsetMs)}` : 'Offset removed');
  seenOffset = { best, offsetMs };

  const anchor = viewport.clientHeight * (overlay ? 0.5 : 0.42);
  let target = 0;
  const lyrics = shownMessage ? null : shownLyrics?.lyrics;
  if (lyrics?.synced && centers.length) {
    const position = connection.mirror.position(now);
    const index = connection.mirror.line(now).index;
    mark(index);
    if (index >= 0) fillWords(state, index, position);
    target = anchor - centers[Math.max(0, index)];
  } else if (lyrics && centers.length) {
    // Unsynced: drift through the text as the track plays
    const height = linesBox.offsetHeight;
    const share = progress(connection.mirror.position(now), state.playback?.track?.durationMs);
    target = viewport.clientHeight * 0.2 - share * Math.max(0, height - viewport.clientHeight * 0.6);
  }
  playbackTarget = target;
  anchorY = anchor;
  target += scrollBackOffset(back, now);
  scroll = snap ? target : follow(scroll, target, dt, SCROLL_TAU_MS);
  snap = false;
  linesBox.style.transform = `translate3d(0, ${scroll.toFixed(2)}px, 0)`;
  requestAnimationFrame(render);
}

// Commands

async function nudge(command: { type: 'nudge'; ms: number } | { type: 'offset'; ms: number }): Promise<void> {
  // Success shows as the offset changing (render), as it does for a nudge from anywhere else
  const reply = await connection.send(command);
  if (!reply.ok) showToast(reply.error ?? 'Failed');
}

function showEntries(list: CandidateEntry[]): void {
  entries = list.slice(0, 9);
  candidateList.replaceChildren(...entries.map(entry => {
    const item = document.createElement('li');
    item.textContent = entry.label;
    item.classList.toggle('shown', entry.shown);
    item.classList.toggle('rejected', entry.rejected);
    item.addEventListener('click', () => void pick(entry));
    return item;
  }));
  if (!entries.length) {
    const item = document.createElement('li');
    item.className = 'loading';
    item.textContent = 'No candidates';
    candidateList.replaceChildren(item);
  }
}

async function openPicker(): Promise<void> {
  help.hidden = true;
  picker.hidden = false;
  entries = [];
  const waiting = document.createElement('li');
  waiting.className = 'loading';
  waiting.textContent = 'Asking every provider';
  candidateList.replaceChildren(waiting);
  const reply = await connection.send({ type: 'candidates' });
  if (picker.hidden) return;
  if (!reply.ok) {
    waiting.textContent = reply.error ?? 'Failed';
    return;
  }
  showEntries(candidateEntries(reply.data as LyricsResult, connection.mirror.current().result?.best ?? null));
}

async function pick(entry: CandidateEntry): Promise<void> {
  picker.hidden = true;
  showToast(`Picking ${entry.ref}`);
  const reply = await connection.send({ type: 'pick', ref: entry.ref });
  showToast(reply.ok ? `Picked ${entry.ref}` : reply.error ?? 'Failed');
}

async function markTrack(which: TrackMark): Promise<void> {
  picker.hidden = true;
  const reply = await connection.send({ type: 'mark', mark: which });
  showToast(reply.ok ? (which === 'none' ? 'Marked: no correct lyrics' : 'Marked: instrumental') : reply.error ?? 'Failed');
}

async function simple(type: 'refresh' | 'unpick', done: (data: unknown) => string): Promise<void> {
  if (type === 'refresh') showToast('Looking it up again');
  const reply = await connection.send({ type });
  showToast(reply.ok ? done(reply.data) : reply.error ?? 'Failed');
}

element<HTMLElement>('mark-none').addEventListener('click', () => void markTrack('none'));
element<HTMLElement>('mark-instrumental').addEventListener('click', () => void markTrack('instrumental'));

document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key;
  if (!picker.hidden) {
    if (key === 'Escape' || key === 'p') picker.hidden = true;
    else if (/^[1-9]$/.test(key) && entries[Number(key) - 1]) void pick(entries[Number(key) - 1]);
    else if (key === 'n') void markTrack('none');
    else if (key === 'i') void markTrack('instrumental');
    else if (key === 'u') {
      picker.hidden = true;
      void simple('unpick', data => (data as { removed: boolean }).removed ? 'Back to the ranking' : 'No pick for this track');
    } else return;
    event.preventDefault();
    return;
  }
  if (key === '+' || key === '=') void nudge({ type: 'nudge', ms: NUDGE_MS });
  else if (key === '-' || key === '_') void nudge({ type: 'nudge', ms: -NUDGE_MS });
  else if (key === '0') void nudge({ type: 'offset', ms: 0 });
  else if (key === 'p') void openPicker();
  else if (key === 'r') void simple('refresh', () => 'Looked up again');
  else if (key === '?') help.hidden = !help.hidden;
  else if (key === 'Escape') help.hidden = true;
  else return;
  event.preventDefault();
});

// A click on the seek bar plays from there
seekBar.addEventListener('click', event => {
  const duration = connection.mirror.current().playback?.track?.durationMs;
  if (overlay || !duration) return;
  const bar = seekBar.getBoundingClientRect();
  const ms = Math.round(Math.min(1, Math.max(0, (event.clientX - bar.left) / bar.width)) * duration);
  void connection.send({ type: 'seek', ms }).then(reply => {
    if (!reply.ok) showToast(reply.error ?? 'Failed');
  });
});

// A click on a line plays from it, and the view returns to playback. Dragging over text to select it does not count.
linesBox.addEventListener('click', event => {
  if (overlay || !picker.hidden || !getSelection()?.isCollapsed) return;
  const line = (event.target as Element).closest('.line');
  const ms = lineStart(shownMessage ? undefined : shownLyrics?.lyrics.lines[lineElements.indexOf(line as HTMLDivElement)], connection.mirror.current().result?.offsetMs ?? 0);
  if (ms === null) return;
  back = NO_SCROLL_BACK;
  void connection.send({ type: 'seek', ms }).then(reply => {
    if (!reply.ok) showToast(reply.error ?? 'Failed');
  });
});

// The wheel scrolls back (or on) through the lyrics, as far as the first and last line
viewport.addEventListener('wheel', event => {
  if (overlay || !centers.length || !picker.hidden) return;
  event.preventDefault();
  const synced = !shownMessage && shownLyrics?.lyrics.synced;
  // Synced: a line at the anchor at either end; unsynced: the text's top and bottom within the view
  const min = synced ? anchorY - centers.at(-1)! - playbackTarget : -linesBox.offsetHeight - playbackTarget + viewport.clientHeight * 0.6;
  const max = synced ? anchorY - centers[0] - playbackTarget : viewport.clientHeight * 0.2 - playbackTarget;
  back = wheel(back, event.deltaY, event.deltaMode, performance.now(), Math.min(min, 0), Math.max(max, 0));
}, { passive: false });

const resized = new ResizeObserver(() => {
  reservePanel();
  measure();
});
for (const box of [linesBox, viewport, statusPanel]) resized.observe(box);
connection.onConnected(connected => {
  if (!connected) picker.hidden = true;
});
connection.start();
void checkUserCss();
window.setInterval(() => void checkUserCss(), USER_CSS_POLL_MS);
requestAnimationFrame(render);
