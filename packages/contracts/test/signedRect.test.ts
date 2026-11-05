import { describe, expect, it } from 'vitest';

import { RectSchema, SignedRectSchema, TileSchema } from '../src/index.js';

const rect = { x: 0, y: 0, width: 10, height: 10 };

describe('signed rects for crop and send', () => {
  it('accept coordinates outside the image, but still need a positive size', () => {
    expect(SignedRectSchema.safeParse({ x: -20, y: -6, width: 240, height: 240 }).success).toBe(true);
    expect(SignedRectSchema.safeParse({ ...rect, width: 0 }).success).toBe(false);
    expect(SignedRectSchema.safeParse({ ...rect, x: 1.5 }).success).toBe(false);
  });

  it('leave RectSchema strict: a core can never be negative', () => {
    expect(RectSchema.safeParse({ ...rect, x: -1 }).success).toBe(false);
  });

  it('a tile may have a negative crop and send, but not a negative core', () => {
    const tile = {
      index: 0,
      row: 0,
      col: 0,
      core: rect,
      crop: { x: -2, y: -2, width: 14, height: 14 },
      send: { x: -3, y: -3, width: 16, height: 16 },
      edges: { top: true, right: false, bottom: false, left: true },
      role: 'corner',
    };
    expect(TileSchema.safeParse(tile).success).toBe(true);
    expect(TileSchema.safeParse({ ...tile, core: { ...rect, x: -1 } }).success).toBe(false);
  });
});