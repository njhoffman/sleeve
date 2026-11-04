import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { shellCommand } from '../../src/cli/shell.ts';

describe('sleeve shell', () => {
  let root: string, out: string[], err: string[];
  const io = { out: (text: string) => out.push(text), err: (text: string) => err.push(text) };

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'sleeve-shell-'));
    out = [];
    err = [];
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const install = async () => {
    await mkdir(path.join(root, 'node_modules/.bin'), { recursive: true });
    await writeFile(path.join(root, 'node_modules/.bin/electron'), '');
  };

  // A child that ends as the test says, and what it was started with and sent
  function fakeSpawn(end: { code?: number | null; signal?: string | null; error?: Error }) {
    const started: Array<{ file: string; args: string[] }> = [];
    const signals: string[] = [];
    const spawn = (file: string, args: string[]) => {
      started.push({ file, args });
      const child = Object.assign(new EventEmitter(), { kill: (signal: string) => { signals.push(signal); return true; } });
      setImmediate(() => {
        if (end.error) child.emit('error', end.error);
        else child.emit('exit', end.code ?? null, end.signal ?? null);
      });
      return child as unknown as ChildProcess;
    };
    return { spawn, started, signals };
  }

  it('says how to install the shell when it is not there', async () => {
    expect(await shellCommand([], io, { root })).to.equal(2);
    expect(err[0]).to.include('just shell-install');
  });

  it('passes its arguments to Electron and exits with its status', async () => {
    await install();
    const fake = fakeSpawn({ code: 3 });
    expect(await shellCommand(['--managed', '--geometry', '800x600+0+0'], io, { root, spawn: fake.spawn, sandboxBlocked: () => false })).to.equal(3);
    expect(fake.started).to.deep.equal([{ file: path.join(root, 'node_modules/.bin/electron'), args: [root, '--managed', '--geometry', '800x600+0+0'] }]);
  });

  it('counts being stopped by a signal as a clean stop', async () => {
    await install();
    expect(await shellCommand([], io, { root, spawn: fakeSpawn({ signal: 'SIGTERM' }).spawn, sandboxBlocked: () => false })).to.equal(0);
  });

  it('refuses when the sandbox would abort, unless told to go without it', async () => {
    await install();
    const fake = fakeSpawn({ code: 0 });
    expect(await shellCommand([], io, { root, spawn: fake.spawn, sandboxBlocked: () => true })).to.equal(2);
    expect(err[0]).to.include('just shell-sandbox');
    expect(fake.started).to.deep.equal([]);
    expect(await shellCommand(['--no-sandbox'], io, { root, spawn: fake.spawn, sandboxBlocked: () => true })).to.equal(0);
  });

  it('reports a shell that cannot start', async () => {
    await install();
    expect(await shellCommand([], io, { root, spawn: fakeSpawn({ error: new Error('nope') }).spawn, sandboxBlocked: () => false })).to.equal(1);
    expect(err[0]).to.include('nope');
  });
});
