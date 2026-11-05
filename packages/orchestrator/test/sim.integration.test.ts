import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { gridFor, runSimulation, tileTransition } from '../src';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ie-orch-sim-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const out = () => path.join(dir, `run-${++n}`);

describe('gridFor', () => {
  it('lays tiles out as a near-square grid of at most 6 by 6', () => {
    expect(gridFor(8)).toEqual({ rows: 2, cols: 4 });
    expect(gridFor(6)).toEqual({ rows: 2, cols: 3 });
    expect(gridFor(1)).toEqual({ rows: 1, cols: 1 });
    expect(gridFor(9)).toEqual({ rows: 3, cols: 3 });
    expect(gridFor(36)).toEqual({ rows: 6, cols: 6 });
  });

  it.each([0, -1, 2.5, 7, 37, 13])('refuses %s tiles', (count) => {
    expect(() => gridFor(count)).toThrow(RangeError);
  });
});

describe('a simulated 8-tile job with 20% injected failures (the plan\'s acceptance case)', () => {
  it('finishes with every tile accepted, and a stitched picture of the right size', async () => {
    const result = await runSimulation({ tiles: 8, failRate: 0.2, seed: 1, outDir: out() });

    expect(result.state).toBe('done');
    expect(result.tiles).toHaveLength(8);
    expect(result.tiles.every((t) => t.state === 'accepted')).toBe(true);
    expect(result.providerCalls).toBeGreaterThanOrEqual(8);
    const meta = await sharp(result.stitched!.imagePath).metadata();
    expect([meta.width, meta.height]).toEqual([1600, 800]); // 4 x 2 tiles of 400 px
    expect(result.stitched!.metrics.seamScore).toBeLessThanOrEqual(1.2);
  });

  it('is repeatable: the same seed gives the same run', async () => {
    const a = await runSimulation({ tiles: 8, failRate: 0.3, seed: 9, outDir: out() });
    const b = await runSimulation({ tiles: 8, failRate: 0.3, seed: 9, outDir: out() });
    expect([a.state, a.pauses, a.providerCalls, a.tiles]).toEqual([b.state, b.pauses, b.providerCalls, b.tiles]);
  });

  for (const mode of ['chained', 'independent'] as const) {
    for (const failRate of [0.2, 0.5, 0.8]) {
      it(`${mode}, fail rate ${failRate}: every tile ends accepted or set aside for review, never lost or left unfinished`, async () => {
        for (const seed of [1, 2, 3]) {
          const result = await runSimulation({ tiles: 8, failRate, seed, mode, outDir: out() });
          expect(['done', 'needs-review'], `seed ${seed}: ${result.message}`).toContain(result.state);
          for (const tile of result.tiles) expect(['accepted', 'needs-review']).toContain(tile.state);
          // A "done" job has stitched every tile; "needs-review" means at least one tile is waiting for a person.
          if (result.state === 'done') expect(result.tiles.every((t) => t.state === 'accepted') && result.stitched !== undefined).toBe(true);
          else expect(result.tiles.some((t) => t.state === 'needs-review')).toBe(true);
        }
      });
    }
  }

  it('with no failures makes exactly one provider call per tile', async () => {
    const result = await runSimulation({ tiles: 6, failRate: 0, seed: 1, outDir: out() });
    expect([result.state, result.providerCalls, result.pauses]).toEqual(['done', 6, 0]);
  });

  it('resumes simulated pauses (captcha, logout, usage limit) and loses no work', async () => {
    const result = await runSimulation({ tiles: 6, failRate: 0.5, seed: 4, failureModes: ['challenge', 'logged-out', 'quota'], outDir: out() });
    expect(result.pauses).toBeGreaterThan(0);
    expect(result.state).toBe('done');
    // Pauses never count as a failed try: every tile needed exactly one real attempt that succeeded, plus the interrupted ones.
    expect(result.tiles.every((t) => t.state === 'accepted')).toBe(true);
  });

  it('keeps the whole run in the job database', async () => {
    const result = await runSimulation({ tiles: 4, failRate: 0.3, seed: 2, outDir: out() });
    expect(existsSync(result.dbPath)).toBe(true);
  });
});

describe('the sim command', () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'sim.mjs');
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

  it('prints a report and exits 0 when every tile settles', () => {
    const result = run('--tiles', '4', '--fail-rate', '0.2', '--seed', '3', '--out', out());
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Simulated job: 4 tiles, chained, fail rate 0\.2, seed 3/);
    expect(result.stdout).toMatch(/Result: done/);
    expect(result.stdout).toMatch(/Tiles: 4 accepted, 0 need review/);
    expect(result.stdout).toMatch(/Stitched: .*stitched\.png/);
  }, 120_000);

  it('accepts the lone -- that pnpm passes along', () => {
    expect(run('--', '--tiles', '2', '--fail-rate', '0', '--out', out()).status).toBe(0);
  }, 120_000);

  it('explains a bad option and exits 2', () => {
    const result = run('--fail-rate', '3');
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--fail-rate must be from 0 to 1/);
    expect(run('--tiles').stderr).toMatch(/Missing a value after --tiles/);
    expect(run('--nonsense', '1').stderr).toMatch(/Unknown option --nonsense/);
    expect(run('--mode', 'sideways').stderr).toMatch(/chained or independent/);
  }, 120_000);
});

describe('REJECT with final', () => {
  it('sets a tile aside for review whatever tries are left', () => {
    expect(tileTransition('running', 1, { type: 'REJECT', final: true })).toEqual({ ok: true, state: 'needs-review' });
    expect(tileTransition('running', 1, { type: 'REJECT' })).toEqual({ ok: true, state: 'retrying' });
  });
});
