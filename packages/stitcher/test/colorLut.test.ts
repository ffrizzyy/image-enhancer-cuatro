import { describe, expect, it } from 'vitest';

import { applyCorrection, applyExactly, type Correction } from '../src';
import { structured } from './support/synth';

const correction = (gain: [number, number, number], offset: [number, number, number]): Correction => ({ gain, offset, identity: false });

/** Per-channel absolute differences between two same-sized images. */
function differences(a: Buffer, b: Buffer): { max: number; mean: number; beyondOne: number } {
  let max = 0;
  let sum = 0;
  let beyondOne = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a[i + c]! - b[i + c]!);
      max = Math.max(max, d);
      sum += d;
      if (d > 1) beyondOne++;
      n++;
    }
  }
  return { max, mean: sum / n, beyondOne: beyondOne / n };
}

describe('applyCorrection on large images (lookup table) agrees with the exact Lab correction', () => {
  // 90,000 pixels: above the threshold for the table.
  const image = structured(300, 300, 21);

  const cases: Array<[string, Correction]> = [
    ['a lightness offset', correction([1, 1, 1], [5, 0, 0])],
    ['a negative lightness offset', correction([1, 1, 1], [-6, 0, 0])],
    ['a colour cast', correction([1, 1, 1], [0, 6, -5])],
    ['a contrast gain', correction([1.12, 1, 1], [-6, 0, 0])],
    ['a strong combined correction', correction([0.85, 1.2, 0.9], [4, -8, 10])],
  ];

  // The table matches the exact correction to the level for nearly every value. The rare larger differences are
  // colours at the very edge of the sRGB gamut under a strong correction, where the exact path clips first.
  it.each(cases)('%s: nearly always identical, and within one level for 98%+ of values', (_name, c) => {
    const exact = applyExactly(image, c);
    const fast = applyCorrection(image, c);
    const d = differences(exact.data, fast.data);

    expect(d.mean).toBeLessThan(0.15);
    expect(d.beyondOne).toBeLessThan(0.02);
    expect(d.max).toBeLessThanOrEqual(8);
  });

  it('keeps alpha and the size, and never changes the input', () => {
    const before = Buffer.from(image.data);
    const result = applyCorrection(image, correction([1, 1, 1], [5, 0, 0]));
    expect([result.width, result.height]).toEqual([300, 300]);
    for (let i = 3; i < result.data.length; i += 4) expect(result.data[i]).toBe(255);
    expect(image.data.equals(before)).toBe(true);
  });

  it('returns the very same image for an identity correction', () => {
    expect(applyCorrection(image, { gain: [1, 1, 1], offset: [0, 0, 0], identity: true })).toBe(image);
  });

  it('small images are corrected exactly, pixel by pixel', () => {
    const small = structured(100, 100, 3);
    const c = correction([1.05, 1, 1], [3, 2, -2]);
    expect(applyCorrection(small, c).data.equals(applyExactly(small, c).data)).toBe(true);
  });
});
