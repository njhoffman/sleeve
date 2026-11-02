import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Loaded before every test file (.mocharc.json): points XDG_DATA_HOME at a scratch directory for the whole
// run, so nothing a test does reaches the user's real database, and removes it afterwards.

const scratch = mkdtempSync(path.join(os.tmpdir(), 'sleeve-test-'));
const saved = process.env.XDG_DATA_HOME;
process.env.XDG_DATA_HOME = path.join(scratch, 'data');

export const mochaHooks = {
  afterAll() {
    if (saved === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved;
    rmSync(scratch, { recursive: true, force: true });
  }
};
