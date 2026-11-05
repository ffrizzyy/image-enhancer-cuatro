import { TilePlanSchema, type Rect } from '@ie/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { DEFAULT_ASPECTS, planTiles, type PlanOptions } from '../src';

const RUNS = { numRuns: 400 };

const dimension = fc.oneof(
  fc.integer({ min: 1, max: 64 }), // tiny
  fc.integer({ min: 1, max: 9000 }), // anything, including odd sizes
  fc.constantFrom(512, 777, 1001, 4000, 8192),
);

const planOptions: fc.Arbitrary<PlanOptions> = fc
  .record({
    width: dimension,
    height: dimension,
    rows: fc.integer({ min: 1, max: 6 }),
    cols: fc.integer({ min: 1, max: 6 }),
    overlapPct: fc.oneof(fc.constantFrom(0, 40), fc.double({ min: 0, max: 40, noNaN: true })),
    wrap: fc.boolean(),
  })
  .filter((o) => o.rows <= o.height && o.cols <= o.width);

// Extreme aspect ratios: very wide strips and very tall columns.
const extremeOptions: fc.Arbitrary<PlanOptions> = fc
  .record({
    long: fc.integer({ min: 2000, max: 9000 }),
    short: fc.integer({ min: 6, max: 40 }),
    portrait: fc.boolean(),
    rows: fc.integer({ min: 1, max: 6 }),
    cols: fc.integer({ min: 1, max: 6 }),
    overlapPct: fc.double({ min: 0, max: 40, noNaN: true }),
    wrap: fc.boolean(),
  })
  .map(({ long, short, portrait, ...rest }) => ({ width: portrait ? short : long, height: portrait ? long : short, ...rest }))
  .filter((o) => o.rows <= o.height && o.cols <= o.width);

const bothKinds = fc.oneof(planOptions, extremeOptions);

const intersects = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

describe('plan properties', () => {
  it('cores are disjoint and exactly cover the source', () => {
    fc.assert(
      fc.property(bothKinds, (o) => {
        const p = planTiles(o);
        const source: Rect = { x: 0, y: 0, width: o.width, height: o.height };
        let area = 0;
        for (const t of p.tiles) {
          expect(contains(source, t.core)).toBe(true);
          area += t.core.width * t.core.height;
        }
        expect(area).toBe(o.width * o.height);
        for (let i = 0; i < p.tiles.length; i++) {
          for (let j = i + 1; j < p.tiles.length; j++) {
            expect(intersects(p.tiles[i]!.core, p.tiles[j]!.core)).toBe(false);
          }
        }
      }),
      RUNS,
    );
  });

  it('remainders go to the last row and column; every other run is the base size', () => {
    fc.assert(
      fc.property(bothKinds, (o) => {
        const p = planTiles(o);
        const baseW = Math.floor(o.width / o.cols);
        const baseH = Math.floor(o.height / o.rows);
        for (const t of p.tiles) {
          expect(t.core.x).toBe(t.col * baseW);
          expect(t.core.y).toBe(t.row * baseH);
          expect(t.core.width).toBe(t.col === o.cols - 1 ? o.width - baseW * (o.cols - 1) : baseW);
          expect(t.core.height).toBe(t.row === o.rows - 1 ? o.height - baseH * (o.rows - 1) : baseH);
        }
      }),
      RUNS,
    );
  });

  it('every crop contains its core, stays in bounds, and wraps only when asked', () => {
    fc.assert(
      fc.property(bothKinds, (o) => {
        const p = planTiles(o);
        const source: Rect = { x: 0, y: 0, width: o.width, height: o.height };
        for (const t of p.tiles) {
          expect(contains(t.crop, t.core)).toBe(true);
          if (o.wrap) {
            expect(t.crop.width).toBeLessThanOrEqual(o.width);
            expect(t.crop.height).toBeLessThanOrEqual(o.height);
          } else {
            expect(contains(source, t.crop)).toBe(true);
          }
        }
      }),
      RUNS,
    );
  });

  it('without wrap the crop adds exactly the overlap, clipped at the border', () => {
    fc.assert(
      fc.property(bothKinds, (o) => {
        const p = planTiles({ ...o, wrap: false });
        for (const t of p.tiles) {
          expect(t.crop.x).toBe(Math.max(0, t.core.x - p.overlapPx));
          expect(t.crop.y).toBe(Math.max(0, t.core.y - p.overlapPx));
          expect(t.crop.x + t.crop.width).toBe(Math.min(o.width, t.core.x + t.core.width + p.overlapPx));
          expect(t.crop.y + t.crop.height).toBe(Math.min(o.height, t.core.y + t.core.height + p.overlapPx));
        }
      }),
      RUNS,
    );
  });

  it('with wrap the overlap is symmetric around the core, reaching past the border', () => {
    fc.assert(
      fc.property(bothKinds, (o) => {
        const p = planTiles({ ...o, wrap: true });
        for (const t of p.tiles) {
          const left = t.core.x - t.crop.x;
          const right = t.crop.x + t.crop.width - (t.core.x + t.core.width);
          const top = t.core.y - t.crop.y;
          const bottom = t.crop.y + t.crop.height - (t.core.y + t.core.height);
          expect(left).toBe(right);
          expect(top).toBe(bottom);
          expect(left).toBeLessThanOrEqual(p.overlapPx);
          expect(top).toBeLessThanOrEqual(p.overlapPx);
          // The outer overlap of a border tile comes from the opposite edge: the crop leaves the image.
          if (t.col === 0 && left > 0) expect(t.crop.x).toBeLessThan(0);
          if (t.col === o.cols - 1 && right > 0) expect(t.crop.x + t.crop.width).toBeGreaterThan(o.width);
          if (t.row === 0 && top > 0) expect(t.crop.y).toBeLessThan(0);
          if (t.row === o.rows - 1 && bottom > 0) expect(t.crop.y + t.crop.height).toBeGreaterThan(o.height);
        }
      }),
      RUNS,
    );
  });

  it('every send rect contains its crop and is within 2% of a supported aspect (exactly, in fact)', () => {
    fc.assert(
      fc.property(bothKinds, (o) => {
        for (const t of planTiles(o).tiles) {
          expect(contains(t.send, t.crop)).toBe(true);
          const ratio = t.send.width / t.send.height;
          const nearest = Math.min(...DEFAULT_ASPECTS.map(([a, b]) => Math.abs(ratio / (a / b) - 1)));
          expect(nearest).toBeLessThanOrEqual(0.02);
          expect(nearest).toBe(0);
        }
      }),
      RUNS,
    );
  });

  it('chooses the supported aspect nearest the crop', () => {
    fc.assert(
      fc.property(bothKinds, (o) => {
        for (const t of planTiles(o).tiles) {
          const target = Math.log(t.crop.width / t.crop.height);
          const chosen = Math.log(t.send.width / t.send.height);
          const chosenDiff = Math.abs(target - chosen);
          for (const [a, b] of DEFAULT_ASPECTS) {
            expect(chosenDiff).toBeLessThanOrEqual(Math.abs(target - Math.log(a / b)) + 1e-9);
          }
        }
      }),
      RUNS,
    );
  });

  it('padding stays on real pixels along any axis where the send rect fits (no wrap)', () => {
    fc.assert(
      fc.property(bothKinds, (o) => {
        for (const t of planTiles({ ...o, wrap: false }).tiles) {
          if (t.send.width <= o.width) {
            expect(t.send.x).toBeGreaterThanOrEqual(0);
            expect(t.send.x + t.send.width).toBeLessThanOrEqual(o.width);
          }
          if (t.send.height <= o.height) {
            expect(t.send.y).toBeGreaterThanOrEqual(0);
            expect(t.send.y + t.send.height).toBeLessThanOrEqual(o.height);
          }
        }
      }),
      RUNS,
    );
  });

  it('edges and roles agree with the tile position', () => {
    fc.assert(
      fc.property(bothKinds, (o) => {
        for (const t of planTiles(o).tiles) {
          expect(t.index).toBe(t.row * o.cols + t.col);
          expect(t.edges).toEqual({ top: t.row === 0, left: t.col === 0, bottom: t.row === o.rows - 1, right: t.col === o.cols - 1 });
          const rowEdge = o.rows > 1 && (t.row === 0 || t.row === o.rows - 1);
          const colEdge = o.cols > 1 && (t.col === 0 || t.col === o.cols - 1);
          expect(t.role).toBe(rowEdge && colEdge ? 'corner' : rowEdge || colEdge ? 'edge' : 'center');
        }
      }),
      RUNS,
    );
  });

  it('is deterministic and always matches the contract schema', () => {
    fc.assert(
      fc.property(bothKinds, (o) => {
        const first = planTiles(o);
        expect(planTiles({ ...o })).toEqual(first);
        expect(TilePlanSchema.safeParse(first).success).toBe(true);
      }),
      RUNS,
    );
  });

  it('plans every fixture size named in the spec', () => {
    for (const [width, height] of [[1001, 777], [4000, 500], [512, 512], [8192, 8192], [3, 3]] as const) {
      for (const rows of [1, 2, 6]) {
        for (const cols of [1, 3, 6]) {
          if (rows > height || cols > width) continue;
          expect(() => planTiles({ width, height, rows, cols, overlapPct: 40, wrap: true })).not.toThrow();
        }
      }
    }
  });
});
