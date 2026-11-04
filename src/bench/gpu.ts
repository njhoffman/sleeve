import { appendFileSync, existsSync, readFileSync } from 'node:fs';

// What the GPU benchmark (src/bench/run.ts, `just bench-gpu`) keeps and works out. Each measurement is one line of
// benchmarks/gpu.jsonl, kept in the repo, so the averages cover every run so far. Only like is averaged with like: a scene
// from one runner on one machine at one size.

export interface Measurement {
  at: string;
  version: string;
  host: string;
  gpu: string;
  // electron: the shell, by `just bench-gpu`; chrome: a browser page, as in the first tests
  runner: 'electron' | 'chrome';
  scene: string;
  geometry: string;
  // Share of the GPU's render engine time, percent, from /proc/PID/fdinfo
  // null when only the start and stop were timed
  rendererPercent: number | null;
  compositorPercent: number | null;
  // Milliseconds from starting the shell to its window existing, and from SIGTERM to its exit
  startMs: number | null;
  stopMs: number | null;
  note?: string;
}

// The render engine time in nanoseconds a process has used, from its /proc/PID/fdinfo files: one client can show through
// several file descriptors, so each client counts once
export function renderNanoseconds(fdinfos: string[]): number {
  const clients = new Map<string, number>();
  for (const text of fdinfos) {
    const client = /drm-client-id:\s*(\d+)/.exec(text);
    const render = /drm-engine-render:\s*(\d+) ns/.exec(text);
    if (client && render) clients.set(client[1], Number(render[1]));
  }
  return [...clients.values()].reduce((sum, value) => sum + value, 0);
}

export const sharePercent = (nanoseconds: number, seconds: number) => nanoseconds / (seconds * 1e9) * 100;

export function loadMeasurements(file: string): Measurement[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as Measurement);
}

export function saveMeasurement(file: string, measurement: Measurement): void {
  appendFileSync(file, `${JSON.stringify(measurement)}\n`);
}

export interface Average {
  host: string;
  runner: Measurement['runner'];
  scene: string;
  geometry: string;
  runs: number;
  renderer: number | null;
  rendererLow: number | null;
  rendererHigh: number | null;
  compositor: number | null;
  startMs: number | null;
  stopMs: number | null;
}

function mean(values: Array<number | null | undefined>): number | null {
  const known = values.filter((value): value is number => typeof value === 'number');
  return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
}

// The average of each scene, in the order the scenes were first measured
export function averages(measurements: Measurement[]): Average[] {
  const groups = new Map<string, Measurement[]>();
  for (const measurement of measurements) {
    const key = [measurement.host, measurement.runner, measurement.scene, measurement.geometry].join('\0');
    groups.set(key, [...(groups.get(key) ?? []), measurement]);
  }
  return [...groups.values()].map(group => {
    const percents = group.map(item => item.rendererPercent).filter((value): value is number => value !== null);
    return {
      host: group[0].host,
      runner: group[0].runner,
      scene: group[0].scene,
      geometry: group[0].geometry,
      runs: group.length,
      renderer: mean(percents),
      rendererLow: percents.length ? Math.min(...percents) : null,
      rendererHigh: percents.length ? Math.max(...percents) : null,
      compositor: mean(group.map(item => item.compositorPercent)),
      startMs: mean(group.map(item => item.startMs)),
      stopMs: mean(group.map(item => item.stopMs))
    };
  });
}

// The averages as a table for a terminal
export function averagesTable(rows: Average[]): string[] {
  const cell = (value: number | null, digits: number, unit = '') => (value === null ? '-' : `${value.toFixed(digits)}${unit}`);
  const table = [
    ['runner', 'scene', 'size', 'runs', 'gpu avg', 'low-high', 'compositor', 'start', 'stop'],
    ...rows.map(row => [
      row.runner, row.scene, row.geometry, String(row.runs), cell(row.renderer, 1, '%'), row.rendererLow === null ? '-' : `${row.rendererLow.toFixed(1)}-${row.rendererHigh!.toFixed(1)}`,
      cell(row.compositor, 1, '%'), cell(row.startMs, 0, ' ms'), cell(row.stopMs, 0, ' ms')
    ])
  ];
  const widths = table[0].map((_, at) => Math.max(...table.map(line => line[at].length)));
  return table.map(line => line.map((text, at) => (at >= 3 ? text.padStart(widths[at]) : text.padEnd(widths[at]))).join('  ').trimEnd());
}
