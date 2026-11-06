import { stripVTControlCharacters, styleText } from 'node:util';

// How the commands look in a terminal: color, aligned tables, shortened paths and gradient bars. Everything here goes by
// what a stream can show, and a stream that is not a terminal gets PLAIN, so what scripts read stays as it always was. NO_COLOR
// takes the color away and leaves the layout; FORCE_COLOR turns all of it on, even down a pipe.
//
// Text uses the terminal's own 16 colors, so it follows the theme. Only the bars need more, for their gradient, and they
// step down to one color where the terminal has fewer.

export type Depth = 1 | 4 | 8 | 24;

export interface StreamStyle {
  // Aligned tables, bars and the like, rather than the plain form
  rich: boolean;
  // A real terminal, which a line can be redrawn on
  tty: boolean;
  depth: Depth;
  columns: number | null;
}

export const PLAIN: StreamStyle = { rich: false, tty: false, depth: 1, columns: null };

interface StyledStream {
  isTTY?: boolean;
  columns?: number;
  getColorDepth?: (env?: NodeJS.ProcessEnv) => number;
}

function forcedDepth(value: string): Depth {
  return value === '3' ? 24 : value === '2' ? 8 : 4;
}

export function streamStyle(stream: StyledStream, env: NodeJS.ProcessEnv = process.env): StreamStyle {
  const tty = Boolean(stream.isTTY);
  const columns = tty && stream.columns ? stream.columns : null;
  const forced = env.FORCE_COLOR;
  if (forced !== undefined && forced !== '' && forced !== '0' && forced !== 'false') return { rich: true, tty, columns, depth: forcedDepth(forced) };
  if (!tty) return PLAIN;
  if (env.NO_COLOR || forced === '0' || forced === 'false') return { rich: true, tty, columns, depth: 1 };
  const depth = stream.getColorDepth?.(env) ?? 4;
  return { rich: true, tty, columns, depth: depth >= 24 ? 24 : depth >= 8 ? 8 : depth >= 4 ? 4 : 1 };
}

export type Painter = (text: string) => string;
export interface Paint {
  bold: Painter; dim: Painter; red: Painter; green: Painter; yellow: Painter; blue: Painter; cyan: Painter; magenta: Painter;
}

const STYLES = ['bold', 'dim', 'red', 'green', 'yellow', 'blue', 'cyan', 'magenta'] as const;

export function paint(style: StreamStyle): Paint {
  const color = style.depth > 1;
  return Object.fromEntries(STYLES.map(name => [name, (text: string) => color ? styleText(name, text, { validateStream: false }) : text])) as unknown as Paint;
}

const segmenter = new Intl.Segmenter();
const characters = (text: string) => Array.from(segmenter.segment(text), part => part.segment);

// Columns the text takes, leaving out its color codes
export function visibleWidth(text: string): number {
  return characters(stripVTControlCharacters(text)).length;
}

export function truncate(text: string, width: number): string {
  const parts = characters(text);
  return parts.length <= width ? text : `${parts.slice(0, Math.max(0, width - 1)).join('')}…`;
}

export function pad(text: string, width: number, right = false): string {
  const space = ' '.repeat(Math.max(0, width - visibleWidth(text)));
  return right ? `${space}${text}` : `${text}${space}`;
}

export type Cell = string | { text: string; style: Painter };

export interface TableOptions {
  // Columns aligned to the right
  right?: number[];
  // The column that gives way when a row would not fit the terminal
  flex?: number;
  columns?: number | null;
  gap?: number;
}

// Rows in aligned columns, the last with no padding after it
export function table(rows: Cell[][], { right = [], flex, columns = null, gap = 2 }: TableOptions = {}): string[] {
  if (!rows.length) return [];
  const text = (cell: Cell | undefined) => (cell === undefined ? '' : typeof cell === 'string' ? cell : cell.text);
  const count = Math.max(...rows.map(row => row.length));
  const widths = Array.from({ length: count }, (_, column) => Math.max(...rows.map(row => visibleWidth(text(row[column])))));
  if (flex !== undefined && columns) {
    const total = widths.reduce((sum, width) => sum + width, 0) + gap * (count - 1);
    if (total > columns) widths[flex] = Math.max(12, widths[flex] - (total - columns));
  }
  return rows.map(row => row.map((cell, column) => {
    const shown = column === flex ? truncate(text(cell), widths[column]) : text(cell);
    const styled = typeof cell === 'string' ? shown : cell.style(shown);
    return column === row.length - 1 && !right.includes(column) ? styled : pad(styled, widths[column], right.includes(column));
  }).join(' '.repeat(gap)));
}

// A file's path in at most width columns, the name whole and the middle of its directories left out
export function shortenPath(file: string, width: number): string {
  if (visibleWidth(file) <= width) return file;
  const parts = file.split('/');
  const name = parts.pop()!;
  const fits = (shortened: string) => visibleWidth(shortened) <= width;
  if (parts.length >= 2) {
    const both = `${parts[0]}/…/${parts.at(-1)}/${name}`;
    if (fits(both)) return both;
    const last = `…/${parts.at(-1)}/${name}`;
    if (fits(last)) return last;
  }
  return parts.length ? `…/${name}` : name;
}

// The directories dim, the name as it is
export function stylePath(file: string, paints: Paint): string {
  const slash = file.lastIndexOf('/');
  return slash < 0 ? file : `${paints.dim(file.slice(0, slash + 1))}${file.slice(slash + 1)}`;
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
// Blue through sky to green
const GRADIENT: Array<[number, number, number]> = [[66, 112, 232], [56, 189, 248], [62, 214, 155]];

function gradientAt(position: number): [number, number, number] {
  const scaled = Math.min(1, Math.max(0, position)) * (GRADIENT.length - 1);
  const index = Math.min(GRADIENT.length - 2, Math.floor(scaled));
  const within = scaled - index;
  return GRADIENT[index].map((value, channel) => Math.round(value + (GRADIENT[index + 1][channel] - value) * within)) as [number, number, number];
}

function cellColor(position: number, depth: Depth): string {
  const [red, green, blue] = gradientAt(position);
  if (depth === 24) return `\u001b[38;2;${red};${green};${blue}m`;
  if (depth === 8) {
    const level = (value: number) => Math.round((value / 255) * 5);
    return `\u001b[38;5;${16 + 36 * level(red) + 6 * level(green) + level(blue)}m`;
  }
  return depth === 4 ? '\u001b[36m' : '';
}

// A bar exactly width columns wide, its color running along the whole width so how far it got shows in its last color. Empty
// cells are dim shade; without color, the block characters still tell the fill from the track.
export function gradientBar(fraction: number, width: number, depth: Depth): string {
  const filled = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  const eighths = Math.round(filled * width * 8);
  const whole = Math.floor(eighths / 8);
  const partial = EIGHTHS[eighths % 8];
  const color = depth > 1;
  let bar = '';
  for (let cell = 0; cell < whole; cell++) bar += `${cellColor(width > 1 ? cell / (width - 1) : 1, depth)}█`;
  if (partial) bar += `${cellColor(width > 1 ? whole / (width - 1) : 1, depth)}${partial}`;
  if (color && bar) bar += '\u001b[39m';
  const rest = width - whole - (partial ? 1 : 0);
  if (rest > 0) bar += color ? `\u001b[2m${'░'.repeat(rest)}\u001b[22m` : '░'.repeat(rest);
  return bar;
}

export const percent = (fraction: number) => `${(Number.isFinite(fraction) ? fraction * 100 : 0).toFixed(fraction > 0 && fraction < 0.1 ? 1 : 0)}%`;

// "3m 12s", "45s", "1h 02m"
export function elapsed(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

const CLEAR_LINE = '\r\u001b[2K';

// One line redrawn in place on a terminal, kept apart from what else is printed: clear it first, and the next update puts it
// back. Updates close together are skipped, since a run passes hundreds of files a second.
export class LiveLine {
  private write: (text: string) => unknown;
  private now: () => number;
  private gapMs: number;
  private shown = false;
  private drawnAt = -Infinity;

  constructor(write: (text: string) => unknown, { now = Date.now, gapMs = 80 }: { now?: () => number; gapMs?: number } = {}) {
    this.write = write;
    this.now = now;
    this.gapMs = gapMs;
  }

  update(draw: () => string): void {
    const at = this.now();
    if (this.shown && at - this.drawnAt < this.gapMs) return;
    this.drawnAt = at;
    this.shown = true;
    this.write(`${CLEAR_LINE}${draw()}`);
  }

  clear(): void {
    if (!this.shown) return;
    this.shown = false;
    this.write(CLEAR_LINE);
  }
}
