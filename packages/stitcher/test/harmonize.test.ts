import type { Rgba } from '@ie/slicer';
import { describe, expect, it } from 'vitest';

import { harmonize } from '../src';
import { blur, flat, meanAbsDiff, resize, structured } from './support/synth';

/** Multiplies every pixel by `gain(x, y)`: a smooth drift like a provider lighting one side differently. */
function drift(image: Rgba, gain: (x: number, y: number) => number): Rgba {
  const data = Buffer.from(image.data);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const g = gain(x, y);
      for (let c = 0; c < 3; c++) {
        const i = (y * image.width + x) * 4 + c;
        data[i] = Math.max(0, Math.min(255, Math.round(data[i]! * g)));
      }
    }
  }
  return { data, width: image.width, height: image.height };
}

/** Mean squared luminance gradient: how much detail an image has. */
function detail(image: Rgba): number {
  let sum = 0;
  for (let y = 0; y < image.height - 1; y++) {
    for (let x = 0; x < image.width - 1; x++) {
      const i = (y * image.width + x) * 4;
      const dx = image.data[i + 4]! - image.data[i]!;
      const dy = image.data[i + image.width * 4]! - image.data[i]!;
      sum += dx * dx + dy * dy;
    }
  }
  return sum / ((image.width - 1) * (image.height - 1));
}

const whole = (image: Rgba) => ({ x: 0, y: 0, width: image.width, height: image.height });

describe('harmonize', () => {
  const source = structured(480, 320, 11);

  it('leaves an image alone when there is no drift, returning the very same object', () => {
    const result = harmonize(source, source);
    expect(result.applied).toBe(false);
    expect(result.image).toBe(source);
  });

  it('keeps the overall tone the provider chose: a uniform change is not drift', () => {
    const darker = drift(source, () => 0.9); // darker, so nothing clips and the change really is uniform
    const result = harmonize(darker, source);
    expect(result.applied).toBe(false);
    expect(result.image).toBe(darker);
  });

  it('removes large-scale drift', () => {
    const drifted = drift(source, (x) => 0.85 + (0.3 * x) / source.width);
    const before = meanAbsDiff(source, drifted, whole(source));
    const result = harmonize(drifted, source);
    const after = meanAbsDiff(source, result.image, whole(source));

    expect(result.applied).toBe(true);
    expect(after).toBeLessThan(before * 0.4);
  });

  it('removes drift in both directions at once', () => {
    const drifted = drift(source, (x, y) => 0.88 + (0.14 * x) / source.width + (0.14 * y) / source.height);
    const result = harmonize(drifted, source);
    expect(meanAbsDiff(source, result.image, whole(source))).toBeLessThan(meanAbsDiff(source, drifted, whole(source)) * 0.5);
  });

  it('adds no detail: a blurry stitched image stays as blurry as it was', async () => {
    const soft = await blur(source, 4);
    const drifted = drift(soft, (x) => 0.85 + (0.3 * x) / soft.width);
    const result = harmonize(drifted, source);

    // The reference is sharp, the stitched image is soft. The correction must not pull the source's detail in.
    expect(detail(result.image) / detail(drifted)).toBeGreaterThan(0.8);
    expect(detail(result.image) / detail(drifted)).toBeLessThan(1.25);
    expect(detail(result.image)).toBeLessThan(detail(source) * 0.5);
  });

  it('accepts a low-resolution reference of any size (the optional global pass)', async () => {
    const reference = await resize(source, 60, 40);
    const drifted = drift(source, (x) => 0.85 + (0.3 * x) / source.width);
    const result = harmonize(drifted, reference);
    expect(meanAbsDiff(source, result.image, whole(source))).toBeLessThan(meanAbsDiff(source, drifted, whole(source)) * 0.5);
  });

  it('never changes a channel by more than the clamp, however large the drift', () => {
    const base = flat(320, 160, 100);
    const darkRight = drift(base, (x) => (x > 160 ? 0.3 : 1));
    const result = harmonize(darkRight, base);
    for (let i = 0; i < result.image.data.length; i += 4) {
      expect(result.image.data[i]!).toBeLessThanOrEqual(Math.round(darkRight.data[i]! * 1.25) + 1);
    }
  });

  it('keeps alpha untouched and the size unchanged', () => {
    const drifted = drift(source, (x) => 0.85 + (0.3 * x) / source.width);
    const result = harmonize(drifted, source);
    expect([result.image.width, result.image.height]).toEqual([source.width, source.height]);
    for (let i = 3; i < result.image.data.length; i += 4) expect(result.image.data[i]).toBe(255);
  });

  it('wraps the correction around the border for seamless images, so opposite edges stay in agreement', () => {
    const base = flat(400, 200, 128);
    // Periodic drift, brightest exactly at the border, as a seamless texture's drift must be.
    const drifted = drift(base, (x) => 1 + 0.12 * Math.cos((2 * Math.PI * (x + 0.5)) / base.width));
    const columnAt = (img: Rgba, x: number) => img.data[(100 * img.width + x) * 4]!;
    const errorAt = (img: Rgba, x: number) => Math.abs(columnAt(img, x) - 128);

    const wrapped = harmonize(drifted, base, { wrap: true });
    const clamped = harmonize(drifted, base, { wrap: false });
    expect(wrapped.applied).toBe(true);
    // Across the border the wrapped field sees both sides; the clamped one sees a one-sided edge.
    for (const x of [0, 1, base.width - 2, base.width - 1]) expect(errorAt(wrapped.image, x)).toBeLessThan(errorAt(drifted, x) * 0.5);
    const border = (img: Rgba) => errorAt(img, 0) + errorAt(img, img.width - 1);
    expect(border(wrapped.image)).toBeLessThanOrEqual(border(clamped.image));
  });

  it('copes with tiny images (fewer pixels than cells)', () => {
    const tiny = structured(5, 3, 2);
    expect(() => harmonize(drift(tiny, (x) => 0.9 + x * 0.05), tiny)).not.toThrow();
  });
});
