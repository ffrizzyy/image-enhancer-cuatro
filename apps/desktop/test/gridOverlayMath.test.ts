import { loadProviderConfig } from '@ie/providers';
import { planTiles } from '@ie/slicer';
import { describe, expect, it } from 'vitest';

import { coreArea, describeTile, MIN_CORE_PX, overlapRegions, planWarnings, PROVIDER_OUTPUT_PX } from '../renderer/src/gridOverlay';

const plan = (width: number, height: number, rows: number, cols: number, overlapPct = 15, wrap = false) =>
  planTiles({ width, height, rows, cols, overlapPct, wrap });

describe('provider output sizes', () => {
  it('match the shipped provider configs', () => {
    for (const id of ['gpt', 'gemini', 'grok'] as const) {
      expect(PROVIDER_OUTPUT_PX[id], id).toBe(loadProviderConfig(id).capabilities.approxOutputPx);
    }
  });
});

describe('overlapRegions', () => {
  it('has none for a single tile', () => {
    expect(overlapRegions(plan(800, 600, 1, 1))).toEqual([]);
  });

  it('has none when the overlap is 0 and the tiles merely touch', () => {
    expect(overlapRegions(plan(800, 600, 2, 3, 0))).toEqual([]);
  });

  it('is the strip shared by two neighbours, exactly as wide as the plan says', () => {
    const p = plan(900, 600, 1, 2, 10);
    const [only, ...rest] = overlapRegions(p);
    expect(rest).toEqual([]);
    // Cores split at x = 450; the overlap is overlapPx on each side of that line.
    expect(only!.rect).toEqual({ x: 450 - p.overlapPx, y: 0, width: 2 * p.overlapPx, height: 600 });
    expect([only!.a, only!.b]).toEqual([0, 1]);
    expect(only!.wrapped).toBe(false);
  });

  it('each overlap lies inside the image and inside both crops, at every supported grid', () => {
    for (let rows = 1; rows <= 6; rows++) {
      for (let cols = 1; cols <= 6; cols++) {
        for (const overlapPct of [0, 15, 40]) {
          const p = plan(1200, 900, rows, cols, overlapPct);
          for (const { a, b, rect } of overlapRegions(p)) {
            expect(rect.x, `${rows}x${cols}@${overlapPct}`).toBeGreaterThanOrEqual(0);
            expect(rect.y).toBeGreaterThanOrEqual(0);
            expect(rect.x + rect.width).toBeLessThanOrEqual(1200);
            expect(rect.y + rect.height).toBeLessThanOrEqual(900);
            for (const index of [a, b]) {
              const { crop } = p.tiles[index]!;
              expect(rect.x).toBeGreaterThanOrEqual(crop.x);
              expect(rect.y).toBeGreaterThanOrEqual(crop.y);
              expect(rect.x + rect.width).toBeLessThanOrEqual(crop.x + crop.width);
              expect(rect.y + rect.height).toBeLessThanOrEqual(crop.y + crop.height);
            }
          }
        }
      }
    }
  });

  it('finds an overlap for every pair of adjacent tiles when there is overlap', () => {
    const p = plan(1200, 900, 3, 4, 15);
    const pairs = new Set(overlapRegions(p).map((r) => `${r.a}-${r.b}`));
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 4; col++) {
        const here = row * 4 + col;
        if (col < 3) expect(pairs.has(`${here}-${here + 1}`), `${here} right`).toBe(true);
        if (row < 2) expect(pairs.has(`${here}-${here + 4}`), `${here} below`).toBe(true);
      }
    }
  });

  describe('wrap mode', () => {
    it('also overlaps across the image border, folded back into the image at the border it continues from', () => {
      const p = plan(900, 600, 1, 2, 10, true);
      const regions = overlapRegions(p);
      const wrapped = regions.filter((r) => r.wrapped);
      expect(wrapped.length).toBeGreaterThan(0);
      for (const { rect } of regions) {
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(900);
      }
      // The border strip: pieces touching the left edge and the right edge.
      expect(wrapped.some((r) => r.rect.x === 0)).toBe(true);
      expect(wrapped.some((r) => r.rect.x + r.rect.width === 900)).toBe(true);
    });

    it('a non-wrap plan has no wrapped overlaps', () => {
      expect(overlapRegions(plan(900, 600, 2, 3, 15)).some((r) => r.wrapped)).toBe(false);
    });
  });
});

describe('the plan the overlay draws', () => {
  it('has cores that exactly tile the image, at every supported grid', () => {
    for (let rows = 1; rows <= 6; rows++) {
      for (let cols = 1; cols <= 6; cols++) {
        expect(coreArea(plan(1003, 777, rows, cols)), `${rows}x${cols}`).toBe(1003 * 777);
      }
    }
  });
});

describe('planWarnings', () => {
  it('has none for a comfortable plan', () => {
    expect(planWarnings(plan(3000, 2000, 2, 3), 1536)).toEqual([]);
  });

  it(`flags cores under ${MIN_CORE_PX} px and names the tiles (numbered from 1)`, () => {
    const warnings = planWarnings(plan(900, 600, 2, 3), null);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ kind: 'core-small', tiles: [0, 1, 2, 3, 4, 5] });
    expect(warnings[0]!.message).toMatch(/Tiles 1, 2, 3, 4, 5 and 6 are under 384 px/);
  });

  it('uses the singular for one tile', () => {
    // 1000 wide in two columns leaves 500 px; 700 tall in two rows leaves 350 px: only the height is too small.
    const warnings = planWarnings(plan(1000, 700, 1, 2), null);
    expect(warnings).toEqual([]);
    const one = planWarnings(plan(1000, 383, 1, 1), null);
    expect(one[0]!.message).toMatch(/^Tile 1 is under 384 px/);
  });

  it('does not flag a core of exactly the minimum', () => {
    expect(planWarnings(plan(MIN_CORE_PX, MIN_CORE_PX, 1, 1), null)).toEqual([]);
  });

  it("flags tiles whose padded image is larger than the provider's output", () => {
    // A 2400x1600 image in one tile is sent at 2400x1600: far above what Gemini returns (1024).
    const p = plan(2400, 1600, 1, 1);
    const gemini = planWarnings(p, PROVIDER_OUTPUT_PX.gemini);
    expect(gemini).toHaveLength(1);
    expect(gemini[0]).toMatchObject({ kind: 'send-exceeds-output', tiles: [0] });
    expect(gemini[0]!.message).toMatch(/larger than the 1024 px the provider returns/);
    // GPT returns 1536 px, which is still smaller than 2400.
    expect(planWarnings(p, PROVIDER_OUTPUT_PX.gpt).map((w) => w.kind)).toEqual(['send-exceeds-output']);
    // And with no provider chosen yet, there is nothing to compare against.
    expect(planWarnings(p, null)).toEqual([]);
  });

  it('can raise both warnings together', () => {
    const kinds = planWarnings(plan(5000, 300, 1, 1), 1024).map((w) => w.kind);
    expect(kinds).toEqual(['core-small', 'send-exceeds-output']);
  });
});

describe('describeTile', () => {
  it('gives a text line with the numbers a person needs', () => {
    const p = plan(1200, 800, 1, 2, 10);
    expect(describeTile(p.tiles[1]!)).toBe(
      `Tile 2 (row 1, column 2): core 600×800 px at 600, 0; sent as ${p.tiles[1]!.send.width}×${p.tiles[1]!.send.height} px.`,
    );
  });
});
