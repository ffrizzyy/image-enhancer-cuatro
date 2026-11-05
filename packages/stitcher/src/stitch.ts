import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { StitchInput, StitchResult } from '@ie/contracts';
import { loadRgba } from '@ie/slicer';
import sharp from 'sharp';

import { alignTiles } from './align';
import type { MatchResult } from './colorMatch';
import { composeTiles } from './compose';
import { harmonize } from './harmonize';
import { seamScore } from './metrics';

export interface StitchIo {
  /** The original image: the alignment reference and the low-frequency reference for harmonization. */
  sourcePath: string;
  /** Where the stitched PNG is written. */
  outDir: string;
  fileName?: string;
}

export interface StitchReport extends StitchResult {
  /** Indexes of tiles that need review, with the reason they were set aside. Every flagged tile is still placed. */
  flaggedDetails: Array<{ index: number; shift: { dx: number; dy: number }; confident: boolean }>;
  harmonized: boolean;
  colors: Pick<MatchResult, 'before' | 'after'> | null;
  timingsMs: { load: number; align: number; compose: number; harmonize: number; metrics: number; write: number; total: number };
}

/**
 * The whole pipeline: normalise and align each provider output, match colours, blend, harmonize, score, and
 * write one PNG at the source size. Tiles that need review are reported, never dropped.
 */
export async function stitch(input: StitchInput, io: StitchIo): Promise<StitchReport> {
  const clock = (): number => performance.now();
  const t0 = clock();
  const { plan, options } = input;

  const source = await loadRgba(io.sourcePath);
  if (source.width !== plan.source.width || source.height !== plan.source.height) {
    throw new RangeError(`The source is ${source.width}x${source.height}, but the plan was made for ${plan.source.width}x${plan.source.height}.`);
  }
  const t1 = clock();

  const aligned = await alignTiles({ plan, source, outputs: input.tiles, maxShiftPx: options.maxShiftPx });
  const t2 = clock();

  const flagged = new Set(aligned.flagged);
  const composed = composeTiles(
    { plan, tiles: aligned.tiles.map((t) => ({ index: t.index, image: t.image })), excludeFromColorMatch: flagged },
    { blend: options.blend },
  );
  const t3 = clock();

  const drift = options.harmonize ? harmonize(composed.image, source, { wrap: plan.wrap }) : null;
  const finalImage = drift?.image ?? composed.image;
  const t4 = clock();

  const seams = seamScore(plan, finalImage, source);
  const t5 = clock();

  mkdirSync(io.outDir, { recursive: true });
  const imagePath = path.join(io.outDir, io.fileName ?? 'stitched.png');
  await sharp(finalImage.data, { raw: { width: finalImage.width, height: finalImage.height, channels: 4 } })
    .png({ compressionLevel: 3 })
    .toFile(imagePath);
  const t6 = clock();

  return {
    imagePath,
    metrics: { seamScore: seams.seamScore, maxDeltaE: composed.colors?.after.maxDeltaE ?? 0 },
    flagged: aligned.flagged,
    flaggedDetails: aligned.tiles.filter((t) => t.flagged).map((t) => ({ index: t.index, shift: t.shift, confident: t.confident })),
    harmonized: drift?.applied ?? false,
    colors: composed.colors ? { before: composed.colors.before, after: composed.colors.after } : null,
    timingsMs: { load: t1 - t0, align: t2 - t1, compose: t3 - t2, harmonize: t4 - t3, metrics: t5 - t4, write: t6 - t5, total: t6 - t0 },
  };
}
