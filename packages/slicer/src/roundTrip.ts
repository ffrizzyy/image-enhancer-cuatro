import type { TilePlan } from '@ie/contracts';

import type { TileFile } from './extract';
import { CHANNELS, countDifferentPixels, loadRgba, type Rgba } from './pixels';

/**
 * Reference "stitch of unchanged tiles": puts each tile's core, cut out of its tile image, back where
 * it came from. Because cores are disjoint and cover the source, the result must equal the source.
 * Shared by the slicer tests and, later, the stitcher's no-op round trip.
 */
export async function reassembleCores(plan: TilePlan, tiles: readonly TileFile[]): Promise<Rgba> {
  const { width, height } = plan.source;
  const canvas = Buffer.alloc(width * height * CHANNELS);

  for (const planned of plan.tiles) {
    const file = tiles.find((t) => t.index === planned.index);
    if (!file) throw new Error(`Missing tile file for index ${planned.index}`);
    const image = await loadRgba(file.path);

    const { core } = planned;
    for (let row = 0; row < core.height; row++) {
      const from = ((file.coreInTile.y + row) * image.width + file.coreInTile.x) * CHANNELS;
      const to = ((core.y + row) * width + core.x) * CHANNELS;
      image.data.copy(canvas, to, from, from + core.width * CHANNELS);
    }
  }
  return { data: canvas, width, height };
}

export interface RoundTripResult {
  differentPixels: number;
  /** True when the sizes match and every pixel is identical. */
  identical: boolean;
}

/** Compares a rebuilt image with the source file, pixel for pixel (EXIF orientation applied to both). */
export async function compareWithSource(sourcePath: string, rebuilt: Rgba): Promise<RoundTripResult> {
  const source = await loadRgba(sourcePath);
  if (source.width !== rebuilt.width || source.height !== rebuilt.height) {
    return { differentPixels: Math.max(source.width * source.height, rebuilt.width * rebuilt.height), identical: false };
  }
  const differentPixels = countDifferentPixels(source.data, rebuilt.data);
  return { differentPixels, identical: differentPixels === 0 };
}
