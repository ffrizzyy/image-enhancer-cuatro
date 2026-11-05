import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { BlendMode, TilePlan } from '@ie/contracts';
import { countDifferentPixels, extractRegion, extractTiles, planTiles, type Rgba } from '@ie/slicer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { alignTiles, composeTiles, rgbToLab, deltaE76 } from '../src';
import { castLab, meanAbsDiff, structured, writePng, type LabCast } from './support/synth';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ie-compose-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FIXTURES = [
  { name: '1001x777', width: 1001, height: 777, rows: 2, cols: 3 },
  { name: '4000x500', width: 4000, height: 500, rows: 1, cols: 6 },
  { name: '512x512', width: 512, height: 512, rows: 2, cols: 2 },
] as const;

/** Slice a real image file, treat the unchanged tiles as provider output, align them, and compose. */
interface Fixture {
  name: string;
  width: number;
  height: number;
  rows: number;
  cols: number;
}

async function roundTrip(fixture: Fixture, seed: number, opts: { wrap?: boolean; blend: BlendMode; matchColors?: boolean; overlapPct?: number }) {
  const source = structured(fixture.width, fixture.height, seed);
  const file = path.join(dir, `${fixture.name}-${seed}.png`);
  await writePng(source, file);

  const plan = planTiles({ ...fixture, overlapPct: opts.overlapPct ?? 15, wrap: opts.wrap ?? false });
  const extracted = await extractTiles(file, plan, path.join(dir, `tiles-${fixture.name}-${seed}-${opts.blend}-${opts.wrap ?? false}`));
  const aligned = await alignTiles({ plan, source, outputs: extracted.tiles.map((t) => ({ index: t.index, path: t.path })) });
  const composed = composeTiles({ plan, tiles: aligned.tiles.map((t) => ({ index: t.index, image: t.image })) }, { blend: opts.blend, matchColors: opts.matchColors ?? true });
  return { source, plan, aligned, composed };
}

describe('unchanged tiles reproduce the source exactly', () => {
  for (const fixture of FIXTURES) {
    for (const blend of ['multiband', 'feather'] as const) {
      it(`${fixture.name}, ${blend}`, { timeout: 120_000 }, async () => {
        const { source, aligned, composed } = await roundTrip(fixture, 1, { blend });
        expect(aligned.flagged).toEqual([]);
        expect([composed.image.width, composed.image.height]).toEqual([fixture.width, fixture.height]);
        expect(countDifferentPixels(source.data, composed.image.data)).toBe(0);
      });
    }
  }

  it('with colour matching switched off', { timeout: 120_000 }, async () => {
    const { source, composed } = await roundTrip(FIXTURES[2], 2, { blend: 'multiband', matchColors: false });
    expect(composed.colors).toBeNull();
    expect(countDifferentPixels(source.data, composed.image.data)).toBe(0);
  });

  for (const fixture of [FIXTURES[2], FIXTURES[0]]) {
    it(`${fixture.name} in wrap mode, where the border seams are blended too`, { timeout: 120_000 }, async () => {
      const { source, composed } = await roundTrip(fixture, 3, { blend: 'multiband', wrap: true });
      expect(countDifferentPixels(source.data, composed.image.data)).toBe(0);
    });
  }

  it('with no overlap at all (tiles that merely touch)', { timeout: 120_000 }, async () => {
    const { source, composed } = await roundTrip(FIXTURES[2], 4, { blend: 'multiband', overlapPct: 0 });
    expect(countDifferentPixels(source.data, composed.image.data)).toBe(0);
  });

  it('with a single tile', { timeout: 120_000 }, async () => {
    const { source, composed } = await roundTrip({ name: 'one', width: 300, height: 200, rows: 1, cols: 1 }, 5, { blend: 'multiband' });
    expect(countDifferentPixels(source.data, composed.image.data)).toBe(0);
  });

  it('defaults to multiband blending with colour matching on', async () => {
    const source = structured(300, 200, 6);
    const plan = planTiles({ width: 300, height: 200, rows: 1, cols: 2, overlapPct: 20 });
    const tiles = plan.tiles.map((t) => ({ index: t.index, image: { data: extractRegion(source, t.crop, false), width: t.crop.width, height: t.crop.height } }));
    const result = composeTiles({ plan, tiles });
    expect(result.colors).not.toBeNull();
    expect(result.blend.chunks).toBeGreaterThan(0); // multiband does its work in chunks
    expect(countDifferentPixels(source.data, result.image.data)).toBe(0);
  });
});

describe('colour casts', () => {
  const source = structured(900, 600, 51);
  const plan = planTiles({ width: 900, height: 600, rows: 2, cols: 3, overlapPct: 15 });
  const cropOf = (tile: TilePlan['tiles'][number], cast?: LabCast): Rgba => {
    const image: Rgba = { data: extractRegion(source, tile.crop, false), width: tile.crop.width, height: tile.crop.height };
    return cast ? castLab(image, cast) : image;
  };
  const casts: Record<number, LabCast> = { 1: { dL: 10 }, 2: { da: -9, db: 7 }, 4: { gainL: 1.15, dL: -5 } };
  const tiles = plan.tiles.map((t) => ({ index: t.index, image: cropOf(t, casts[t.index]) }));

  /** Mean Lab colour of a vertical strip of the stitched image, for comparing the two sides of a seam. */
  const stripColour = (image: Rgba, x0: number, x1: number, y0: number, y1: number): [number, number, number] => {
    let l = 0;
    let a = 0;
    let b = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * image.width + x) * 4;
        const lab = rgbToLab(image.data[i]!, image.data[i + 1]!, image.data[i + 2]!);
        l += lab[0];
        a += lab[1];
        b += lab[2];
        n++;
      }
    }
    return [l / n, a / n, b / n];
  };

  it('are matched in the overlaps, and the stitched image has no colour step across the seam', () => {
    const matched = composeTiles({ plan, tiles }, { blend: 'multiband' });
    const unmatched = composeTiles({ plan, tiles }, { blend: 'multiband', matchColors: false });

    expect(matched.colors!.before.maxDeltaE).toBeGreaterThan(5);
    expect(matched.colors!.after.maxDeltaE).toBeLessThanOrEqual(3);

    // Tile 0 | tile 1 meet near x = 300 on the top row. Compare strips either side, clear of the blend
    // zone, and count only the step the casts add: the same strips in the uncast source set the baseline.
    const across = (image: Rgba): [number, number, number] => {
      const left = stripColour(image, 240, 262, 20, 280);
      const right = stripColour(image, 338, 360, 20, 280);
      return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
    };
    const baseline = across(source);
    const addedStep = (image: Rgba): number => {
      const now = across(image);
      return deltaE76([now[0] - baseline[0], now[1] - baseline[1], now[2] - baseline[2]], [0, 0, 0]);
    };
    expect(addedStep(unmatched.image)).toBeGreaterThan(6);
    expect(addedStep(matched.image)).toBeLessThan(3);
  });

  it('are also matched across the wrap-around border, so opposite edges meet without a step', () => {
    const wrapPlan = planTiles({ width: 900, height: 600, rows: 2, cols: 3, overlapPct: 15, wrap: true });
    // Tile 0 owns the left edge and tile 2 the right edge of the top row: they are neighbours on the torus.
    const wrapCasts: Record<number, LabCast> = { 0: { dL: 12, da: 6 } };
    const wrapTiles = wrapPlan.tiles.map((t) => {
      const image: Rgba = { data: extractRegion(source, t.crop, true), width: t.crop.width, height: t.crop.height };
      return { index: t.index, image: wrapCasts[t.index] ? castLab(image, wrapCasts[t.index]!) : image };
    });

    const matched = composeTiles({ plan: wrapPlan, tiles: wrapTiles }, { blend: 'multiband' });
    const unmatched = composeTiles({ plan: wrapPlan, tiles: wrapTiles }, { blend: 'multiband', matchColors: false });

    // Strips in the cores of tile 2 (right edge) and tile 0 (left edge), clear of the blend zone around the
    // wrap border: opposite edges of the picture, neighbours once it wraps.
    const across = (image: Rgba): [number, number, number] => {
      const right = stripColour(image, 778, 800, 20, 280);
      const left = stripColour(image, 100, 122, 20, 280);
      return [right[0] - left[0], right[1] - left[1], right[2] - left[2]];
    };
    const baseline = across(source);
    const addedStep = (image: Rgba): number => {
      const now = across(image);
      return deltaE76([now[0] - baseline[0], now[1] - baseline[1], now[2] - baseline[2]], [0, 0, 0]);
    };

    expect(matched.colors!.after.perOverlap.some((o) => o.a === 0 && o.b === 2)).toBe(true);
    expect(addedStep(unmatched.image)).toBeGreaterThan(6);
    expect(addedStep(matched.image)).toBeLessThan(3);

    // At the border itself the last and first columns are neighbours on the torus. Even without colour
    // matching, the seam across it is blended, so there is no hard step (a cast of ~13 would show as one).
    const border = (image: Rgba): number => {
      const last = stripColour(image, 897, 900, 20, 280);
      const first = stripColour(image, 0, 3, 20, 280);
      const base = [stripColour(source, 897, 900, 20, 280), stripColour(source, 0, 3, 20, 280)];
      return deltaE76(
        [last[0] - first[0], last[1] - first[1], last[2] - first[2]],
        [base[0]![0] - base[1]![0], base[0]![1] - base[1]![1], base[0]![2] - base[1]![2]],
      );
    };
    expect(border(unmatched.image)).toBeLessThan(5);
  });

  it('keep tiles you exclude from colour matching exactly as they came', () => {
    const result = composeTiles({ plan, tiles, excludeFromColorMatch: new Set([1]) }, { blend: 'feather' });
    expect(result.colors!.corrections[1]!.identity).toBe(true);
    expect(result.colors!.images.get(1)).toBe(tiles[1]!.image);
  });
});

describe('chunking and memory', () => {
  it('gives the same picture however the work is chunked, with bounded floating-point buffers', { timeout: 120_000 }, () => {
    const source = structured(600, 400, 61);
    const plan = planTiles({ width: 600, height: 400, rows: 2, cols: 3, overlapPct: 15 });
    const tiles = plan.tiles.map((t) => ({
      index: t.index,
      image: castLab({ data: extractRegion(source, t.crop, false), width: t.crop.width, height: t.crop.height }, t.index === 3 ? { dL: 6 } : {}),
    }));

    const whole = composeTiles({ plan, tiles }, { blend: 'multiband', chunkRows: 100_000 });
    const chunked = composeTiles({ plan, tiles }, { blend: 'multiband', chunkRows: 48 });

    expect(meanAbsDiff(whole.image, chunked.image, { x: 0, y: 0, width: 600, height: 400 })).toBeLessThan(0.5);
    expect(chunked.blend.chunks).toBeGreaterThan(whole.blend.chunks);

    // Overlap is at most 2 * overlapPx wide; padding <= 64 columns, margin <= 128 rows.
    const bound = (2 * plan.overlapPx + 128) * (48 + 256);
    expect(chunked.blend.peakFloatPixels).toBeLessThanOrEqual(bound);
    expect(chunked.blend.peakFloatPixels).toBeLessThan(whole.blend.peakFloatPixels);
    expect(chunked.blend.peakFloatPixels).toBeLessThan(600 * 400 * 0.2);
  });
});

describe('errors', () => {
  it('reports a missing tile image', () => {
    const plan = planTiles({ width: 100, height: 100, rows: 1, cols: 2, overlapPct: 10 });
    expect(() => composeTiles({ plan, tiles: [{ index: 0, image: structured(60, 100, 1) }] })).toThrow(/Missing image for tile 1/);
  });
});
