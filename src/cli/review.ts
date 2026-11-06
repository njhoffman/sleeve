import type { FetchOptions } from '../core/fetchLyrics.ts';
import { formatRef } from '../core/prefs.ts';
import type { Provider } from '../core/providers/provider.ts';
import type { TagFallbacks, TagRetries } from '../core/retries.ts';
import { doubtDistance, doubts, listMp3s, TAG_STATUSES, tagFiles, type FileDoubt, type TagReport, type TagStatus } from '../core/tagger.ts';
import { clockTime } from '../players/clock.ts';
import type { ScoredCandidate } from '../core/types.ts';
import { candidateRows, clock, done, errStyle, outStyle, pickProviders, warn, type Io } from './lyrics.ts';
import { openStores } from './stores.ts';
import { LiveLine, paint, shortenPath, stylePath } from './style.ts';
import { forBatch, progressLine } from './tag.ts';
import path from 'node:path';

// `sleeve review <paths>`: the files sleeve tag held lyrics back from as not fitting, for someone to decide, closest match first so
// the likely ones come early and stopping partway leaves the likely wrong. Accepting pins those lyrics, as sleeve pick does, and writes
// them through the same path as sleeve tag. A file skipped comes back next time; one marked does not.

export interface ReviewOptions {
  list?: boolean;
  providers?: string;
}

// One key among those asked for; quit keys come back as q
export type Ask = (prompt: string, keys: string) => Promise<string>;

export interface ReviewDeps extends Pick<FetchOptions, 'cache' | 'prefs' | 'tags' | 'fetch'> {
  retries?: TagRetries;
  fallbacks?: TagFallbacks;
  providers?: Provider[];
  ask?: Ask;
  // Whether keys can be read, without a given ask
  input?: NodeJS.ReadStream;
}

// Keys from a terminal, each answered at once
function terminalAsk(input: NodeJS.ReadStream, write: (text: string) => unknown): Ask {
  return (prompt, keys) => new Promise(resolve => {
    // Raw first: a key pressed as the prompt appears should not be echoed after it
    input.setRawMode(true);
    input.resume();
    write(prompt);
    const press = (data: Buffer) => {
      const key = data.toString().toLowerCase();
      if (key !== '\u0003' && key !== 'q' && !keys.includes(key)) return;
      input.off('data', press);
      input.setRawMode(false);
      input.pause();
      write('\n');
      resolve(key === '\u0003' ? 'q' : key);
    };
    input.on('data', press);
  });
}

const PREVIEW_HEAD = 6;
const PREVIEW_TAIL = 3;

// The start and end of the lyrics with their times, which is what tells whether they fit this file
function previewLines(candidate: ScoredCandidate, io: Io): string[] {
  const paints = paint(outStyle(io));
  const lines = candidate.lyrics.lines.filter(line => line.time !== null && line.text.trim());
  const shown = (line: typeof lines[number]) => `    ${paints.dim(`[${clockTime(line.time!)}]`)} ${line.text}`;
  if (lines.length <= PREVIEW_HEAD + PREVIEW_TAIL) return lines.map(shown);
  return [...lines.slice(0, PREVIEW_HEAD).map(shown), paints.dim(`    ... ${lines.length - PREVIEW_HEAD - PREVIEW_TAIL} more ...`), ...lines.slice(-PREVIEW_TAIL).map(shown)];
}

// A candidate against the file: what lengths there are, and why it was held back
function factsLine(doubt: FileDoubt, candidate: ScoredCandidate, io: Io): string {
  const paints = paint(outStyle(io));
  const timed = candidate.lyrics.lines.filter(line => line.time !== null);
  const last = timed.length ? timed[timed.length - 1].time! : null;
  const reason = doubts(doubt.query, candidate)?.replace(`${formatRef(candidate)} `, '') ?? 'fits';
  return [
    paints.cyan(formatRef(candidate)), `file ${clock(doubt.query.durationMs)}`, `lyrics' track ${clock(candidate.track.durationMs)}`,
    `${timed.length} lines`, ...(last === null ? [] : [`last at ${clockTime(last)}`]), paints.yellow(reason)
  ].join(paints.dim(' · '));
}

// The doubtful files under the paths, closest first
async function findDoubtful(paths: string[], io: Io, providers: Provider[], deps: ReviewDeps, stores: ReturnType<typeof openStores>): Promise<TagReport[]> {
  const files = await listMp3s(paths);
  const started = Date.now();
  const seen = Object.fromEntries(TAG_STATUSES.map(status => [status, 0])) as Record<TagStatus, number>;
  const line = io.live && errStyle(io).tty ? new LiveLine(io.live) : null;
  const found: TagReport[] = [];
  let finished = 0;
  try {
    await tagFiles(files, {
      providers, write: false,
      ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.tags ? { tags: deps.tags } : {}),
      ...(stores.cache ? { cache: stores.cache } : {}), ...(stores.prefs ? { prefs: stores.prefs } : {}), ...(stores.retries ? { retries: stores.retries } : {}),
      onNetworkDown: () => { line?.clear(); warn(io, 'The network looks down, so this list may be short'); },
      onFile: report => {
        finished++;
        seen[report.status]++;
        if (report.doubt) found.push(report);
        line?.update(() => progressLine(finished, files.length, seen, Date.now() - started, errStyle(io)));
      }
    });
  } finally {
    line?.clear();
  }
  const distance = (report: TagReport) => doubtDistance(report.doubt!.query, report.doubt!.candidates[0]);
  return found.sort((a, b) => distance(a) - distance(b) || a.file.localeCompare(b.file));
}

// Resolves to the exit code: 0, or 1 when a write failed
export async function reviewCommand(paths: string[], options: ReviewOptions, io: Io, deps: ReviewDeps = {}): Promise<number> {
  const providers = deps.providers ?? forBatch(pickProviders(options.providers)!);
  const stores = openStores({ cache: true, prefs: true, retries: true, fallbacks: true }, deps);
  const base = paths.length === 1 ? path.resolve(paths[0]) : process.cwd();
  const shown = (file: string) => {
    const relative = path.relative(base, path.resolve(file));
    return relative && !relative.startsWith('..') ? relative : file;
  };
  const input = deps.input ?? process.stdin;
  const ask = deps.ask ?? (input.isTTY && !options.list ? terminalAsk(input, text => (io.live ?? process.stdout.write.bind(process.stdout))(text)) : null);
  try {
    const found = await findDoubtful(paths, io, providers, deps, stores);
    const style = outStyle(io);
    const paints = paint(style);
    if (!found.length) {
      io.out('Nothing doubtful here');
      return 0;
    }
    if (options.list || !ask) {
      for (const report of found) io.out(`${report.doubt!.reason}  ${shown(report.file)}`);
      io.err(`${found.length} doubtful`);
      return 0;
    }
    const tally = { written: 0, marked: 0, skipped: 0, failed: 0 };
    let index = 0;
    for (; index < found.length; index++) {
      const report = found[index];
      const doubt = report.doubt!;
      let candidate = doubt.candidates[0];
      io.out('');
      const where = style.columns ? shortenPath(shown(report.file), style.columns - 12) : shown(report.file);
      io.out(`${paints.dim(`${index + 1}/${found.length}`)}  ${paints.bold(`${doubt.query.artist} - ${doubt.query.title}`)}`);
      io.out(`  ${stylePath(where, paints)}`);
      let decided = false;
      while (!decided) {
        io.out(`  ${factsLine(doubt, candidate, io)}`);
        const others = doubt.candidates.length > 1;
        const key = paints.cyan;
        const prompt = `  ${key('a')}ccept  ${key('p')}review  ${others ? `${key('o')}ther (${doubt.candidates.length - 1})  ` : ''}${key('s')}kip  ${key('n')}o correct lyrics  ${key('i')}nstrumental  ${key('q')}uit `;
        const answer = await ask(prompt, `aps${others ? 'o' : ''}ni`);
        if (answer === 'q') {
          decided = true;
          index = found.length;
          break;
        }
        if (answer === 'p') {
          for (const line of previewLines(candidate, io)) io.out(line);
        } else if (answer === 'o') {
          for (const line of candidateRows(doubt.candidates.slice(0, 9), style, { shown: candidate })) io.out(`  ${line}`);
          const numbers = doubt.candidates.slice(0, 9).map((_, at) => String(at + 1)).join('');
          const chosen = await ask(`  which? (${numbers[0]}-${numbers.at(-1)}, ${key('k')} to keep this one) `, `${numbers}k`);
          if (chosen === 'q') {
            decided = true;
            index = found.length;
            break;
          }
          if (chosen !== 'k') candidate = doubt.candidates[Number(chosen) - 1];
        } else if (answer === 's') {
          tally.skipped++;
          decided = true;
        } else if (answer === 'n' || answer === 'i') {
          stores.prefs!.setMark(doubt.query, answer === 'n' ? 'none' : 'instrumental');
          tally.marked++;
          decided = true;
          done(io, `  Marked ${answer === 'n' ? 'as having no correct lyrics' : 'as instrumental'}`);
        } else if (answer === 'a') {
          stores.prefs!.setPick(doubt.query, candidate);
          const results: TagReport[] = [];
          await tagFiles([report.file], {
            providers, write: true,
            ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.tags ? { tags: deps.tags } : {}),
            ...(stores.cache ? { cache: stores.cache } : {}), prefs: stores.prefs!, ...(stores.retries ? { retries: stores.retries } : {}),
            onFile: result => results.push(result)
          });
          const result = results[0];
          decided = true;
          if (result?.status === 'written' || result?.status === 'unchanged') {
            tally.written++;
            done(io, `  Written: ${result.detail}`);
          } else {
            tally.failed++;
            warn(io, `not written: ${result?.status ?? 'no report'}${result?.detail ? ` (${result.detail})` : ''}; the pick stays`);
          }
        }
      }
    }
    const looked = tally.written + tally.marked + tally.skipped + tally.failed;
    const left = found.length - looked;
    io.err('');
    io.err([`${tally.written} written`, `${tally.marked} marked`, `${tally.skipped} skipped`, ...(tally.failed ? [`${tally.failed} failed`] : []), ...(left ? [`${left} not reached`] : [])].join(' · '));
    return tally.failed ? 1 : 0;
  } finally {
    stores.close();
  }
}
