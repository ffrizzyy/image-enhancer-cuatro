import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { StitchOptions, TilePlan } from '@ie/contracts';
import { countDifferentPixels, extractTiles, loadRgba, planTiles, type Rgba } from '@ie/slicer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { shiftImage, stitch } from '../src';
import { adjust, castLab, meanAbsDiff, structured, writePng, type LabCast } from './support/synth';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ie-stitch-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const OPTIONS: StitchOptions = { blend: 'multiband', maxShiftPx: 8, harmonize: true };
let counter = 0;

interface Job {
  source: Rgba;
  sourcePath: string;
  plan: TilePlan;
  tiles: Array<{ index: number; path: string }>;
}

/** Slice a real image file into tiles on disk: these are the "provider outputs" until a test alters them. */
async function makeJob(
  width: number,
  height: number,
  grid: { rows: number; cols: number },
  opts: { wrap?: boolean; seed?: number; safeGamut?: boolean } = {},
): Promise<Job> {
  const id = ++counter;
  // `safeGamut` keeps every channel in 38..216, so a colour cast cannot clip: clipped colours are lost and no
  // per-tile gain and offset can bring them back, which would test the clipping, not the matching.
  const base = structured(width, height, opts.seed ?? id);
  const source = opts.safeGamut ? adjust(base, 0.7, 38) : base;
  const sourcePath = path.join(dir, `source-${id}.png`);
  await writePng(source, sourcePath);
  const plan = planTiles({ width, height, ...grid, overlapPct: 15, wrap: opts.wrap ?? false });
  const extracted = await extractTiles(sourcePath, plan, path.join(dir, `tiles-${id}`));
  return { source, sourcePath, plan, tiles: extracted.tiles.map((t) => ({ index: t.index, path: t.path })) };
}

/** Rewrites a tile's file the way a provider might have changed it. */
async function alter(job: Job, index: number, change: (image: Rgba) => Rgba): Promise<void> {
  const tile = job.tiles.find((t) => t.index === index)!;
  await writePng(change(await loadRgba(tile.path)), tile.path);
}

const run = (job: Job, options: Partial<StitchOptions> = {}) =>
  stitch({ plan: job.plan, tiles: job.tiles, options: { ...OPTIONS, ...options } }, { sourcePath: job.sourcePath, outDir: path.join(dir, `out-${counter}`) });

describe('stitch', () => {
  it('reproduces the source exactly from unchanged tiles, with a perfect score', { timeout: 120_000 }, async () => {
    const job = await makeJob(1001, 777, { rows: 2, cols: 3 });
    const result = await run(job);
    const out = await loadRgba(result.imagePath);

    expect([out.width, out.height]).toEqual([1001, 777]);
    expect(countDifferentPixels(job.source.data, out.data)).toBe(0);
    expect(result.flagged).toEqual([]);
    expect(result.harmonized).toBe(false);
    expect(result.metrics.seamScore).toBe(1);
    expect(result.metrics.maxDeltaE).toBeLessThanOrEqual(0.01);
  });

  it('also reproduces the source in wrap mode and with feather blending', { timeout: 120_000 }, async () => {
    const wrap = await makeJob(600, 400, { rows: 2, cols: 3 }, { wrap: true });
    expect(countDifferentPixels(wrap.source.data, (await loadRgba((await run(wrap)).imagePath)).data)).toBe(0);

    const feather = await makeJob(600, 400, { rows: 2, cols: 2 });
    expect(countDifferentPixels(feather.source.data, (await loadRgba((await run(feather, { blend: 'feather' })).imagePath)).data)).toBe(0);
  });

  it('corrects injected shifts of up to 6 px and colour casts: seamScore <= 1.2 and maxDeltaE <= 3', { timeout: 180_000 }, async () => {
    const job = await makeJob(900, 600, { rows: 2, cols: 3 }, { safeGamut: true, seed: 7 });
    const shifts: Array<[number, number]> = [[6, 0], [-5, 3], [0, -6], [4, 4], [-6, -2], [2, 5]];
    const casts: LabCast[] = [{ dL: 4 }, { da: 5, db: -3 }, { dL: -5 }, { gainL: 1.08 }, { db: 6 }, { dL: 3, da: -4 }];
    for (let i = 0; i < 6; i++) await alter(job, i, (image) => castLab(shiftImage(image, ...shifts[i]!), casts[i]!));

    const result = await run(job);
    expect(result.flagged).toEqual([]);
    expect(result.metrics.seamScore).toBeLessThanOrEqual(1.2);
    expect(result.metrics.maxDeltaE).toBeLessThanOrEqual(3);

    // And the result is still the picture: close to the source, not just internally consistent.
    const out = await loadRgba(result.imagePath);
    expect(meanAbsDiff(job.source, out, { x: 0, y: 0, width: 900, height: 600 })).toBeLessThan(10);
  });

  it('wrap jobs with colour casts score <= 1.2 across the opposite edges too', { timeout: 180_000 }, async () => {
    const job = await makeJob(600, 400, { rows: 2, cols: 3 }, { wrap: true, safeGamut: true, seed: 9 });
    const casts: LabCast[] = [{ dL: 4 }, { da: 4, db: -3 }, { dL: -4 }, { gainL: 1.06 }, { db: 5 }, { dL: 3, da: -3 }];
    for (let i = 0; i < 6; i++) await alter(job, i, (image) => castLab(image, casts[i]!));

    const result = await run(job);
    expect(result.metrics.seamScore).toBeLessThanOrEqual(1.2);
    expect(result.metrics.maxDeltaE).toBeLessThanOrEqual(3);
  });

  it('reports a tile shifted beyond maxShiftPx instead of forcing a bad blend, and never drops it', { timeout: 120_000 }, async () => {
    const job = await makeJob(600, 400, { rows: 2, cols: 3 });
    await alter(job, 4, (image) => shiftImage(image, 30, 0));
    const result = await run(job);

    expect(result.flagged).toContain(4);
    expect(result.flaggedDetails.map((d) => d.index)).toContain(4);
    const out = await loadRgba(result.imagePath);
    expect([out.width, out.height]).toEqual([600, 400]);
  });

  it('removes large-scale drift only when harmonization is on', { timeout: 180_000 }, async () => {
    const job = await makeJob(800, 400, { rows: 1, cols: 4 });
    // One smooth lighting gradient across the whole picture, applied consistently so the tiles still agree.
    for (const tile of job.plan.tiles) {
      await alter(job, tile.index, (image) => {
        const data = Buffer.from(image.data);
        for (let y = 0; y < image.height; y++) {
          for (let x = 0; x < image.width; x++) {
            const gain = 0.82 + (0.3 * (tile.send.x + x)) / 800;
            for (let c = 0; c < 3; c++) data[(y * image.width + x) * 4 + c] = Math.min(255, Math.round(data[(y * image.width + x) * 4 + c]! * gain));
          }
        }
        return { data, width: image.width, height: image.height };
      });
    }
    const everywhere = { x: 0, y: 0, width: 800, height: 400 };
    const without = await loadRgba((await run(job, { harmonize: false })).imagePath);
    const withIt = await run(job, { harmonize: true });
    const corrected = await loadRgba(withIt.imagePath);

    expect(withIt.harmonized).toBe(true);
    // Only the variation of the drift is removed (the overall tone is kept), so some of the error remains.
    expect(meanAbsDiff(job.source, corrected, everywhere)).toBeLessThan(meanAbsDiff(job.source, without, everywhere) * 0.65);
  });

  it('refuses a source that is not the size the plan was made for', async () => {
    const job = await makeJob(300, 200, { rows: 1, cols: 2 });
    const other = path.join(dir, 'other.png');
    await writePng(structured(310, 200, 1), other);
    await expect(stitch({ plan: job.plan, tiles: job.tiles, options: OPTIONS }, { sourcePath: other, outDir: dir })).rejects.toThrow(RangeError);
  });

  it('fails clearly when a tile output is missing', async () => {
    const job = await makeJob(300, 200, { rows: 1, cols: 2 });
    await expect(stitch({ plan: job.plan, tiles: job.tiles.slice(1), options: OPTIONS }, { sourcePath: job.sourcePath, outDir: dir })).rejects.toThrow(/Missing output for tile 0/);
  });

  it('reports where the time went', { timeout: 120_000 }, async () => {
    const { timingsMs } = await run(await makeJob(300, 200, { rows: 1, cols: 2 }));
    expect(timingsMs.total).toBeGreaterThan(0);
    expect(timingsMs.total).toBeGreaterThanOrEqual(timingsMs.align + timingsMs.compose);
  });

  it('keeps the extra detail when providers return tiles twice as large as they were sent', { timeout: 120_000 }, async () => {
    const job = await makeJob(300, 200, { rows: 2, cols: 2 });
    const sharp = (await import('sharp')).default;
    for (const t of job.tiles) {
      const img = await loadRgba(t.path);
      await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
        .resize(img.width * 2, img.height * 2, { kernel: 'lanczos3' })
        .png()
        .toFile(t.path + '.2x.png');
      t.path = t.path + '.2x.png';
    }
    const result = await run(job);
    const meta = await sharp(result.imagePath).metadata();
    expect(meta.width).toBe(600);
    expect(meta.height).toBe(400);
  });
});
