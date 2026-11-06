import { buildQuery, done, errStyle, outStyle, type Io } from './lyrics.ts';
import type { FetchOptions } from '../core/fetchLyrics.ts';
import { formatRef } from '../core/prefs.ts';
import { openStores } from './stores.ts';
import { paint, table, type Cell } from './style.ts';

// `sleeve reports`: the lyrics the user said were wrong or mistimed, the latest first. Files keep theirs until
// `sleeve tag --fix-reported`. --reset forgets a track's, or everyone's with --all; lyrics a running sleeved already passed
// over come back on its next lookup (sleeve ctl refresh; sleeve ctl unreport does both for what plays).

export interface ReportsOptions {
  artist?: string;
  title?: string;
  duration?: string;
  reset?: boolean;
  all?: boolean;
  json?: boolean;
}

export async function reportsCommand(file: string | undefined, options: ReportsOptions, io: Io, given: Pick<FetchOptions, 'prefs' | 'tags'> = {}): Promise<number> {
  const named = Boolean(file || options.artist || options.title);
  if (!options.reset && (named || options.all)) throw new Error('A track or --all goes with --reset');
  if (options.reset && named === Boolean(options.all)) throw new Error('--reset needs a track (a file, or --artist and --title), or --all');
  const stores = openStores({ cache: false, prefs: true }, given);
  const prefs = stores.prefs!;
  try {
    if (options.reset) {
      if (options.all) {
        const count = prefs.clearAllReports();
        done(io, `Forgot the reports of ${count} track${count === 1 ? '' : 's'}`);
        return 0;
      }
      const query = await buildQuery(file, options, given.tags);
      io.out(prefs.clearReports(query) ? `Forgot the reports of ${query.artist} - ${query.title}` : `Nothing reported for ${query.artist} - ${query.title}`);
      return 0;
    }
    const reports = prefs.allReports();
    if (options.json) {
      io.out(JSON.stringify(reports, null, 2));
      return 0;
    }
    if (!reports.length) {
      io.out('Nothing reported');
      return 0;
    }
    const style = outStyle(io);
    if (style.rich) {
      const paints = paint(style);
      const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
      const rows: Cell[][] = reports.map(report => [
        { text: report.kind, style: report.kind === 'wrong' ? paints.red : paints.yellow }, `${report.artist} - ${report.title}`,
        { text: formatRef(report), style: paints.cyan }, { text: when(report.reportedAt), style: paints.dim }
      ]);
      for (const line of table(rows, { flex: 1, columns: style.columns })) io.out(line);
      io.err(paint(errStyle(io)).dim('Files keep the lyrics they have until sleeve tag <paths> --fix-reported --write'));
      return 0;
    }
    for (const report of reports) {
      const when = new Date(report.reportedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
      io.out(`${report.kind.padEnd(8)} ${report.artist} - ${report.title}  ${formatRef(report)}  ${when}`);
    }
    io.err('Files keep the lyrics they have until sleeve tag <paths> --fix-reported --write');
    return 0;
  } finally {
    stores.close();
  }
}
