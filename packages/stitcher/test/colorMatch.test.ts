import type { TilePlan } from '@ie/contracts';
import { extractRegion, planTiles, type Rgba } from '@ie/slicer';
import { describe, expect, it } from 'vitest';

import { applyCorrection, findOverlaps, matchColors, type Correction } from '../src';
import { castLab, pixel, solid, structured, type LabCast } from './support/synth';

const source = structured(900, 600, 41);

function tileImages(plan: TilePlan, from: Rgba = source, casts: Record<number, LabCast> = {}): Map<number, Rgba> {
  return new Map(
    plan.tiles.map((tile) => {
      const image: Rgba = { data: extractRegion(from, tile.crop, plan.wrap), width: tile.crop.width, height: tile.crop.height };
      return [tile.index, casts[tile.index] ? castLab(image, casts[tile.index]!) : image];
    }),
  );
}

describe('findOverlaps', () => {
  it('finds every pair of crops that share pixels, neighbours and diagonals alike', () => {
    const plan = planTiles({ width: 900, height: 600, rows: 2, cols: 3, overlapPct: 10 });
    const overlaps = findOverlaps(plan);
    // 4 horizontal + 3 vertical + 4 diagonal neighbours on a 2x3 grid.
    expect(overlaps).toHaveLength(11);
    expect(overlaps.every((o) => o.ox === 0 && o.oy === 0)).toBe(true);

    const pair = overlaps.find((o) => o.a === 0 && o.b === 1)!;
    expect(pair.rect).toEqual({ x: 270, y: 0, width: 60, height: 330 });
  });

  it('finds nothing when tiles do not overlap, and ignores slivers too small to measure', () => {
    expect(findOverlaps(planTiles({ width: 900, height: 600, rows: 2, cols: 3, overlapPct: 0 }))).toEqual([]);
    expect(findOverlaps(planTiles({ width: 60, height: 60, rows: 3, cols: 3, overlapPct: 10 }))).toEqual([]);
  });

  it('adds the pairs that meet across the wrap-around edge, with their shift', () => {
    const plain = findOverlaps(planTiles({ width: 900, height: 600, rows: 2, cols: 3, overlapPct: 10 }));
    const wrapped = findOverlaps(planTiles({ width: 900, height: 600, rows: 2, cols: 3, overlapPct: 10, wrap: true }));
    expect(wrapped.length).toBeGreaterThan(plain.length);
    expect(wrapped.some((o) => o.a === 0 && o.b === 2 && o.ox === -900 && o.oy === 0)).toBe(true);
    expect(wrapped.some((o) => o.a === 0 && o.b === 3 && o.ox === 0 && o.oy === -600)).toBe(true);
  });
});

describe('matchColors', () => {
  const plan = planTiles({ width: 900, height: 600, rows: 2, cols: 3, overlapPct: 15 });

  it('changes nothing for tiles that already agree, and returns the very same images', () => {
    const images = tileImages(plan);
    const result = matchColors(plan, images);
    expect(result.corrections.every((c) => c.identity)).toBe(true);
    for (const [index, image] of images) expect(result.images.get(index)).toBe(image);
    expect(result.before.maxDeltaE).toBeLessThan(1e-9);
    expect(result.after.maxDeltaE).toBeLessThan(1e-9);
    expect(result.overlaps).toBeGreaterThan(0);
  });

  it('corrects synthetic Lab casts to a mean difference of 3 or less in every overlap', () => {
    const casts = { 1: { dL: 9 }, 2: { da: -10, db: 8 }, 4: { dL: -6, gainL: 1.15 } };
    const result = matchColors(plan, tileImages(plan, source, casts));

    expect(result.before.maxDeltaE).toBeGreaterThan(6);
    expect(result.after.maxDeltaE).toBeLessThanOrEqual(3);
    for (const o of result.after.perOverlap) expect(o.deltaE).toBeLessThanOrEqual(3);
    expect(result.corrections.some((c) => !c.identity)).toBe(true);
  });

  it('measures the real pixels, not just its own model: the corrected images agree in the overlaps', () => {
    const result = matchColors(plan, tileImages(plan, source, { 1: { dL: 9 }, 2: { da: -10, db: 8 } }));
    const again = matchColors(plan, result.images);
    // Matching the corrected tiles a second time finds (almost) nothing left to fix.
    expect(again.before.maxDeltaE).toBeLessThanOrEqual(3);
  });

  it('does not drift: the same cast on every tile needs no correction at all', () => {
    const all = Object.fromEntries(plan.tiles.map((t) => [t.index, { dL: 6, da: 3 }]));
    const result = matchColors(plan, tileImages(plan, source, all));
    expect(result.corrections.every((c) => c.identity)).toBe(true);
  });

  it('spreads a drift along a chain of tiles instead of piling it on one end', () => {
    const strip = planTiles({ width: 1200, height: 300, rows: 1, cols: 6, overlapPct: 20 });
    // Each tile is 2 L brighter than the one before: neighbours differ a little, the two ends by 10.
    const casts = Object.fromEntries(strip.tiles.map((t) => [t.index, { dL: 2 * t.index }]));
    const result = matchColors(strip, tileImages(strip, structured(1200, 300, 42), casts));

    expect(result.after.maxDeltaE).toBeLessThan(0.75);
    const offsets = result.corrections.map((c) => c.offset[0]);
    for (let i = 1; i < offsets.length; i++) expect(offsets[i]!).toBeLessThan(offsets[i - 1]!); // darker toward the bright end
    // Anchored near "no correction": the corrections as a whole stay balanced around zero.
    expect(Math.abs(offsets.reduce((a, b) => a + b, 0) / offsets.length)).toBeLessThan(1.5);
    expect(Math.max(...offsets.map(Math.abs))).toBeLessThan(7);
  });

  it('leaves excluded tiles out of both the measurement and the correction', () => {
    const images = tileImages(plan, source, { 3: { dL: 40, da: 30 } });
    const result = matchColors(plan, images, new Set([3]));
    expect(result.images.get(3)).toBe(images.get(3));
    expect(result.corrections[3]!.identity).toBe(true);
    // Without the wild tile in the mix, everything else already agrees.
    expect(result.corrections.every((c) => c.identity)).toBe(true);
  });

  it('only shifts the mean for a flat channel, since a gain cannot be measured on it', () => {
    const flatPlan = planTiles({ width: 600, height: 400, rows: 1, cols: 2, overlapPct: 20 });
    const images = new Map<number, Rgba>(flatPlan.tiles.map((t) => [t.index, solid(t.crop.width, t.crop.height, t.index === 0 ? [120, 120, 120] : [140, 140, 140])]));
    const result = matchColors(flatPlan, images);
    expect(result.after.maxDeltaE).toBeLessThan(1);
    for (const c of result.corrections) expect(c.gain).toEqual([1, 1, 1]);
  });

  it('limits how far one tile can be pushed', () => {
    const result = matchColors(plan, tileImages(plan, source, { 1: { dL: 60 } }));
    for (const c of result.corrections) {
      expect(Math.abs(c.offset[0])).toBeLessThanOrEqual(25);
      expect(c.gain[0]).toBeGreaterThanOrEqual(0.8);
      expect(c.gain[0]).toBeLessThanOrEqual(1.25);
    }
  });

  it('does nothing when there are no overlaps to learn from', () => {
    const apart = planTiles({ width: 900, height: 600, rows: 2, cols: 3, overlapPct: 0 });
    const images = tileImages(apart, source, { 1: { dL: 20 } });
    const result = matchColors(apart, images);
    expect(result.overlaps).toBe(0);
    expect(result.corrections.every((c) => c.identity)).toBe(true);
    expect(result.before.maxDeltaE).toBe(0);
    expect(result.after.maxDeltaE).toBe(0);
    for (const [index, image] of images) expect(result.images.get(index)).toBe(image);
  });

  it('includes overlaps across the wrap border when matching', () => {
    const wrapPlan = planTiles({ width: 900, height: 600, rows: 2, cols: 3, overlapPct: 15, wrap: true });
    const result = matchColors(wrapPlan, tileImages(wrapPlan, source, { 0: { dL: 10 }, 2: { dL: -5 } }));
    expect(result.after.maxDeltaE).toBeLessThanOrEqual(3);
    expect(result.after.perOverlap.some((o) => o.a === 0 && o.b === 2)).toBe(true);
  });
});

describe('applyCorrection', () => {
  const image = structured(30, 20, 43);
  const correction = (over: Partial<Correction>): Correction => ({ gain: [1, 1, 1], offset: [0, 0, 0], identity: false, ...over });

  it('returns the same image for an identity correction', () => {
    expect(applyCorrection(image, { gain: [1, 1, 1], offset: [0, 0, 0], identity: true })).toBe(image);
  });

  it('applies gain and offset in Lab, keeping alpha, and never modifies its input', () => {
    const before = Buffer.from(image.data);
    const out = applyCorrection(image, correction({ offset: [10, 0, 0] }));
    expect(image.data.equals(before)).toBe(true);
    expect(out.data).not.toBe(image.data);
    for (let i = 0; i < out.data.length; i += 4) expect(out.data[i + 3]).toBe(255);
    // Brighter overall.
    expect(pixel(out, 5, 5)[0]! + pixel(out, 5, 5)[1]! + pixel(out, 5, 5)[2]!).toBeGreaterThan(pixel(image, 5, 5)[0]! + pixel(image, 5, 5)[1]! + pixel(image, 5, 5)[2]!);
  });

  it('clamps colours that leave the gamut', () => {
    const out = applyCorrection(solid(4, 4, [250, 250, 250]), correction({ offset: [40, 0, 0] }));
    expect(pixel(out, 0, 0)).toEqual([255, 255, 255, 255]);
  });
});
