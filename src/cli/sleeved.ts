#!/usr/bin/env node
import { main } from './index.ts';

// `sleeved [options]`: the same as `sleeve daemon [options]`
process.exitCode = await main(['daemon', ...process.argv.slice(2)]);
