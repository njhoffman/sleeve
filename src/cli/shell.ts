import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Io } from './lyrics.ts';

// `sleeve shell`: the Electron window, a stable command for what starts it (a key binding, backdrop's sleeve engine).
// Everything after it goes to the shell as it is (src/shell/layout.ts reads it); the exit status is the shell's.

export const SHELL_ROOT = fileURLToPath(new URL('../../shell/', import.meta.url));

export interface ShellDeps {
  root?: string;
  spawn?: (file: string, args: string[], options: { stdio: 'inherit' }) => ChildProcess;
  // Ubuntu's AppArmor blocks the user namespaces Electron's sandbox needs, and Electron then aborts with a trace
  sandboxBlocked?: (root: string) => boolean;
}

export function sandboxBlocked(root: string): boolean {
  let restricted = false;
  try {
    restricted = readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1';
  } catch {
    return false;
  }
  if (!restricted || existsSync('/etc/apparmor.d/sleeve-electron')) return false;
  try {
    const helper = statSync(path.join(root, 'node_modules/electron/dist/chrome-sandbox'));
    return !(helper.uid === 0 && (helper.mode & 0o4000) !== 0);
  } catch {
    return true;
  }
}

export async function shellCommand(args: string[], io: Io, { root = SHELL_ROOT, spawn = nodeSpawn, sandboxBlocked: blocked = sandboxBlocked }: ShellDeps = {}): Promise<number> {
  const electron = path.join(root, 'node_modules/.bin/electron');
  if (!existsSync(electron)) {
    io.err('The shell is not installed: run just shell-install in sleeve\'s checkout');
    return 2;
  }
  if (!args.includes('--no-sandbox') && blocked(root)) {
    io.err('AppArmor blocks Electron\'s sandbox here: run just shell-sandbox once (sudo), or give --no-sandbox');
    return 2;
  }
  const child = spawn(electron, [root, ...args], { stdio: 'inherit' });
  const forward = (signal: NodeJS.Signals) => () => { child.kill(signal); };
  const handlers = (['SIGINT', 'SIGTERM'] as const).map(signal => [signal, forward(signal)] as const);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  return new Promise<number>(resolve => {
    const done = (code: number) => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      resolve(code);
    };
    child.once('error', error => {
      io.err(`Cannot start the shell: ${error.message}`);
      done(1);
    });
    // Stopped by a signal we forwarded counts as a clean stop
    child.once('exit', (code, signal) => done(code ?? (signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1)));
  });
}
