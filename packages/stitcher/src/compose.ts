import type { BlendMode, TilePlan } from '@ie/contracts';
import type { Rgba } from '@ie/slicer';

import { blendPair, transpose, type BlendStats, type Placed } from './blend';
import { matchColors, type MatchResult } from './colorMatch';

const CHANNELS = 4;

export interface ComposeInput {
  plan: TilePlan;
  /** Each tile cut to its `crop` rect (the output of alignment). */
  tiles: ReadonlyArray<{ index: number; image: Rgba }>;
  /** Tiles to leave out of colour matching (for example tiles flagged for review). They are still placed. */
  excludeFromColorMatch?: ReadonlySet<number>;
}

export interface ComposeOptions {
  blend?: BlendMode;
  matchColors?: boolean;
  chunkRows?: number;
}

export interface ComposeResult {
  /** The stitched image at the plan's source size (alpha is always opaque). */
  image: Rgba;
  colors: MatchResult | null;
  blend: BlendStats;
}

interface Entry {
  placed: Placed;
}

/** The tile crops to place. For wrap plans, edge tiles also appear shifted by one image size so the seam across the border is blended too. */
function placements(plan: TilePlan, images: ReadonlyMap<number, Rgba>): Entry[] {
  const { width, height } = plan.source;
  const shifts: Array<[number, number]> = plan.wrap
    ? [-height, 0, height].flatMap((oy) => [-width, 0, width].map((ox): [number, number] => [ox, oy]))
    : [[0, 0]];

  const entries: Entry[] = [];
  for (const tile of plan.tiles) {
    const image = images.get(tile.index);
    if (!image) throw new Error(`Missing image for tile ${tile.index}`);
    for (const [ox, oy] of shifts) {
      const x = tile.crop.x + ox;
      const y = tile.crop.y + oy;
      const touchesImage = x < width && x + image.width > 0 && y < height && y + image.height > 0;
      if (touchesImage) entries.push({ placed: { image, x, y } });
    }
  }
  return entries;
}

/**
 * Assembles aligned tiles into one image: matches their colours, blends each row of tiles left to
 * right, then blends the rows top to bottom. Pixels no overlap touches are copied unchanged, so tiles
 * that already agree reproduce the source exactly.
 */
export function composeTiles({ plan, tiles, excludeFromColorMatch }: ComposeInput, options: ComposeOptions = {}): ComposeResult {
  const mode = options.blend ?? 'multiband';
  const stats: BlendStats = { chunks: 0, peakFloatPixels: 0 };

  const original = new Map(tiles.map((t) => [t.index, t.image]));
  const colors = options.matchColors === false ? null : matchColors(plan, original, excludeFromColorMatch);
  const images = colors?.images ?? original;

  // Group tiles into rows by their vertical extent.
  const rows = new Map<string, Placed[]>();
  for (const { placed } of placements(plan, images)) {
    const key = `${placed.y}:${placed.image.height}`;
    rows.set(key, [...(rows.get(key) ?? []), placed]);
  }

  const blendOptions = { mode, stats, ...(options.chunkRows !== undefined ? { chunkRows: options.chunkRows } : {}) };
  const strips = [...rows.values()]
    .sort((a, b) => a[0]!.y - b[0]!.y)
    .map((row) => row.sort((a, b) => a.x - b.x).reduce((strip, next) => blendPair(strip, next, blendOptions)));

  // Rows blend the same way columns do, after swapping axes.
  const transposed = strips.map(transpose);
  const merged = transpose(transposed.slice(1).reduce((acc, next) => blendPair(acc, next, blendOptions), transposed[0]!));

  // Cut the source-sized window out of the (for wrap, slightly larger) canvas.
  const { width, height } = plan.source;
  const window = Buffer.alloc(width * height * CHANNELS);
  for (let y = 0; y < height; y++) {
    const from = ((y - merged.y) * merged.image.width - merged.x) * CHANNELS;
    merged.image.data.copy(window, y * width * CHANNELS, from, from + width * CHANNELS);
  }
  return { image: { data: window, width, height }, colors, blend: stats };
}
