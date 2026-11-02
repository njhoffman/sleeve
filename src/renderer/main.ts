import type { LyricsResult, ScoredCandidate } from '../core/types.ts';
import type { NowState } from '../now/state.ts';
import { Connection } from './connection.ts';
import { candidateEntries, follow, formatOffset, progress, status, type CandidateEntry } from './view.ts';

// The renderer: sleeved's session as scrolling lyrics. The current line is worked out every frame from the
// mirrored playback clock, so line changes land on the frame they are due whatever the socket does; the scroll
// follows its target with a time constant rather than a CSS transition, so a new target (next line, seek, nudge)
// carries on from where the scroll is instead of restarting.

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

const connection = new Connection(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

let lineElements: HTMLDivElement[] = [];
let centers: number[] = [];
let shownLyrics: ScoredCandidate | null | undefined = undefined;
let shownMessage: string | null = null;
let currentIndex = -2;
let scroll = 0;
let snap = true;
let lastFrame = 0;
let statusText = '';
let entries: CandidateEntry[] = [];

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
  const lyrics = text ? null : best?.lyrics;
  viewport.classList.toggle('unsynced', !!lyrics && !lyrics.synced);
  lineElements = (lyrics?.lines ?? []).map(line => {
    const div = document.createElement('div');
    div.className = line.text.trim() ? 'line' : 'line blank';
    div.textContent = line.text;
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

function mark(index: number): void {
  if (index === currentIndex) return;
  lineElements.forEach((line, at) => {
    line.classList.toggle('current', at === index);
    line.classList.toggle('past', at < index);
  });
  currentIndex = index;
}

function render(now: number): void {
  const dt = lastFrame ? Math.min(now - lastFrame, 250) : 0;
  lastFrame = now;
  const state: NowState = connection.mirror.current();
  const view = status(state, connection.connected);
  const text = `${view.title}\n${view.source}`;
  if (text !== statusText) {
    statusText = text;
    title.textContent = view.title;
    source.textContent = view.source;
  }
  const best = state.result?.best ?? null;
  if (best !== shownLyrics || view.message !== shownMessage) rebuild(best, view.message);

  const anchor = viewport.clientHeight * 0.42;
  let target = 0;
  const lyrics = shownMessage ? null : shownLyrics?.lyrics;
  if (lyrics?.synced && centers.length) {
    const index = connection.mirror.line(now).index;
    mark(index);
    target = anchor - centers[Math.max(0, index)];
  } else if (lyrics && centers.length) {
    // Unsynced: drift through the text as the track plays
    const height = linesBox.offsetHeight;
    const share = progress(connection.mirror.position(now), state.playback?.track?.durationMs);
    target = viewport.clientHeight * 0.2 - share * Math.max(0, height - viewport.clientHeight * 0.6);
  }
  scroll = snap ? target : follow(scroll, target, dt, SCROLL_TAU_MS);
  snap = false;
  linesBox.style.transform = `translate3d(0, ${scroll.toFixed(2)}px, 0)`;
  requestAnimationFrame(render);
}

// Commands

async function nudge(command: { type: 'nudge'; ms: number } | { type: 'offset'; ms: number }): Promise<void> {
  const reply = await connection.send(command);
  if (!reply.ok) return showToast(reply.error ?? 'Failed');
  const { offsetMs } = reply.data as { offsetMs: number };
  showToast(offsetMs ? `Offset ${formatOffset(offsetMs)}` : 'Offset removed');
}

function showEntries(list: CandidateEntry[]): void {
  entries = list.slice(0, 9);
  candidateList.replaceChildren(...entries.map(entry => {
    const item = document.createElement('li');
    item.textContent = entry.label;
    item.classList.toggle('shown', entry.shown);
    item.classList.toggle('rejected', entry.rejected);
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

new ResizeObserver(() => measure()).observe(linesBox);
connection.onConnected(connected => {
  if (!connected) picker.hidden = true;
});
connection.start();
requestAnimationFrame(render);
