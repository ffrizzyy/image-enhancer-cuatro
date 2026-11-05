import { describe, expect, it } from 'vitest';

import { findSeam } from '../src';

function energy(width: number, height: number, valley: (y: number) => number | number[], high = 100): Float32Array {
  const e = new Float32Array(width * height).fill(high);
  for (let y = 0; y < height; y++) {
    const v = valley(y);
    for (const x of Array.isArray(v) ? v : [v]) e[y * width + x] = 0;
  }
  return e;
}

describe('findSeam', () => {
  it('follows a straight low-energy valley', () => {
    const seam = findSeam(energy(21, 30, () => 10), 21, 30, 0);
    expect([...seam]).toEqual(Array(30).fill(10));
  });

  it('follows a diagonal valley, moving one column at a time', () => {
    const height = 30;
    const seam = findSeam(energy(21, height, (y) => 5 + Math.floor(y / 3)), 21, height, 0);
    expect([...seam]).toEqual(Array.from({ length: height }, (_, y) => 5 + Math.floor(y / 3)));
    for (let y = 1; y < height; y++) expect(Math.abs(seam[y]! - seam[y - 1]!)).toBeLessThanOrEqual(1);
  });

  it('never moves more than one column per row, whatever the energy', () => {
    const e = new Float32Array(40 * 60);
    let s = 7;
    for (let i = 0; i < e.length; i++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      e[i] = (s >>> 16) % 50;
    }
    const seam = findSeam(e, 40, 60, 2);
    for (let y = 1; y < 60; y++) expect(Math.abs(seam[y]! - seam[y - 1]!)).toBeLessThanOrEqual(1);
  });

  it('chooses the cheaper of two valleys', () => {
    const e = energy(30, 20, () => [4, 25]);
    for (let y = 0; y < 20; y++) e[y * 30 + 25] = 3; // the right valley costs a little
    expect(new Set(findSeam(e, 30, 20, 0))).toEqual(new Set([4]));
  });

  it('stays inside the margin even when the best path is outside it', () => {
    const seam = findSeam(energy(30, 20, () => 1), 30, 20, 4);
    for (const x of seam) {
      expect(x).toBeGreaterThanOrEqual(4);
      expect(x).toBeLessThanOrEqual(25);
    }
    const right = findSeam(energy(30, 20, () => 29), 30, 20, 4);
    for (const x of right) expect(x).toBeLessThanOrEqual(25);
  });

  it('ignores a margin that would leave no room', () => {
    const seam = findSeam(energy(6, 10, () => 3), 6, 10, 5);
    expect([...seam]).toEqual(Array(10).fill(3));
  });

  it('prefers the middle when everything costs the same', () => {
    const seam = findSeam(new Float32Array(21 * 12), 21, 12, 0);
    expect(new Set(seam)).toEqual(new Set([10]));
  });

  it('handles a single row and a single column', () => {
    expect([...findSeam(energy(9, 1, () => 6), 9, 1, 0)]).toEqual([6]);
    expect([...findSeam(new Float32Array(1 * 5), 1, 5, 0)]).toEqual([0, 0, 0, 0, 0]);
  });
});
