import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { Rect, StitchInput, StitchResult, TilePlan } from '@ie/contracts';
import { loadRgba, type Rgba } from '@ie/slicer';
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


/** The finished picture is never allowed past this many pixels, however large the provider tiles are. */
const MAX_OUTPUT_PIXELS = 72_000_000;
const MAX_SCALE = 4;

const scaleRect = (r: Rect, s: number): Rect => ({ x: r.x * s, y: r.y * s, width: r.width * s, height: r.height * s });

/** Multiplies every length in the plan by `s`, so tiles that came back larger than they were sent keep their extra detail. */
function scalePlan(plan: TilePlan, s: number): TilePlan {
  if (s === 1) return plan;
  return {
    ...plan,
    source: { width: plan.source.width * s, height: plan.source.height * s },
    overlapPx: plan.overlapPx * s,
    tiles: plan.tiles.map((t) => ({ ...t, core: scaleRect(t.core, s), crop: scaleRect(t.crop, s), send: scaleRect(t.send, s) })),
  };
}

/**
 * How many times larger than the source the result should be: the whole-number size ratio at which providers actually
 * returned their tiles (typically 1 for large pictures, 2+ for small ones). Downscaling those tiles back to the
 * source size is what threw their detail away.
 */
async function chooseScale(plan: TilePlan, outputs: StitchInput['tiles']): Promise<number> {
  const ratios: number[] = [];
  for (const tile of plan.tiles) {
    const output = outputs.find((o) => o.index === tile.index);
    if (!output) continue;
    const meta = await sharp(output.path).metadata();
    if (meta.width && meta.height) ratios.push(Math.min(meta.width / tile.send.width, meta.height / tile.send.height));
  }
  if (ratios.length === 0) return 1;
  ratios.sort((a, b) => a - b);
  let scale = Math.min(MAX_SCALE, Math.max(1, Math.round(ratios[Math.floor(ratios.length / 2)]!)));
  while (scale > 1 && plan.source.width * plan.source.height * scale * scale > MAX_OUTPUT_PIXELS) scale--;
  return scale;
}

async function upscaleImage(image: Rgba, s: number): Promise<Rgba> {
  if (s === 1) return image;
  const { data, info } = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } })
    .resize(image.width * s, image.height * s, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * The whole pipeline: normalise and align each provider output, match colours, blend, harmonize, score, and
 * write one PNG at the source size. Tiles that need review are reported, never dropped.
 */
export async function stitch(input: StitchInput, io: StitchIo): Promise<StitchReport> {
  const clock = (): number => performance.now();
  const t0 = clock();
  const { options } = input;

  const originalSource = await loadRgba(io.sourcePath);
  if (originalSource.width !== input.plan.source.width || originalSource.height !== input.plan.source.height) {
    throw new RangeError(
      `The source is ${originalSource.width}x${originalSource.height}, but the plan was made for ${input.plan.source.width}x${input.plan.source.height}.`,
    );
  }
  const scale = await chooseScale(input.plan, input.tiles);
  const plan = scalePlan(input.plan, scale);
  const source = await upscaleImage(originalSource, scale);
  const t1 = clock();

  const aligned = await alignTiles({ plan, source, outputs: input.tiles, maxShiftPx: options.maxShiftPx * scale });
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
