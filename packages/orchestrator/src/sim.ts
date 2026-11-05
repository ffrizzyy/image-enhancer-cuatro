import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { Job, JobMode, JobState, TileState } from '@ie/contracts';
import { FakeAdapter, type FailingMode } from '@ie/providers/fake';
import { planTiles } from '@ie/slicer';
import sharp from 'sharp';

import { openStore, type Store } from './store.ts';
import { runJob, type RunJobResult } from './runner.ts';

export interface SimulationOptions {
  /** 1 to 36, as rows x columns (each at most 6). */
  tiles: number;
  /** Chance (0-1) that each provider call fails. */
  failRate: number;
  seed?: number;
  mode?: JobMode;
  /** Where the source, the database and the results go. */
  outDir: string;
  /** Which failures to inject (default: every kind, so pauses and resumes are exercised too). */
  failureModes?: readonly FailingMode[];
  /** Stop resuming paused jobs after this many pauses (a guard against a loop). */
  maxPauses?: number;
}

export interface SimulationTile {
  index: number;
  state: TileState;
  attempts: number;
}

export interface SimulationResult {
  jobId: string;
  state: JobState;
  tiles: SimulationTile[];
  /** How many times the job paused (challenge, logged-out, quota) and was resumed by the simulated user. */
  pauses: number;
  providerCalls: number;
  stitched?: RunJobResult['stitched'];
  message?: string;
  dbPath: string;
}

/** Rows and columns whose product is `count`, each at most 6, as close to square as possible. */
export function gridFor(count: number): { rows: number; cols: number } {
  if (!Number.isInteger(count) || count < 1) throw new RangeError('The tile count must be a whole number of at least 1.');
  let best: { rows: number; cols: number } | null = null;
  for (let rows = 1; rows <= 6; rows++) {
    const cols = count / rows;
    if (!Number.isInteger(cols) || cols > 6) continue;
    if (best === null || Math.abs(rows - cols) < Math.abs(best.rows - best.cols)) best = { rows, cols };
  }
  if (!best) throw new RangeError(`${count} tiles cannot be laid out as at most 6 rows by 6 columns.`);
  return best;
}

/** A smooth, structured picture, quick to make, with enough going on for tiles to line up. */
async function writeSource(file: string, width: number, height: number): Promise<void> {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      data[i] = 128 + 90 * Math.sin(x / 61) * Math.cos(y / 83);
      data[i + 1] = 120 + 80 * Math.sin((x + y) / 97);
      data[i + 2] = 110 + 70 * Math.cos(x / 47 - y / 71);
    }
  }
  await sharp(data, { raw: { width, height, channels: 3 } }).png().toFile(file);
}

/**
 * Runs a whole job end to end against the fake provider: no browser, no account. When the job pauses (a simulated
 * captcha, logout or usage limit) the "user" resumes it at once, as a person would after sorting it out.
 */
export async function runSimulation(options: SimulationOptions): Promise<SimulationResult> {
  process.env.IE_ALLOW_FAKE ??= '1';
  const { rows, cols } = gridFor(options.tiles);
  const width = cols * 400;
  const height = rows * 400;
  mkdirSync(options.outDir, { recursive: true });
  const sourcePath = path.join(options.outDir, 'source.png');
  await writeSource(sourcePath, width, height);

  const plan = planTiles({ width, height, rows, cols, overlapPct: 15 });
  const job: Job = {
    id: `SIM-${options.seed ?? 0}-${options.tiles}`,
    createdAt: new Date().toISOString(),
    source: { path: sourcePath, width, height, sha256: '0'.repeat(64) },
    prompt: 'Enhance this tile.',
    promptSource: 'user',
    categoryId: 'env-realistic',
    categorySource: 'user',
    grid: { rows, cols, overlapPct: 15 },
    providerId: 'gemini',
  };

  const dbPath = path.join(options.outDir, 'jobs.sqlite');
  const store: Store = openStore(dbPath);
  try {
    store.createJob({ job, plan, mode: options.mode ?? 'chained' });
    const adapter = new FakeAdapter({
      id: 'gemini',
      outputDir: path.join(options.outDir, 'provider'),
      seed: options.seed ?? 0,
      failRate: options.failRate,
      ...(options.failureModes ? { failureModes: options.failureModes } : {}),
    });

    const run = () =>
      runJob({
        store,
        jobId: job.id,
        adapter,
        workDir: path.join(options.outDir, 'work'),
        getSessionStatus: async () => 'ready',
        sleep: async () => {},
      });

    let result = await run();
    let pauses = 0;
    while (result.state === 'paused' && pauses < (options.maxPauses ?? 200)) {
      pauses++;
      result = await run();
    }

    return {
      jobId: job.id,
      state: result.state,
      tiles: store.listTiles(job.id).map((t) => ({ index: t.index, state: t.state, attempts: t.attempts })),
      pauses,
      providerCalls: adapter.calls,
      ...(result.stitched ? { stitched: result.stitched } : {}),
      ...(result.message ? { message: result.message } : {}),
      dbPath,
    };
  } finally {
    store.close();
  }
}
