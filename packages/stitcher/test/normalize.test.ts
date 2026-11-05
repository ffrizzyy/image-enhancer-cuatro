import type { Tile } from '@ie/contracts';
import type { Rgba } from '@ie/slicer';
import { describe, expect, it } from 'vitest';

import { cropToCrop, normalizeTile } from '../src';
import { flat, meanAbsDiff, pixel, resize, structured } from './support/synth';

/** Left third red, middle third green, right third blue: any stretch or mis-crop moves the boundaries. */
function thirds(width: number, height: number): Rgba {
  const data = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const band = Math.min(2, Math.floor((x / width) * 3));
      data.set(band === 0 ? [255, 0, 0] : band === 1 ? [0, 255, 0] : [0, 0, 255], (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

describe('normalizeTile', () => {
  it('leaves an output that already has the send size untouched', async () => {
    const image = structured(200, 120, 1);
    const { image: out, croppedToAspect } = await normalizeTile(image, { width: 200, height: 120 });
    expect(out).toBe(image);
    expect(croppedToAspect).toBe(false);
  });

  it('scales a larger output down uniformly to the send size', async () => {
    const image = structured(800, 600, 2);
    const { image: out, croppedToAspect } = await normalizeTile(image, { width: 400, height: 300 });
    expect([out.width, out.height, croppedToAspect]).toEqual([400, 300, false]);
    // A uniform 2x reduction keeps the picture: compare with a direct resize of the same pixels.
    const direct = await resize(image, 400, 300);
    expect(meanAbsDiff(out, direct, { x: 0, y: 0, width: 400, height: 300 })).toBeLessThan(2);
  });

  it('scales a smaller output up uniformly', async () => {
    const { image: out } = await normalizeTile(structured(100, 100, 3), { width: 300, height: 300 });
    expect([out.width, out.height]).toEqual([300, 300]);
  });

  it('accepts a tiny aspect difference as rounding, without cropping', async () => {
    const { image: out, croppedToAspect } = await normalizeTile(structured(1004, 1000, 4), { width: 500, height: 500 });
    expect(croppedToAspect).toBe(false);
    expect([out.width, out.height]).toEqual([500, 500]);
  });

  it('centre-crops a wider output instead of stretching it (3:2 output, 1:1 send)', async () => {
    const { image: out, croppedToAspect } = await normalizeTile(thirds(1200, 800), { width: 600, height: 600 });
    expect(croppedToAspect).toBe(true);
    expect([out.width, out.height]).toEqual([600, 600]);

    // The centre 800x800 is kept (x 200..1000): red is 25%, green 50%, blue 25%. A stretch would give thirds.
    expect(pixel(out, 10, 300)).toEqual([255, 0, 0, 255]);
    expect(pixel(out, 300, 300)).toEqual([0, 255, 0, 255]);
    expect(pixel(out, 590, 300)).toEqual([0, 0, 255, 255]);
    const firstGreen = Array.from({ length: 600 }, (_, x) => x).find((x) => pixel(out, x, 300)[1] === 255)!;
    expect(firstGreen).toBeGreaterThanOrEqual(147);
    expect(firstGreen).toBeLessThanOrEqual(153);
  });

  it('centre-crops a taller output vertically', async () => {
    const tall = structured(400, 800, 5);
    const { image: out, croppedToAspect } = await normalizeTile(tall, { width: 400, height: 400 });
    expect(croppedToAspect).toBe(true);
    expect([out.width, out.height]).toEqual([400, 400]);
    // Rows 200..600 of the original are kept unchanged (no resample needed: same width, exact crop).
    expect(pixel(out, 50, 0)).toEqual(pixel(tall, 50, 200));
    expect(pixel(out, 50, 399)).toEqual(pixel(tall, 50, 599));
  });

  it('crops a 2:3 output for a 3:2 send, then resizes, with no non-uniform scale', async () => {
    const { image: out, croppedToAspect } = await normalizeTile(structured(600, 900, 6), { width: 300, height: 200 });
    expect(croppedToAspect).toBe(true);
    expect([out.width, out.height]).toEqual([300, 200]);
  });

  it('handles the smallest outputs', async () => {
    const { image: out } = await normalizeTile(flat(1, 1), { width: 4, height: 4 });
    expect([out.width, out.height]).toEqual([4, 4]);
  });
});

describe('cropToCrop', () => {
  const tile = {
    crop: { x: 10, y: 5, width: 30, height: 20 },
    send: { x: 4, y: 0, width: 40, height: 40 },
  } as Pick<Tile, 'crop' | 'send'>;

  it('drops the padding, keeping exactly the crop region', () => {
    const image = structured(40, 40, 7);
    const out = cropToCrop(image, tile);
    expect([out.width, out.height]).toEqual([30, 20]);
    expect(pixel(out, 0, 0)).toEqual(pixel(image, 6, 5));
    expect(pixel(out, 29, 19)).toEqual(pixel(image, 35, 24));
  });

  it('refuses an image that is not the send size, or a crop outside the send rect', () => {
    expect(() => cropToCrop(structured(41, 40, 8), tile)).toThrow(RangeError);
    const outside = { ...tile, crop: { x: 0, y: 0, width: 30, height: 20 } } as Pick<Tile, 'crop' | 'send'>;
    expect(() => cropToCrop(structured(40, 40, 9), outside)).toThrow(/crop must lie inside/);
  });
});
