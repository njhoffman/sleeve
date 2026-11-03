import type { LyricLine, LyricsResult, ScoredCandidate } from '../core/types.ts';
import { nextLineTime, wordFill, wordTexts, wordTimings } from '../now/lines.ts';
import type { NowState } from '../now/state.ts';
import { Connection } from './connection.ts';
import { parseHex, textTheme, themeVariables, validColors } from './contrast.ts';
import { candidateEntries, coverColors, follow, formatOffset, NO_SCROLL_BACK, progress, scrollBackOffset, status, wheel, type CandidateEntry, type ScrollBack } from './view.ts';

// The renderer: sleeved's session as scrolling lyrics. The current line is worked out every frame from the
// mirrored playback clock, so line changes land on the frame they are due whatever the socket does; the scroll
// follows its target with a time constant rather than a CSS transition, so a new target (next line, seek, nudge)
// carries on from where the scroll is instead of restarting. The wheel scrolls back through the lyrics for a few
// seconds, and a click picks a candidate in the pick panel; the overlay takes no mouse at all. Outside the overlay
// the track's cover lies behind the lyrics (see #art in style.css for what /user.css can set).

const NUDGE_MS = 100;
const SCROLL_TAU_MS = 110;

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const linesBox = element<HTMLDivElement>('lines');
const viewport = element<HTMLElement>('viewport');
const message = element<HTMLDivElement>('message');
const title = element<HTMLDivElement>('title');
const source = element<HTMLDivElement>('source');
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

// Fades the layers out and away; the newest stays when keep is given
function fadeArt(keep: HTMLCanvasElement | null = null): void {
  const fadeMs = number('--art-fade', 900) * (setting('--art-fade').endsWith('ms') ? 1 : 1000);
  for (const layer of art.querySelectorAll('canvas')) {
    if (layer === keep) continue;
    layer.classList.remove('shown');
    window.setTimeout(() => layer.remove(), fadeMs + 100);
  }
}

function clearArt(): void {
  fadeArt();
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
  updateArt(state);
  const view = status(state, connection.connected);
  const text = `${view.title}\n${view.source}`;
  if (text !== statusText) {
    statusText = text;
    title.textContent = view.title;
    source.textContent = view.source;
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

async function simple(type: 'refresh' | 'unpick', done: (data: unknown) => string): Promise<void> {
  if (type === 'refresh') showToast('Looking it up again');
  const reply = await connection.send({ type });
  showToast(reply.ok ? done(reply.data) : reply.error ?? 'Failed');
}

document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key;
  if (!picker.hidden) {
    if (key === 'Escape' || key === 'p') picker.hidden = true;
    else if (/^[1-9]$/.test(key) && entries[Number(key) - 1]) void pick(entries[Number(key) - 1]);
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

new ResizeObserver(() => measure()).observe(linesBox);
connection.onConnected(connected => {
  if (!connected) picker.hidden = true;
});
connection.start();
requestAnimationFrame(render);
