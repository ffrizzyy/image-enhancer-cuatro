import { TilePlanSchema, type Tile } from '@ie/contracts';
import { describe, expect, it } from 'vitest';

import { DEFAULT_ASPECTS, PlanError, planTiles, presetGrid, type PlanErrorCode, type PlanOptions } from '../src';

const plan = (o: Partial<PlanOptions> & Pick<PlanOptions, 'width' | 'height' | 'rows' | 'cols'>) =>
  planTiles({ overlapPct: 0, ...o });

const tileAt = (p: ReturnType<typeof planTiles>, row: number, col: number): Tile => p.tiles[row * p.grid.cols + col]!;

function errorCode(options: PlanOptions): PlanErrorCode | 'none' {
  try {
    planTiles(options);
    return 'none';
  } catch (error) {
    if (error instanceof PlanError) return error.code;
    throw error;
  }
}

describe('presets', () => {
  it('orient 6 (3x2) and 8 (4x2) by the image: landscape and square get two rows, portrait two columns', () => {
    expect(presetGrid(6, 1600, 900)).toEqual({ rows: 2, cols: 3 });
    expect(presetGrid(8, 1600, 900)).toEqual({ rows: 2, cols: 4 });
    expect(presetGrid(6, 900, 1600)).toEqual({ rows: 3, cols: 2 });
    expect(presetGrid(8, 900, 1600)).toEqual({ rows: 4, cols: 2 });
    expect(presetGrid(6, 1000, 1000)).toEqual({ rows: 2, cols: 3 });
  });
});

describe('cores', () => {
  it('split evenly when the size divides', () => {
    const p = plan({ width: 600, height: 400, rows: 2, cols: 3 });
    expect(p.tiles.map((t) => t.core)).toEqual([
      { x: 0, y: 0, width: 200, height: 200 },
      { x: 200, y: 0, width: 200, height: 200 },
      { x: 400, y: 0, width: 200, height: 200 },
      { x: 0, y: 200, width: 200, height: 200 },
      { x: 200, y: 200, width: 200, height: 200 },
      { x: 400, y: 200, width: 200, height: 200 },
    ]);
  });

  it('give the remainder to the last column and row (1001x777)', () => {
    const p = plan({ width: 1001, height: 777, rows: 2, cols: 3 });
    expect(tileAt(p, 0, 0).core).toMatchObject({ x: 0, y: 0, width: 333, height: 388 });
    expect(tileAt(p, 0, 2).core).toMatchObject({ x: 666, width: 335 });
    expect(tileAt(p, 1, 0).core).toMatchObject({ y: 388, height: 389 });
    expect(tileAt(p, 1, 2).core).toMatchObject({ x: 666, y: 388, width: 335, height: 389 });
  });

  it('numbers tiles in raster order', () => {
    const p = plan({ width: 600, height: 400, rows: 2, cols: 3 });
    expect(p.tiles.map((t) => [t.index, t.row, t.col])).toEqual([
      [0, 0, 0], [1, 0, 1], [2, 0, 2], [3, 1, 0], [4, 1, 1], [5, 1, 2],
    ]);
  });
});

describe('overlap and crop', () => {
  it('adds overlap inside the image and none past its border', () => {
    const p = plan({ width: 600, height: 400, rows: 2, cols: 3, overlapPct: 10 });
    expect(p.overlapPx).toBe(20);
    expect(tileAt(p, 0, 0).crop).toEqual({ x: 0, y: 0, width: 220, height: 220 });
    expect(tileAt(p, 0, 1).crop).toEqual({ x: 180, y: 0, width: 240, height: 220 });
    expect(tileAt(p, 1, 2).crop).toEqual({ x: 380, y: 180, width: 220, height: 220 });
  });

  it('measures overlap against the base core size', () => {
    expect(plan({ width: 4000, height: 500, rows: 1, cols: 6, overlapPct: 10 }).overlapPx).toBe(50);
    expect(plan({ width: 512, height: 512, rows: 2, cols: 2, overlapPct: 40 }).overlapPx).toBe(102);
    expect(plan({ width: 512, height: 512, rows: 2, cols: 2, overlapPct: 0 }).overlapPx).toBe(0);
  });
});

describe('aspect padding (send)', () => {
  it('leaves a square crop alone and keeps padding on real pixels where it fits', () => {
    const p = plan({ width: 600, height: 400, rows: 2, cols: 3, overlapPct: 10 });
    expect(tileAt(p, 0, 1).send).toEqual({ x: 180, y: 0, width: 240, height: 240 });
  });

  it('pads a wide crop to 3:2 and reflects only what cannot fit (4000x500, 6 columns)', () => {
    const p = plan({ width: 4000, height: 500, rows: 1, cols: 6, overlapPct: 10 });
    const t = tileAt(p, 0, 2);
    expect(t.crop).toEqual({ x: 1282, y: 0, width: 766, height: 500 });
    expect(t.send).toEqual({ x: 1281, y: -6, width: 768, height: 512 });
  });

  it('keeps a border tile inside the image by shifting padding to the open side', () => {
    const p = plan({ width: 1000, height: 1000, rows: 1, cols: 3 });
    const t = tileAt(p, 0, 0);
    expect(t.core).toEqual({ x: 0, y: 0, width: 333, height: 1000 });
    expect(t.send.x).toBe(0);
    expect(t.send.x + t.send.width).toBeLessThanOrEqual(1000);
  });

  it('uses 2:3 for tall crops and 1:1 for square ones', () => {
    const tall = tileAt(plan({ width: 400, height: 1800, rows: 2, cols: 1 }), 0, 0);
    expect(tall.send.height / tall.send.width).toBe(1.5);
    const square = tileAt(plan({ width: 512, height: 512, rows: 2, cols: 2 }), 0, 0);
    expect(square.send).toEqual({ x: 0, y: 0, width: 256, height: 256 });
  });

  it('honours a custom aspect list', () => {
    const only16by9 = plan({ width: 400, height: 400, rows: 2, cols: 2, aspects: [[16, 9]] });
    expect(tileAt(only16by9, 0, 0).send).toMatchObject({ width: 368, height: 207 });
    const squares = plan({ width: 900, height: 300, rows: 1, cols: 2, aspects: [[1, 1]] });
    for (const t of squares.tiles) expect(t.send.width).toBe(t.send.height);
  });

  it('exposes the default aspects as 1:1, 2:3 and 3:2', () => {
    expect(DEFAULT_ASPECTS).toEqual([[1, 1], [2, 3], [3, 2]]);
  });
});

describe('wrap mode', () => {
  it('takes outer overlap and padding from the opposite edge', () => {
    const p = plan({ width: 600, height: 400, rows: 2, cols: 3, overlapPct: 10, wrap: true });
    expect(p.wrap).toBe(true);
    expect(tileAt(p, 0, 0).crop).toEqual({ x: -20, y: -20, width: 240, height: 240 });
    expect(tileAt(p, 1, 2).crop).toEqual({ x: 380, y: 180, width: 240, height: 240 });
    expect(tileAt(p, 1, 2).send).toEqual({ x: 380, y: 180, width: 240, height: 240 });
  });

  it('never lets a crop exceed the image (single column or row)', () => {
    const p = plan({ width: 600, height: 400, rows: 2, cols: 1, overlapPct: 40, wrap: true });
    for (const t of p.tiles) {
      expect(t.crop.width).toBeLessThanOrEqual(600);
      expect(t.crop.height).toBeLessThanOrEqual(400);
      expect(t.crop.width).toBe(600);
    }
  });

  it('does not change the cores', () => {
    const a = plan({ width: 1001, height: 777, rows: 2, cols: 3, overlapPct: 15 });
    const b = plan({ width: 1001, height: 777, rows: 2, cols: 3, overlapPct: 15, wrap: true });
    expect(b.tiles.map((t) => t.core)).toEqual(a.tiles.map((t) => t.core));
  });
});

describe('edges and roles', () => {
  it('marks image borders and classifies corner, edge and centre tiles', () => {
    const p = plan({ width: 900, height: 900, rows: 3, cols: 3 });
    const roles = p.tiles.map((t) => t.role);
    expect(roles.filter((r) => r === 'corner')).toHaveLength(4);
    expect(roles.filter((r) => r === 'edge')).toHaveLength(4);
    expect(roles.filter((r) => r === 'center')).toHaveLength(1);
    expect(tileAt(p, 0, 0).edges).toEqual({ top: true, left: true, right: false, bottom: false });
    expect(tileAt(p, 1, 1).edges).toEqual({ top: false, left: false, right: false, bottom: false });
    expect(tileAt(p, 2, 2).edges).toEqual({ top: false, left: false, right: true, bottom: true });
  });

  it('treats a single tile as the centre and strip ends as edges', () => {
    expect(plan({ width: 100, height: 100, rows: 1, cols: 1 }).tiles[0]).toMatchObject({
      role: 'center',
      edges: { top: true, right: true, bottom: true, left: true },
    });
    const strip = plan({ width: 900, height: 300, rows: 1, cols: 3 });
    expect(strip.tiles.map((t) => t.role)).toEqual(['edge', 'center', 'edge']);
  });
});

describe('supported sizes', () => {
  it.each([
    [1001, 777, 2, 3],
    [4000, 500, 1, 6],
    [500, 4000, 6, 1],
    [512, 512, 6, 6],
    [8192, 8192, 6, 6],
    [3, 3, 3, 3],
    [1, 1, 1, 1],
    [2, 2000, 6, 1],
  ])('produces a schema-valid plan for %ix%i on %i rows x %i cols', (width, height, rows, cols) => {
    for (const wrap of [false, true]) {
      const p = planTiles({ width, height, rows, cols, overlapPct: 25, wrap });
      expect(TilePlanSchema.safeParse(p).success).toBe(true);
      expect(p.tiles).toHaveLength(rows * cols);
    }
  });

  it('plans 6x6 on 8192x8192 in under 100 ms', () => {
    planTiles({ width: 8192, height: 8192, rows: 6, cols: 6, overlapPct: 40 });
    const started = performance.now();
    planTiles({ width: 8192, height: 8192, rows: 6, cols: 6, overlapPct: 40, wrap: true });
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('is deterministic and does not touch its input', () => {
    const options: PlanOptions = { width: 1001, height: 777, rows: 3, cols: 2, overlapPct: 12.5, wrap: true };
    const frozen = Object.freeze({ ...options });
    expect(planTiles(frozen)).toEqual(planTiles({ ...options }));
  });
});

describe('validation', () => {
  const base: PlanOptions = { width: 100, height: 100, rows: 2, cols: 2, overlapPct: 10 };

  it.each([
    [{ width: 0 }, 'invalid-size'],
    [{ height: -5 }, 'invalid-size'],
    [{ width: 10.5 }, 'invalid-size'],
    [{ width: NaN }, 'invalid-size'],
    [{ rows: 0 }, 'invalid-grid'],
    [{ rows: 7 }, 'invalid-grid'],
    [{ cols: 2.5 }, 'invalid-grid'],
    [{ overlapPct: -1 }, 'invalid-overlap'],
    [{ overlapPct: 41 }, 'invalid-overlap'],
    [{ overlapPct: NaN }, 'invalid-overlap'],
    [{ aspects: [] }, 'invalid-aspects'],
    [{ aspects: [[0, 1]] }, 'invalid-aspects'],
    [{ aspects: [[1.5, 1]] }, 'invalid-aspects'],
    [{ width: 3, cols: 4 }, 'grid-too-fine'],
    [{ height: 2, rows: 3 }, 'grid-too-fine'],
  ] as const)('rejects %j with %s', (override, code) => {
    expect(errorCode({ ...base, ...(override as Partial<PlanOptions>) })).toBe(code);
  });

  it('accepts the limits', () => {
    expect(errorCode({ ...base, overlapPct: 0 })).toBe('none');
    expect(errorCode({ ...base, overlapPct: 40, rows: 6, cols: 6, width: 6, height: 6 })).toBe('none');
  });
});
