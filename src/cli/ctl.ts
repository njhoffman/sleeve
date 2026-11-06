import { formatRef, parseRef } from '../core/prefs.ts';
import type { LyricsResult, ScoredCandidate, TrackMark } from '../core/types.ts';
import { DaemonClient } from '../daemon/client.ts';
import { defaultSocketPath } from '../daemon/paths.ts';
import { describeReport, type ClientCommand, type DisplayCommand, type LyricsAlign, type NowPosition, type NowPreset, type ReportReply } from '../protocol/messages.ts';
import { candidateRows, describeCandidate, done, formatOffset, outStyle, problem, type Io } from './lyrics.ts';
import { parseOffset } from './prefs.ts';

// `sleeve ctl`: one command to the running sleeved, for key bindings (i3's bindsym) and scripts. It acts on
// whatever plays, so every display (the overlay included) follows. Exit status 0 when done, 1 when sleeved
// could not do it (no lyrics to move, nothing playing), 2 when sleeved is not running.

export interface CtlOptions {
  socket?: string;
  json?: boolean;
  // display
  instance?: string;
  preset?: string;
  position?: string;
  align?: string;
  lyricsArea?: string;
  nowArea?: string;
  background?: string;
  hide?: boolean;
  show?: boolean;
  reset?: boolean;
}

type Unsent = ClientCommand extends infer T ? T extends unknown ? Omit<T, 'id'> : never : never;

async function connect(options: CtlOptions): Promise<DaemonClient> {
  const socketPath = options.socket ?? defaultSocketPath();
  const client = await DaemonClient.connect(socketPath);
  if (!client) throw new Error(`sleeved is not running (nothing answers at ${socketPath})`);
  return client;
}

async function send(client: DaemonClient, command: Unsent, io: Io): Promise<unknown | undefined> {
  const reply = await client.send(command);
  if (!reply.ok) {
    problem(io, reply.error ?? 'Failed');
    return undefined;
  }
  return reply.data ?? null;
}

// Candidates in the order `sleeve lyrics --all` numbers them, those without an id left out (they cannot be picked)
function numbered(result: LyricsResult): ScoredCandidate[] {
  return [...result.candidates, ...result.rejected].filter(candidate => candidate.id);
}

export async function ctlCommand(action: string, args: string[], options: CtlOptions, io: Io): Promise<number> {
  const needs = (count: number, usage: string) => {
    if (args.length !== count) throw new Error(`Usage: sleeve ctl ${action}${usage ? ` ${usage}` : ''}`);
  };
  switch (action) {
    case 'nudge': case 'offset': needs(1, '<ms>'); break;
    case 'pick': needs(1, '<provider:id | number>'); break;
    case 'mark': needs(1, '<none | instrumental>'); break;
    case 'unpick': case 'wrong': case 'mistimed': case 'unreport': case 'refresh': case 'candidates': case 'display': needs(0, ''); break;
    default: throw new Error(`Unknown action: ${action} (nudge, offset, pick, mark, unpick, wrong, mistimed, unreport, refresh, candidates, display)`);
  }
  const ms = action === 'nudge' || action === 'offset' ? parseOffset(args[0]) : 0;
  const picked = action === 'pick' && !/^\d+$/.test(args[0]) ? parseRef(args[0]) : null;
  if (action === 'pick' && !picked && !/^\d+$/.test(args[0])) throw new Error(`Invalid candidate: ${args[0]} (provider:id, or a number from sleeve ctl candidates)`);
  if (action === 'mark' && args[0] !== 'none' && args[0] !== 'instrumental') throw new Error(`Invalid mark: ${args[0]} (none or instrumental)`);
  const client = await connect(options);
  try {
    switch (action) {
      case 'nudge':
      case 'offset': {
        const data = await send(client, { type: action, ms }, io) as { offsetMs: number } | undefined;
        if (!data) return 1;
        done(io, data.offsetMs ? `Offset ${formatOffset(data.offsetMs)}` : 'Offset removed');
        return 0;
      }
      case 'refresh': {
        if (await send(client, { type: 'refresh' }, io) === undefined) return 1;
        const best = client.mirror.current().result?.best;
        done(io, best ? `Looked up again: ${describeCandidate(best)}` : 'Looked up again: no lyrics found');
        return 0;
      }
      case 'mark': {
        if (await send(client, { type: 'mark', mark: args[0] as TrackMark }, io) === undefined) return 1;
        done(io, args[0] === 'none' ? 'Marked: no correct lyrics' : 'Marked: instrumental');
        return 0;
      }
      case 'wrong':
      case 'mistimed': {
        const data = await send(client, { type: 'report', kind: action }, io) as ReportReply | undefined;
        if (!data) return 1;
        done(io, describeReport(data));
        return 0;
      }
      case 'unreport': {
        const data = await send(client, { type: 'unreport' }, io) as { removed: boolean } | undefined;
        if (!data) return 1;
        done(io, data.removed ? 'Forgot what was reported' : 'Nothing reported for this track');
        return 0;
      }
      case 'display': {
        const command: Omit<DisplayCommand, 'id'> = {
          type: 'display',
          ...(options.instance ? { instance: options.instance } : {}),
          ...(options.preset ? { preset: options.preset as NowPreset } : {}),
          ...(options.position ? { position: options.position as NowPosition } : {}),
          ...(options.align ? { align: options.align as LyricsAlign } : {}),
          ...(options.lyricsArea ? { lyricsArea: options.lyricsArea } : {}),
          ...(options.nowArea ? { nowArea: options.nowArea } : {}),
          ...(options.background ? { background: options.background } : {}),
          ...(options.hide ? { visible: false } : options.show ? { visible: true } : {}),
          ...(options.reset ? { reset: true } : {})
        };
        if (await send(client, command, io) === undefined) return 1;
        done(io, `Display of ${options.instance ?? 'every page'} changed`);
        return 0;
      }
      case 'unpick': {
        const data = await send(client, { type: 'unpick' }, io) as { removed: boolean } | undefined;
        if (!data) return 1;
        done(io, data.removed ? 'Removed the pick' : 'No pick for this track');
        return 0;
      }
      case 'candidates': {
        const result = await send(client, { type: 'candidates' }, io) as LyricsResult | undefined;
        if (!result) return 1;
        if (options.json) {
          io.out(JSON.stringify(result, null, 2));
          return 0;
        }
        const shown = client.mirror.current().result?.best;
        const list = numbered(result);
        if (!list.length) io.out('No candidates');
        if (outStyle(io).rich) {
          const same = list.find(candidate => shown && candidate.provider === shown.provider && candidate.id === shown.id);
          for (const line of candidateRows(list, outStyle(io), { shown: same ?? null })) io.out(line);
          return 0;
        }
        list.forEach((candidate, index) => {
          const mark = shown && candidate.provider === shown.provider && candidate.id === shown.id ? '*' : ' ';
          io.out(`${mark}${String(index + 1).padStart(2)}. ${formatRef(candidate)}  ${describeCandidate(candidate)}`);
        });
        return 0;
      }
      case 'pick': {
        let ref = picked;
        if (!ref) {
          const result = await send(client, { type: 'candidates' }, io) as LyricsResult | undefined;
          if (!result) return 1;
          const candidate = numbered(result)[Number(args[0]) - 1];
          if (!candidate) {
            problem(io, `No candidate ${args[0]}; list them with sleeve ctl candidates`);
            return 1;
          }
          ref = { provider: candidate.provider, id: candidate.id! };
        }
        const data = await send(client, { type: 'pick', ref: formatRef(ref) }, io) as { ref: string } | undefined;
        if (!data) return 1;
        done(io, `Picked ${data.ref}`);
        return 0;
      }
    }
    return 1;
  } finally {
    client.close();
  }
}
