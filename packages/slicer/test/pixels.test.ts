import { describe, expect, it } from 'vitest';

import { countDifferentPixels, extractRegion, mapIndex, type Rgba } from '../src';

/** A 4x3 image whose pixel (x, y) is [x, y, x + y * 10, 255]: every pixel is identifiable. */
function labelled(width = 4, height = 3): Rgba {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set([x, y, x + y * 10, 255], (y * width + x) * 4);
  }
  return { data, width, height };
}

const pixelAt = (buffer: Buffer, width: number, x: number, y: number): number[] => [...buffer.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];

describe('mapIndex', () => {
  it('is the identity inside the image', () => {
    for (const i of [0, 1, 4]) expect(mapIndex(i, 5, false)).toBe(i);
    for (const i of [0, 1, 4]) expect(mapIndex(i, 5, true)).toBe(i);
  });

  it('mirrors at the border, repeating the edge pixel', () => {
    expect([-1, -2, -5].map((i) => mapIndex(i, 5, false))).toEqual([0, 1, 4]);
    expect([5, 6, 9].map((i) => mapIndex(i, 5, false))).toEqual([4, 3, 0]);
  });

  it('keeps mirroring however far out it goes', () => {
    expect([-6, -10, 10, 14, 15].map((i) => mapIndex(i, 5, false))).toEqual([4, 0, 0, 4, 4]);
    expect(mapIndex(-3, 1, false)).toBe(0);
    expect(mapIndex(7, 1, false)).toBe(0);
  });

  it('wraps to the opposite edge when asked', () => {
    expect([-1, -5, 5, 6, 11].map((i) => mapIndex(i, 5, true))).toEqual([4, 0, 0, 1, 1]);
    expect(mapIndex(-1, 1, true)).toBe(0);
  });
});

describe('extractRegion', () => {
  it('copies a region inside the image exactly', () => {
    const out = extractRegion(labelled(), { x: 1, y: 1, width: 2, height: 2 }, false);
    expect([...out]).toEqual([1, 1, 11, 255, 2, 1, 12, 255, 1, 2, 21, 255, 2, 2, 22, 255]);
  });

  it('mirrors rows and columns past the top-left border', () => {
    const src = labelled();
    const out = extractRegion(src, { x: -2, y: -1, width: 4, height: 3 }, false);
    // Output (0,0) is source (-2,-1) -> mirrored to (1,0); output (2,1) is source (0,0).
    expect(pixelAt(out, 4, 0, 0)).toEqual(pixelAt(src.data, 4, 1, 0));
    expect(pixelAt(out, 4, 1, 0)).toEqual(pixelAt(src.data, 4, 0, 0));
    expect(pixelAt(out, 4, 2, 1)).toEqual(pixelAt(src.data, 4, 0, 0));
    expect(pixelAt(out, 4, 3, 2)).toEqual(pixelAt(src.data, 4, 1, 1));
  });

  it('mirrors past the bottom-right border', () => {
    const src = labelled();
    const out = extractRegion(src, { x: 3, y: 2, width: 3, height: 3 }, false);
    expect(pixelAt(out, 3, 0, 0)).toEqual(pixelAt(src.data, 4, 3, 2));
    expect(pixelAt(out, 3, 1, 0)).toEqual(pixelAt(src.data, 4, 3, 2)); // x=4 mirrors to 3
    expect(pixelAt(out, 3, 2, 2)).toEqual(pixelAt(src.data, 4, 2, 1)); // x=5 -> 2, y=4 -> 1
  });

  it('reads from the opposite edge when wrapping', () => {
    const src = labelled();
    const out = extractRegion(src, { x: -1, y: -1, width: 3, height: 3 }, true);
    expect(pixelAt(out, 3, 0, 0)).toEqual(pixelAt(src.data, 4, 3, 2));
    expect(pixelAt(out, 3, 1, 1)).toEqual(pixelAt(src.data, 4, 0, 0));
    expect(pixelAt(out, 3, 2, 0)).toEqual(pixelAt(src.data, 4, 1, 2));
  });

  it('copies the whole image unchanged and never aliases the source', () => {
    const src = labelled();
    const out = extractRegion(src, { x: 0, y: 0, width: 4, height: 3 }, false);
    expect(out.equals(src.data)).toBe(true);
    out[0] = 99;
    expect(src.data[0]).toBe(0);
  });

  it('can be larger than the image on every side', () => {
    const src = labelled(2, 2);
    const out = extractRegion(src, { x: -3, y: -3, width: 8, height: 8 }, false);
    expect(out.length).toBe(8 * 8 * 4);
    // The mirror period is 2n, so the centre 2x2 block is the image itself.
    expect(pixelAt(out, 8, 3, 3)).toEqual(pixelAt(src.data, 2, 0, 0));
    expect(pixelAt(out, 8, 4, 4)).toEqual(pixelAt(src.data, 2, 1, 1));
  });
});

describe('countDifferentPixels', () => {
  it('counts pixels, not bytes, and rejects mismatched sizes', () => {
    const a = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const b = Buffer.from([1, 2, 3, 4, 5, 6, 7, 9]);
    expect(countDifferentPixels(a, a)).toBe(0);
    expect(countDifferentPixels(a, b)).toBe(1);
    expect(countDifferentPixels(a, Buffer.from([9, 9, 9, 9, 9, 9, 9, 9]))).toBe(2);
    expect(() => countDifferentPixels(a, Buffer.alloc(4))).toThrow(/differ in size/);
  });
});
