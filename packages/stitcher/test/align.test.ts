import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { extractRegion, planTiles, type Rgba } from '@ie/slicer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { alignTiles, DEFAULT_MAX_SHIFT_PX, estimateShift, needsReview, shiftImage } from '../src';
import { adjust, blur, flat, meanAbsDiff, pixel, resize, structured, writePng } from './support/synth';

const SHIFTS = Array.from({ length: 17 }, (_, i) => i - 8);

describe('shiftImage', () => {
  it('moves content by whole pixels and repeats the nearest edge pixel', () => {
    const image = structured(20, 10, 1);
    const out = shiftImage(image, 3, -2);
    expect(pixel(out, 10, 4)).toEqual(pixel(image, 7, 6));
    expect(pixel(out, 0, 4)).toEqual(pixel(image, 0, 6)); // x < 3 comes from the left edge
    expect(pixel(out, 10, 9)).toEqual(pixel(image, 7, 9)); // y > 7 comes from the bottom edge
  });

  it('returns the same image for a zero shift, and handles shifts larger than the image', () => {
    const image = structured(10, 10, 2);
    expect(shiftImage(image, 0, 0)).toBe(image);
    const far = shiftImage(image, 50, -50);
    expect(pixel(far, 5, 5)).toEqual(pixel(image, 0, 9));
  });
});

describe('estimateShift', () => {
  const ref = structured(300, 300, 11);

  it('recovers every integer shift from -8 to +8 in both axes, exactly', { timeout: 120_000 }, () => {
    for (const dy of SHIFTS) {
      for (const dx of SHIFTS) {
        const estimate = estimateShift(ref, shiftImage(ref, dx, dy));
        expect({ dx: estimate.dx, dy: estimate.dy, ok: estimate.confident && !estimate.exceedsMax }).toEqual({ dx, dy, ok: true });
      }
    }
  });

  it('reports zero for an identical tile', () => {
    expect(estimateShift(ref, ref)).toMatchObject({ dx: 0, dy: 0, confident: true, exceedsMax: false });
    expect(estimateShift(ref, ref).score).toBeGreaterThan(0.99);
  });

  it('uses the sign convention: tile pixel (x+dx, y+dy) shows ref pixel (x, y)', () => {
    const tile = shiftImage(ref, 5, -3);
    expect(pixel(tile, 105, 97)).toEqual(pixel(ref, 100, 100));
    expect(estimateShift(ref, tile)).toMatchObject({ dx: 5, dy: -3 });
  });

  it('flags shifts beyond 8 px, in the range the search can measure', () => {
    for (const [dx, dy] of [[9, 0], [0, -9], [10, 4], [-11, 7], [12, -12], [-9, -9]] as const) {
      const estimate = estimateShift(ref, shiftImage(ref, dx, dy));
      expect(estimate.exceedsMax, `${dx},${dy}`).toBe(true);
      expect({ dx: estimate.dx, dy: estimate.dy }).toEqual({ dx, dy });
    }
  });

  it('measures shifts up to several times the limit, and sends anything beyond for review', () => {
    for (const [dx, dy] of [[20, 0], [-30, 5], [0, 28]] as const) {
      const estimate = estimateShift(ref, shiftImage(ref, dx, dy));
      expect({ dx: estimate.dx, dy: estimate.dy, review: needsReview(estimate) }, `${dx},${dy}`).toEqual({ dx, dy, review: true });
    }
    // Far beyond anything the search covers: nothing matches, which also needs review.
    for (const [dx, dy] of [[-70, 5], [0, 90], [120, -120]] as const) {
      expect(needsReview(estimateShift(ref, shiftImage(ref, dx, dy))), `${dx},${dy}`).toBe(true);
    }
  });

  it('allows exactly maxShiftPx and flags one more, for any limit', () => {
    expect(DEFAULT_MAX_SHIFT_PX).toBe(8);
    expect(estimateShift(ref, shiftImage(ref, 8, -8)).exceedsMax).toBe(false);
    expect(estimateShift(ref, shiftImage(ref, 9, 0)).exceedsMax).toBe(true);
    expect(estimateShift(ref, shiftImage(ref, 3, 0), 3).exceedsMax).toBe(false);
    expect(estimateShift(ref, shiftImage(ref, 4, 0), 3).exceedsMax).toBe(true);
  });

  it('tolerates brightness and contrast changes, blur and noise-like enhancement', async () => {
    const enhanced = adjust(await blur(shiftImage(ref, 6, -5), 0.8), 1.2, 12);
    expect(estimateShift(ref, enhanced)).toMatchObject({ dx: 6, dy: -5, confident: true, exceedsMax: false });
  });

  it('works on small images (full-resolution search) and large ones (coarse + refine)', () => {
    const small = structured(64, 64, 12);
    expect(estimateShift(small, shiftImage(small, 5, -3))).toMatchObject({ dx: 5, dy: -3 });

    const large = structured(1200, 900, 13);
    const started = performance.now();
    for (const [dx, dy] of [[7, -6], [-8, 8], [0, 3]] as const) {
      expect(estimateShift(large, shiftImage(large, dx, dy))).toMatchObject({ dx, dy, exceedsMax: false });
    }
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('does not correct what it cannot trust, and tells "nothing to align on" from "does not match"', () => {
    // A flat reference carries no information: no shift, and no review needed.
    const flatEstimate = estimateShift(flat(200, 200), flat(200, 200, 90));
    expect(flatEstimate).toMatchObject({ dx: 0, dy: 0, confident: false, flat: true, exceedsMax: false });
    expect(needsReview(flatEstimate)).toBe(false);
    expect(needsReview(estimateShift(flat(200, 200), structured(200, 200, 23)))).toBe(false);

    // A textured reference that matches nothing in the tile: left alone, but sent for review.
    const unrelated = estimateShift(structured(200, 200, 21), structured(200, 200, 22));
    expect(unrelated).toMatchObject({ dx: 0, dy: 0, confident: false, flat: false });
    expect(needsReview(unrelated)).toBe(true);

    // A blank output for a textured tile is also a mismatch.
    expect(needsReview(estimateShift(structured(200, 200, 24), flat(200, 200)))).toBe(true);
  });

  it('requires equal sizes', () => {
    expect(() => estimateShift(structured(10, 10, 1), structured(10, 11, 1))).toThrow(RangeError);
  });
});

describe('alignTiles', () => {
  let dir: string;
  const source = structured(900, 600, 31);
  const file = (name: string): string => path.join(dir, name);

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ie-align-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Writes each tile's send region, displaced so the content appears shifted by `shifts[i]`. */
  async function makeOutputs(plan: ReturnType<typeof planTiles>, shifts: ReadonlyArray<readonly [number, number]>, label: string, scale = 1) {
    const outputs: Array<{ index: number; path: string }> = [];
    for (const tile of plan.tiles) {
      const [dx, dy] = shifts[tile.index] ?? [0, 0];
      const window = { ...tile.send, x: tile.send.x - dx, y: tile.send.y - dy };
      let image: Rgba = { data: extractRegion(source, window, plan.wrap), width: tile.send.width, height: tile.send.height };
      if (scale !== 1) image = await resize(image, Math.round(image.width * scale), Math.round(image.height * scale));
      const out = file(`${label}-${tile.index}.png`);
      await writePng(image, out);
      outputs.push({ index: tile.index, path: out });
    }
    return outputs;
  }

  /** Interior of a crop, away from the borders where a correction replicates edge pixels. */
  const interior = (w: number, h: number, margin: number) => ({ x: margin, y: margin, width: w - 2 * margin, height: h - 2 * margin });

  it('corrects zero, positive and negative shifts up to 8 px, restoring the source pixels exactly', async () => {
    const plan = planTiles({ width: 900, height: 600, rows: 2, cols: 3, overlapPct: 10 });
    const shifts = [[0, 0], [6, 4], [-6, -5], [3, -8], [-8, 8], [8, 0]] as const;
    const result = await alignTiles({ plan, source, outputs: await makeOutputs(plan, shifts, 'exact') });

    expect(result.flagged).toEqual([]);
    expect(result.tiles).toHaveLength(6);
    for (const tile of plan.tiles) {
      const aligned = result.tiles[tile.index]!;
      const [dx, dy] = shifts[tile.index]!;
      expect(aligned.shift).toEqual({ dx, dy });
      expect(aligned.confident).toBe(true);
      expect(aligned.flagged).toBe(false);

      const expected: Rgba = { data: extractRegion(source, tile.crop, false), width: tile.crop.width, height: tile.crop.height };
      expect([aligned.image.width, aligned.image.height]).toEqual([tile.crop.width, tile.crop.height]);
      expect(meanAbsDiff(aligned.image, expected, interior(tile.crop.width, tile.crop.height, 12))).toBe(0);
    }
  });

  it('flags a tile shifted by more than 8 px, leaves it uncorrected, and never drops it', async () => {
    const plan = planTiles({ width: 900, height: 600, rows: 2, cols: 3, overlapPct: 10 });
    const shifts = [[0, 0], [0, 0], [0, 0], [0, 0], [12, -3], [2, 2]] as const;
    const result = await alignTiles({ plan, source, outputs: await makeOutputs(plan, shifts, 'flag') });

    expect(result.flagged).toEqual([4]);
    expect(result.tiles).toHaveLength(6);
    const flagged = result.tiles[4]!;
    expect(flagged).toMatchObject({ index: 4, flagged: true, shift: { dx: 12, dy: -3 } });
    expect([flagged.image.width, flagged.image.height]).toEqual([plan.tiles[4]!.crop.width, plan.tiles[4]!.crop.height]);

    // Uncorrected: still displaced, so it does not match the source crop, while the others do.
    const tile = plan.tiles[4]!;
    const crop: Rgba = { data: extractRegion(source, tile.crop, false), width: tile.crop.width, height: tile.crop.height };
    expect(meanAbsDiff(flagged.image, crop, interior(tile.crop.width, tile.crop.height, 15))).toBeGreaterThan(5);
    expect(result.tiles[5]!.flagged).toBe(false);
  });

  it('handles provider outputs at a different resolution (1.5x and 2x), recovering the shift to within a pixel', async () => {
    const plan = planTiles({ width: 900, height: 600, rows: 2, cols: 3, overlapPct: 10 });
    for (const scale of [1.5, 2]) {
      const result = await alignTiles({ plan, source, outputs: await makeOutputs(plan, [[5, -4], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]], `scaled-${scale}`, scale) });
      const first = result.tiles[0]!;
      // The shift is injected at source resolution, then the output is resized: expect it back within 1 px.
      expect(Math.abs(first.shift.dx - 5)).toBeLessThanOrEqual(1);
      expect(Math.abs(first.shift.dy + 4)).toBeLessThanOrEqual(1);
      expect(result.flagged).toEqual([]);
      for (const tile of result.tiles) expect([tile.image.width, tile.image.height]).toEqual([plan.tiles[tile.index]!.crop.width, plan.tiles[tile.index]!.crop.height]);
    }
  });

  it('records when an output had to be centre-cropped to the tile shape', async () => {
    const plan = planTiles({ width: 900, height: 600, rows: 1, cols: 1, overlapPct: 0 });
    // The source is 3:2; give the "provider" a square image of it, which must be cropped, not stretched.
    const squareOutput = file('square.png');
    await writePng(await resize(source, 900, 900), squareOutput);
    const result = await alignTiles({ plan, source, outputs: [{ index: 0, path: squareOutput }] });
    expect(result.tiles[0]!.croppedToAspect).toBe(true);
  });

  it('aligns wrap-mode tiles, whose crops and padding come from the opposite edge', async () => {
    const plan = planTiles({ width: 900, height: 600, rows: 2, cols: 3, overlapPct: 15, wrap: true });
    const shifts = [[4, 3], [0, 0], [-5, 2], [0, 0], [6, -6], [0, 0]] as const;
    const result = await alignTiles({ plan, source, outputs: await makeOutputs(plan, shifts, 'wrap') });
    expect(result.flagged).toEqual([]);
    expect(result.tiles[0]!.shift).toEqual({ dx: 4, dy: 3 });
    expect(result.tiles[4]!.shift).toEqual({ dx: 6, dy: -6 });
  });

  it('leaves a featureless tile alone: not corrected, not flagged', async () => {
    const flatSource: Rgba = { ...source, data: Buffer.from(source.data) };
    for (let y = 0; y < 600; y++) for (let x = 0; x < 300; x++) flatSource.data.set([120, 120, 120, 255], (y * 900 + x) * 4);

    const plan = planTiles({ width: 900, height: 600, rows: 1, cols: 3, overlapPct: 0 });
    const outputs: Array<{ index: number; path: string }> = [];
    for (const tile of plan.tiles) {
      const image: Rgba = { data: extractRegion(flatSource, tile.send, false), width: tile.send.width, height: tile.send.height };
      const out = file(`flat-${tile.index}.png`);
      await writePng(image, out);
      outputs.push({ index: tile.index, path: out });
    }
    const result = await alignTiles({ plan, source: flatSource, outputs });

    expect(result.tiles[0]).toMatchObject({ confident: false, flagged: false, shift: { dx: 0, dy: 0 } });
    expect(result.flagged).toEqual([]);
  });

  it('honours a custom shift limit', async () => {
    const plan = planTiles({ width: 900, height: 600, rows: 1, cols: 1, overlapPct: 0 });
    const outputs = await makeOutputs(plan, [[4, 0]], 'limit');
    expect((await alignTiles({ plan, source, outputs, maxShiftPx: 3 })).flagged).toEqual([0]);
    expect((await alignTiles({ plan, source, outputs, maxShiftPx: 4 })).flagged).toEqual([]);
  });

  it('fails clearly when a tile output is missing', async () => {
    const plan = planTiles({ width: 900, height: 600, rows: 1, cols: 2, overlapPct: 0 });
    const outputs = (await makeOutputs(plan, [], 'missing')).slice(1);
    await expect(alignTiles({ plan, source, outputs })).rejects.toThrow(/Missing output for tile 0/);
  });
});
