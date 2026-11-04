import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { averages, averagesTable, loadMeasurements, renderNanoseconds, saveMeasurement, sharePercent, type Measurement } from '../../src/bench/gpu.ts';

const measured = (extra: Partial<Measurement> = {}): Measurement => ({
  at: '2026-11-04T00:00:00Z', version: '1', host: 'h', gpu: 'g', runner: 'electron', scene: 'flow', geometry: '100x100+0+0',
  rendererPercent: 5, compositorPercent: null, startMs: null, stopMs: null, ...extra
});

describe('the GPU benchmark', () => {
  it('counts each client\'s render time once, however many descriptors show it', () => {
    const client = (id: number, ns: number) => `drm-driver: i915\ndrm-client-id: ${id}\ndrm-engine-render: ${ns} ns\ndrm-engine-video: 99 ns\n`;
    expect(renderNanoseconds([client(1, 1000), client(1, 1000), client(2, 500), 'pos: 0\nflags: 2\n'])).to.equal(1500);
    expect(renderNanoseconds([])).to.equal(0);
    expect(sharePercent(1e9, 2)).to.equal(50);
  });

  it('averages only like with like, with the range', () => {
    const rows = averages([
      measured({ rendererPercent: 4 }), measured({ rendererPercent: 8 }),
      measured({ runner: 'chrome', rendererPercent: 1 }),
      measured({ geometry: '200x200+0+0', rendererPercent: 2 }),
      measured({ scene: 'other', rendererPercent: 3, compositorPercent: 20 }), measured({ scene: 'other', rendererPercent: 5, compositorPercent: null, startMs: 2000, stopMs: 100 })
    ]);
    expect(rows.map(row => [row.runner, row.scene, row.geometry, row.runs, row.renderer])).to.deep.equal([
      ['electron', 'flow', '100x100+0+0', 2, 6], ['chrome', 'flow', '100x100+0+0', 1, 1], ['electron', 'flow', '200x200+0+0', 1, 2], ['electron', 'other', '100x100+0+0', 2, 4]
    ]);
    expect(rows[0]).to.include({ rendererLow: 4, rendererHigh: 8 });
    expect(rows[3]).to.include({ compositor: 20, startMs: 2000, stopMs: 100 });
  });

  it('copes with a measurement that only timed the start, and prints a table', () => {
    const rows = averages([measured({ rendererPercent: null, startMs: 2000 }), measured({ rendererPercent: null, startMs: 4000 })]);
    expect(rows[0]).to.include({ renderer: null, rendererLow: null, startMs: 3000, runs: 2 });
    const table = averagesTable(rows);
    expect(table[0]).to.include('gpu avg');
    expect(table[1]).to.include('flow').and.include('3000 ms');
  });

  it('keeps measurements between runs', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sleeve-bench-'));
    const file = path.join(dir, 'gpu.jsonl');
    expect(loadMeasurements(file)).to.deep.equal([]);
    saveMeasurement(file, measured({ rendererPercent: 1 }));
    saveMeasurement(file, measured({ rendererPercent: 2 }));
    expect(loadMeasurements(file).map(item => item.rendererPercent)).to.deep.equal([1, 2]);
    await rm(dir, { recursive: true });
  });

  it('holds the measurements already made, each one readable', () => {
    const kept = loadMeasurements(new URL('../../benchmarks/gpu.jsonl', import.meta.url).pathname);
    expect(kept.length).to.be.greaterThan(20);
    expect(averagesTable(averages(kept)).length).to.be.greaterThan(5);
  });
});
