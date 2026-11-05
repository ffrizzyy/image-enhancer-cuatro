import type { BlendMode } from '@ie/contracts';
import type { Rgba } from '@ie/slicer';
import { describe, expect, it } from 'vitest';

import { blendPair, transpose, type BlendStats, type Placed } from '../src';
import { meanAbsDiff, pixel, solid, structured } from './support/synth';

const MODES: BlendMode[] = ['multiband', 'feather'];
const placed = (image: Rgba, x: number, y: number): Placed => ({ image, x, y });

/** Copies a region of an image (for building two overlapping views of one picture). */
function crop(image: Rgba, x: number, y: number, width: number, height: number): Rgba {
  const data = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row++) image.data.copy(data, row * width * 4, ((y + row) * image.width + x) * 4, ((y + row) * image.width + x + width) * 4);
  return { data, width, height };
}

describe.each(MODES)('blendPair (%s)', (mode) => {
  it('returns the union canvas and copies pixels outside the overlap exactly', () => {
    const a = structured(120, 80, 1);
    const b = structured(100, 80, 2);
    const out = blendPair(placed(a, 10, 5), placed(b, 90, 5), { mode });

    expect([out.x, out.y, out.image.width, out.image.height]).toEqual([10, 5, 180, 80]);
    for (const [x, y] of [[0, 0], [30, 40], [79, 79]] as const) expect(pixel(out.image, x, y)).toEqual(pixel(a, x, y)); // left of the overlap
    for (const [x, y] of [[150, 0], [170, 40], [179, 79]] as const) expect(pixel(out.image, x, y)).toEqual(pixel(b, x - 80, y)); // right of it
  });

  it('reproduces an image exactly when both sides are the same picture', () => {
    const whole = structured(300, 140, 3);
    const out = blendPair(placed(crop(whole, 0, 0, 190, 140), 0, 0), placed(crop(whole, 110, 0, 190, 140), 110, 0), { mode });
    expect([out.image.width, out.image.height]).toEqual([300, 140]);
    expect(out.image.data.equals(whole.data)).toBe(true);
  });

  it('puts the left image on the left of the overlap and the right image on the right', () => {
    const out = blendPair(placed(solid(100, 60, [200, 20, 20]), 0, 0), placed(solid(100, 60, [20, 20, 200]), 60, 0), { mode });
    const [r0, , b0] = pixel(out.image, 61, 30);
    const [r1, , b1] = pixel(out.image, 98, 30);
    expect(r0!).toBeGreaterThan(b0!);
    expect(b1!).toBeGreaterThan(r1!);
    expect(pixel(out.image, 10, 30)).toEqual([200, 20, 20, 255]);
    expect(pixel(out.image, 150, 30)).toEqual([20, 20, 200, 255]);
  });

  it('is independent of the order the two images are passed in', () => {
    const a = placed(structured(150, 90, 4), 0, 0);
    const b = placed(structured(150, 90, 5), 100, 0);
    expect(blendPair(a, b, { mode }).image.data.equals(blendPair(b, a, { mode }).image.data)).toBe(true);
  });

  it('keeps blended pixels opaque and within range, even for very narrow overlaps', () => {
    for (const overlap of [4, 5, 7, 8, 15]) {
      const a = placed(structured(60, 50, 6), 0, 0);
      const b = placed(structured(60, 50, 7), 60 - overlap, 0);
      const out = blendPair(a, b, { mode });
      for (let i = 3; i < out.image.data.length; i += 4) expect(out.image.data[i]).toBe(255);
      expect(out.image.width).toBe(120 - overlap);
    }
  });

  it('splits an overlap too narrow to blend down the middle', () => {
    const out = blendPair(placed(solid(20, 10, [255, 0, 0]), 0, 0), placed(solid(20, 10, [0, 0, 255]), 17, 0), { mode });
    // Overlap is columns 17..19 (3 wide): the first floor(3/2) = 1 column is the left image's.
    expect(pixel(out.image, 16, 5)).toEqual([255, 0, 0, 255]);
    expect(pixel(out.image, 17, 5)).toEqual([255, 0, 0, 255]);
    expect(pixel(out.image, 18, 5)).toEqual([0, 0, 255, 255]);
    expect(pixel(out.image, 19, 5)).toEqual([0, 0, 255, 255]);
  });

  it('joins images that only touch, without blending', () => {
    const out = blendPair(placed(solid(10, 10, [255, 0, 0]), 0, 0), placed(solid(10, 10, [0, 255, 0]), 10, 0), { mode });
    expect([out.image.width, out.image.height]).toEqual([20, 10]);
    expect(pixel(out.image, 9, 3)).toEqual([255, 0, 0, 255]);
    expect(pixel(out.image, 10, 3)).toEqual([0, 255, 0, 255]);
  });

  it('routes the seam around where the two images disagree', () => {
    // Identical except for a loud patch in the first ten columns of the overlap.
    const base = structured(200, 80, 8);
    const left = crop(base, 0, 0, 120, 80);
    const right = crop(base, 80, 0, 120, 80);
    for (let y = 0; y < 80; y++) for (let x = 0; x < 10; x++) right.data.set([255, 0, 255, 255], (y * 120 + x) * 4); // columns 80..89 of the output
    const out = blendPair(placed(left, 0, 0), placed(right, 80, 0), { mode });

    // The seam keeps clear of the patch, so the patch (a 150+ level difference) does not show up. The feather
    // leaves those pixels exactly alone; multiband spreads low frequencies, so allow a little leakage.
    const tolerance = mode === 'feather' ? 0 : 30;
    for (const [x, y] of [[81, 10], [85, 40], [88, 70]] as const) {
      const got = pixel(out.image, x, y);
      const want = pixel(base, x, y);
      for (let c = 0; c < 3; c++) expect(Math.abs(got[c]! - want[c]!)).toBeLessThanOrEqual(tolerance);
    }
  });

  it('works on tall, narrow and single-row regions', () => {
    const tall = blendPair(placed(structured(30, 400, 9), 0, 0), placed(structured(30, 400, 10), 14, 0), { mode });
    expect([tall.image.width, tall.image.height]).toEqual([44, 400]);
    const flat = blendPair(placed(structured(40, 1, 11), 0, 0), placed(structured(40, 1, 12), 25, 0), { mode });
    expect([flat.image.width, flat.image.height]).toEqual([65, 1]);
  });
});

describe('blending happens in linear light', () => {
  it('mixing black and white halfway gives sRGB 188, not the gamma-mixed 128', () => {
    const out = blendPair(placed(solid(80, 20, [0, 0, 0]), 0, 0), placed(solid(80, 20, [255, 255, 255]), 40, 0), { mode: 'feather' });
    // The seam is in the middle of the overlap (columns 40..79), where the feather is 50/50.
    const middle = pixel(out.image, 60, 10)[0]!;
    expect(middle).toBeGreaterThan(170);
    expect(middle).toBeLessThan(205);
  });
});

describe('multiband versus feather', () => {
  it('multiband spreads low frequencies much wider than the feather, but both stay inside the overlap', () => {
    const a = placed(solid(200, 40, [40, 40, 40]), 0, 0);
    const b = placed(solid(200, 40, [210, 210, 210]), 120, 0);
    const multi = blendPair(a, b, { mode: 'multiband' });
    const feather = blendPair(a, b, { mode: 'feather' });
    const transition = (out: Placed) => {
      let first = -1;
      let last = -1;
      for (let x = 0; x < out.image.width; x++) {
        const v = pixel(out.image, x, 20)[0]!;
        if (v > 41 && first < 0) first = x;
        if (v < 209) last = x;
      }
      return [first, last] as const;
    };
    const [mf, ml] = transition(multi);
    const [ff, fl] = transition(feather);
    expect(ml - mf).toBeGreaterThanOrEqual(fl - ff);
    for (const out of [multi, feather]) {
      expect(pixel(out.image, 100, 20)[0]).toBe(40); // left of the overlap (columns 120..199)
      expect(pixel(out.image, 310, 20)[0]).toBe(210);
    }
  });
});

describe('chunked blending', () => {
  it('gives the same picture whatever the chunk size, and bounds the working memory', () => {
    const whole = structured(420, 700, 13);
    const a = placed(crop(whole, 0, 0, 260, 700), 0, 0);
    const b = placed(crop(whole, 200, 0, 220, 700), 200, 0);
    // Make the two views disagree a little so blending actually has work to do.
    for (let i = 0; i < b.image.data.length; i += 4) b.image.data[i] = Math.min(255, b.image.data[i]! + 12);

    const big: BlendStats = { chunks: 0, peakFloatPixels: 0 };
    const small: BlendStats = { chunks: 0, peakFloatPixels: 0 };
    const one = blendPair(a, b, { mode: 'multiband', chunkRows: 100_000, stats: big });
    const many = blendPair(a, b, { mode: 'multiband', chunkRows: 64, stats: small });

    expect(big.chunks).toBe(1);
    expect(small.chunks).toBeGreaterThanOrEqual(11);
    const region = { x: 0, y: 0, width: 420, height: 700 };
    expect(meanAbsDiff(one.image, many.image, region)).toBeLessThan(0.5);

    // Overlap is 60 columns -> 4 levels: padding 32 columns, margin 64 rows each side.
    expect(small.peakFloatPixels).toBeLessThanOrEqual((60 + 2 * 32) * (64 + 2 * 64));
    expect(small.peakFloatPixels).toBeLessThan(big.peakFloatPixels / 3);
  });

  it('records nothing for feather blends or when there is no overlap', () => {
    const stats: BlendStats = { chunks: 0, peakFloatPixels: 0 };
    blendPair(placed(structured(50, 50, 1), 0, 0), placed(structured(50, 50, 2), 30, 0), { mode: 'feather', stats });
    blendPair(placed(structured(50, 50, 1), 0, 0), placed(structured(50, 50, 2), 80, 0), { mode: 'multiband', stats });
    expect(stats).toEqual({ chunks: 0, peakFloatPixels: 0 });
  });
});

describe('transpose', () => {
  it('swaps rows and columns and the position, and undoes itself', () => {
    const image = structured(7, 4, 14);
    const t = transpose(placed(image, 3, 9));
    expect([t.image.width, t.image.height, t.x, t.y]).toEqual([4, 7, 9, 3]);
    expect(pixel(t.image, 2, 5)).toEqual(pixel(image, 5, 2));
    const back = transpose(t);
    expect(back.image.data.equals(image.data)).toBe(true);
    expect([back.x, back.y]).toEqual([3, 9]);
  });
});
