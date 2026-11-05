import { planTiles, type Rgba } from '@ie/slicer';
import { describe, expect, it } from 'vitest';

import { findOverlaps, seamScore } from '../src';
import { structured } from './support/synth';

/** A seamless texture: sums of sines with whole numbers of cycles across the image, so opposite edges match. */
function periodic(width: number, height: number): Rgba {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = (2 * Math.PI * x) / width;
      const v = (2 * Math.PI * y) / height;
      const i = (y * width + x) * 4;
      data[i] = 128 + 70 * Math.sin(3 * u + v) + 30 * Math.sin(7 * u - 2 * v);
      data[i + 1] = 128 + 70 * Math.sin(2 * u + 3 * v) + 30 * Math.cos(5 * v);
      data[i + 2] = 128 + 60 * Math.cos(4 * u - v) + 30 * Math.sin(6 * v + u);
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

/** Adds a step of `amount` to every pixel at or beyond column `x`, as a seam would. */
function step(image: Rgba, x0: number, amount: number): Rgba {
  const data = Buffer.from(image.data);
  for (let y = 0; y < image.height; y++) {
    for (let x = x0; x < image.width; x++) {
      for (let c = 0; c < 3; c++) {
        const i = (y * image.width + x) * 4 + c;
        data[i] = Math.max(0, Math.min(255, data[i]! + amount));
      }
    }
  }
  return { data, width: image.width, height: image.height };
}

describe('seamScore', () => {
  it('is exactly 1 for an image identical to its reference, hard-edged content included', () => {
    const plan = planTiles({ width: 600, height: 400, rows: 2, cols: 3, overlapPct: 15 });
    const source = structured(600, 400, 3);
    const { seamScore: score, perOverlap } = seamScore(plan, source, source);
    expect(perOverlap.length).toBeGreaterThan(0);
    expect(score).toBe(1);
  });

  it('without a reference, a hard edge of the content counts as a spike (why the reference matters)', () => {
    const plan = planTiles({ width: 600, height: 400, rows: 2, cols: 3, overlapPct: 15 });
    const source = structured(600, 400, 3);
    expect(seamScore(plan, source).seamScore).toBeGreaterThan(seamScore(plan, source, source).seamScore);
  });

  it('is not fooled by a slightly different (enhanced) image: smooth changes are not seams', () => {
    const plan = planTiles({ width: 600, height: 400, rows: 2, cols: 3, overlapPct: 15 });
    const source = structured(600, 400, 3);
    const enhanced = Buffer.from(source.data);
    for (let i = 0; i < enhanced.length; i += 4) for (let c = 0; c < 3; c++) enhanced[i + c] = Math.max(0, Math.round(enhanced[i + c]! * 0.92 - 3));
    expect(seamScore(plan, { ...source, data: enhanced }, source).seamScore).toBeLessThanOrEqual(1.2);
  });

  it('rises well above the threshold when a step runs through an overlap', () => {
    const plan = planTiles({ width: 600, height: 400, rows: 1, cols: 2, overlapPct: 15 });
    const overlap = findOverlaps(plan)[0]!.rect;
    const source = structured(600, 400, 3);
    const image = step(source, overlap.x + Math.floor(overlap.width / 2), 90);
    expect(seamScore(plan, image, source).seamScore).toBeGreaterThan(1.5);
  });

  it('names the pair of tiles that has the seam', () => {
    const plan = planTiles({ width: 600, height: 400, rows: 1, cols: 3, overlapPct: 15 });
    const overlaps = findOverlaps(plan);
    const second = overlaps[1]!;
    const source = structured(600, 400, 3);
    const image = step(source, second.rect.x + Math.floor(second.rect.width / 2), 90);
    const report = seamScore(plan, image, source);
    const worst = report.perOverlap.reduce((a, b) => (b.score > a.score ? b : a));
    expect([worst.a, worst.b]).toEqual([second.a, second.b]);
  });

  it('is exactly 1 when there is nothing to measure (one tile, no overlaps)', () => {
    const plan = planTiles({ width: 200, height: 100, rows: 1, cols: 1, overlapPct: 15 });
    expect(seamScore(plan, structured(200, 100, 1)).seamScore).toBe(1);
  });

  it('does not blow up on a flat image', () => {
    const plan = planTiles({ width: 300, height: 200, rows: 2, cols: 2, overlapPct: 15 });
    const flatImage: Rgba = { data: Buffer.alloc(300 * 200 * 4, 128), width: 300, height: 200 };
    expect(seamScore(plan, flatImage).seamScore).toBe(1);
  });

  describe('wrap plans measure across the image border', () => {
    const plan = planTiles({ width: 600, height: 400, rows: 2, cols: 3, overlapPct: 15, wrap: true });

    it('a seamless texture scores about 1', () => {
      expect(seamScore(plan, periodic(600, 400)).seamScore).toBeLessThanOrEqual(1.2);
    });

    it('a texture whose edges do not match scores high', () => {
      // Brighten the right edge only: the border between the right and left edges now has a step.
      const broken = periodic(600, 400);
      for (let y = 0; y < 400; y++) for (let x = 590; x < 600; x++) for (let c = 0; c < 3; c++) broken.data[(y * 600 + x) * 4 + c] = Math.min(255, broken.data[(y * 600 + x) * 4 + c]! + 100);
      expect(seamScore(plan, broken).seamScore).toBeGreaterThan(1.5);
    });
  });
});
