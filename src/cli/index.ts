#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
import { cacheClearCommand, cacheStatsCommand, type CacheOptions, type ClearCommandOptions } from './cache.ts';
import { DEFAULT_PROVIDERS } from '../core/fetchLyrics.ts';
import { DEFAULT_HOST, DEFAULT_PORT } from '../daemon/paths.ts';
import { daemonCommand, type DaemonCommandOptions } from './daemon.ts';
import { FORMATS, lyricsCommand, type Io, type LyricsOptions } from './lyrics.ts';
import { nowCommand, type NowOptions } from './now.ts';
import { offsetCommand, pickCommand, type TrackCommandOptions } from './prefs.ts';

const stdio: Io = {
  out: text => process.stdout.write(`${text}\n`),
  err: text => process.stderr.write(`${text}\n`)
};

// The options that name a track and the providers to look it up with, shared by pick and offset
function trackOptions(command: Command): Command {
  return command
    .option('-a, --artist <artist>', 'artist (overrides the file\'s tag)')
    .option('-t, --title <title>', 'title (overrides the file\'s tag)')
    .option('--album <album>', 'album, to narrow the match')
    .option('-d, --duration <length>', 'track length in seconds or m:ss')
    .option('-p, --providers <names>', 'comma-separated providers, as for sleeve lyrics')
    .option('--timeout <seconds>', 'per-provider timeout in seconds', '10');
}

// The options that choose players, providers and stores, shared by now and daemon. Defaults are applied by
// openSession rather than here, so `sleeve now` can tell an option given from one left out.
function sessionOptions(command: Command): Command {
  return command
    .option('--mpd <address>', 'MPD as host, host:port, password@host:port or a socket path (default: MPD_HOST, then musicman\'s paths.json, then localhost:6600)')
    .option('--no-mpd', 'leave MPD out')
    .option('--music-dir <dir>', 'MPD\'s music directory, to find the files it plays (default: musicman\'s)')
    .option('--mpris <names>', 'comma-separated MPRIS players to follow (default: spotify)')
    .option('--no-mpris', 'leave MPRIS players (Spotify) out')
    .option('-p, --providers <names>', 'comma-separated providers to ask, as for sleeve lyrics')
    .option('--timeout <seconds>', 'per-provider timeout in seconds (default: 10)')
    .option('--no-cache', 'neither read nor store online answers')
    .option('--no-prefs', 'ignore your picks and offsets')
    .option('--no-prefetch', 'do not look up the song MPD has queued next ahead of time');
}

export function buildProgram(io: Io, setExit: (code: number) => void): Command {
  const program = new Command('sleeve')
    .description('Synced lyrics from several sources')
    .version(pkg.version)
    .exitOverride()
    .configureOutput({ writeOut: text => io.out(text.trimEnd()), writeErr: text => io.err(text.trimEnd()) });

  program.command('lyrics')
    .description('Find lyrics for a local file (from its tags) or for --artist and --title; LRC goes to stdout, the source to stderr')
    .argument('[file]', 'an audio file; its tags give the artist, title, album and duration')
    .option('-a, --artist <artist>', 'artist (overrides the file\'s tag)')
    .option('-t, --title <title>', 'title (overrides the file\'s tag)')
    .option('--album <album>', 'album, to narrow the match')
    .option('-d, --duration <length>', 'track length in seconds or m:ss, to match the right version')
    .option('-p, --providers <names>', `comma-separated providers to ask: ${DEFAULT_PROVIDERS.map(provider => provider.name).join(', ')}`)
    .option('--timeout <seconds>', 'per-provider timeout in seconds', '10')
    .option('-f, --format <format>', `output format: ${FORMATS.join(' or ')}`, 'lrc')
    .option('--all', 'list every candidate with its score instead of printing lyrics')
    .option('--json', 'print the query and every candidate as JSON')
    .option('--no-cache', 'neither read nor store online answers')
    .option('--refresh', 'ask online providers again even when their answer is stored, and store the new one')
    .option('--no-prefs', 'ignore your picks and offsets (sleeve pick, sleeve offset)')
    .action(async (file: string | undefined, options: LyricsOptions) => {
      setExit(await lyricsCommand(file, options, io));
    });

  sessionOptions(program.command('now'))
    .description('Follow what MPD or Spotify plays and print its lyrics line by line; + and - move them 100 ms (saved), q quits. Shows sleeved\'s session when it runs.')
    .option('--once', 'print the track, where playback is and the current line, then exit')
    .option('--json', 'with --once, print it all as JSON')
    .option('--daemon', 'only through sleeved; fail when it is not running')
    .option('--no-daemon', 'open the players here even when sleeved runs (any player, provider or store option does too)')
    .option('--socket <path>', 'sleeved\'s Unix socket (default: $XDG_RUNTIME_DIR/sleeve/sleeved.sock)')
    .action(async (options: NowOptions) => {
      setExit(await nowCommand(options, io));
    });

  sessionOptions(program.command('daemon'))
    .description('Run sleeved: follow the players and serve lyrics and playback to displays over a WebSocket and a Unix socket')
    .option('--host <address>', 'address for the WebSocket', DEFAULT_HOST)
    .option('--port <port>', `port for the WebSocket, at /ws (default: ${DEFAULT_PORT})`)
    .option('--no-websocket', 'leave the WebSocket out')
    .option('--socket <path>', 'the Unix socket, one JSON message per line (default: $XDG_RUNTIME_DIR/sleeve/sleeved.sock)')
    .option('--no-socket', 'leave the Unix socket out')
    .option('--allow-origin <origin...>', 'web origins that may connect besides localhost pages and file:// (* for any)')
    .action(async (options: DaemonCommandOptions) => {
      setExit(await daemonCommand(options, io));
    });

  trackOptions(program.command('pick'))
    .description('Show these lyrics for a track from now on, even if they score under the threshold')
    .argument('[args...]', '[file] <candidate>: provider:id, or the number sleeve lyrics --all gives it')
    .option('--reset', 'forget the pick, so the ranking decides again')
    .action(async (args: string[], options: TrackCommandOptions) => {
      setExit(await pickCommand(args, options, io));
    });

  trackOptions(program.command('offset'))
    .description('Shift the lyrics shown for a track in time; without a value, show the offset')
    .argument('[args...]', '[file] [ms]: milliseconds, positive for later lyrics, negative for sooner; 0 removes it')
    .option('--reset', 'remove the offset')
    .action(async (args: string[], options: TrackCommandOptions) => {
      setExit(await offsetCommand(args, options, io));
    });

  const cache = program.command('cache')
    .description('Show what online providers answered and is stored, by provider')
    .option('--json', 'print the counts as JSON')
    .action((options: CacheOptions) => {
      setExit(cacheStatsCommand(options, io));
    });

  cache.command('clear')
    .description('Forget stored answers, so providers are asked again')
    .option('-p, --provider <name>', 'only this provider\'s answers')
    .option('--not-found', 'only the answers without lyrics')
    .action((options: ClearCommandOptions) => {
      setExit(cacheClearCommand(options, io));
    });

  return program;
}

// Resolves to the process exit code
export async function main(argv: string[], io: Io = stdio): Promise<number> {
  let code = 0;
  const program = buildProgram(io, value => { code = value; });
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    io.err(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  return code;
}

// Run as a script (including through the npm bin symlink), not when imported by tests
const invoked = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) process.exitCode = await main(process.argv.slice(2));
