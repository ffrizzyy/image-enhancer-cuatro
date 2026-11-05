import { describe, expect, it } from 'vitest';

import { deltaE76, labToRgb8, rgbToLab, toLinear, toSrgb8 } from '../src';

describe('sRGB and linear light', () => {
  it('round-trips every 8-bit value', () => {
    for (let v = 0; v < 256; v++) expect(toSrgb8(toLinear(v))).toBe(v);
  });

  it('is the standard curve: mid-grey 128 is about 21.6% linear, and the ends are exact', () => {
    expect(toLinear(0)).toBe(0);
    expect(toLinear(255)).toBe(1);
    expect(toLinear(128)).toBeCloseTo(0.2158, 3);
    expect(toSrgb8(0.5)).toBe(188);
  });

  it('clamps out-of-range light', () => {
    expect(toSrgb8(-0.3)).toBe(0);
    expect(toSrgb8(4)).toBe(255);
  });
});

describe('Lab', () => {
  it('matches reference values (D65)', () => {
    const [lw, aw, bw] = rgbToLab(255, 255, 255);
    expect(lw).toBeCloseTo(100, 1);
    expect(Math.abs(aw)).toBeLessThan(0.05);
    expect(Math.abs(bw)).toBeLessThan(0.05);
    expect(rgbToLab(0, 0, 0)).toEqual([0, 0, 0]);

    const [lr, ar, br] = rgbToLab(255, 0, 0);
    expect(lr).toBeCloseTo(53.24, 1);
    expect(ar).toBeCloseTo(80.09, 0);
    expect(br).toBeCloseTo(67.2, 0);
    expect(rgbToLab(128, 128, 128)[0]).toBeCloseTo(53.59, 1);
  });

  it('round-trips colours exactly, including the corners of the cube', () => {
    const corners = [0, 255];
    for (const r of corners) for (const g of corners) for (const b of corners) expect(labToRgb8(...rgbToLab(r, g, b))).toEqual([r, g, b]);

    let seed = 12345;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed >>> 24;
    };
    for (let i = 0; i < 50_000; i++) {
      const rgb: [number, number, number] = [next(), next(), next()];
      expect(labToRgb8(...rgbToLab(...rgb))).toEqual(rgb);
    }
  });

  it('keeps grey neutral through the round trip', () => {
    for (let v = 0; v < 256; v += 5) {
      const [, a, b] = rgbToLab(v, v, v);
      expect(Math.abs(a)).toBeLessThan(0.05);
      expect(Math.abs(b)).toBeLessThan(0.05);
    }
  });

  it('clamps colours outside the sRGB gamut instead of wrapping', () => {
    const outOfGamut: Array<[number, number, number]> = [[50, 120, 120], [90, -150, 100], [10, 0, -200], [120, 0, 0], [-10, 0, 0]];
    for (const lab of outOfGamut) {
      for (const channel of labToRgb8(...lab)) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(255);
      }
    }
  });
});

describe('deltaE76', () => {
  it('is the Euclidean distance in Lab', () => {
    expect(deltaE76([50, 10, 10], [50, 10, 10])).toBe(0);
    expect(deltaE76([0, 0, 0], [3, 4, 0])).toBe(5);
    expect(deltaE76([10, 20, 30], [40, -20, 30])).toBeCloseTo(50, 10);
  });
});
