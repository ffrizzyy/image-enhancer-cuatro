import type { Fidelity, Rect } from '@ie/contracts';
import { loadRgba, type Rgba } from '@ie/slicer';
import { normalizeTile } from '@ie/stitcher';
import sharp from 'sharp';

/** The lowest structural similarity (0..1) to the source tile that a tile of each fidelity level may have. */
export const FIDELITY_THRESHOLDS: Record<Fidelity, number> = { strict: 0.9, preserve: 0.8, balanced: 0.65, reimagine: 0.4 };

/** Both pictures are compared at this size: low frequencies only, so added detail does not count against a tile. */
export const COMPARE_SIZE = 32;
const WINDOW = 8;
const STRIDE = 4;

/** An output smaller than this on its longer side is not a usable tile. */
export const MIN_OUTPUT_PX = 256;
/** How far the output's shape may differ from the tile's before it is rejected (a provider that reframed it). */
export const ASPECT_TOLERANCE = 0.08;
/** A picture with less spread than this (grey levels) is a blank frame, if the source has more than `FLAT_SOURCE_STD`. */
const BLANK_STD = 2;
const FLAT_SOURCE_STD = 6;

const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

/** Greyscale at COMPARE_SIZE x COMPARE_SIZE, as numbers 0..255. */
async function lowFrequency(image: Rgba): Promise<Float64Array> {
  const { data } = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } })
    .removeAlpha()
    .greyscale()
    .resize(COMPARE_SIZE, COMPARE_SIZE, { fit: 'fill', kernel: 'cubic' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return Float64Array.from(data);
}

/** Mean SSIM over sliding windows of two equally sized greyscale grids. 1 means identical structure. */
function meanSsim(a: Float64Array, b: Float64Array, size: number): number {
  let total = 0;
  let windows = 0;
  for (let y = 0; y + WINDOW <= size; y += STRIDE) {
    for (let x = 0; x + WINDOW <= size; x += STRIDE) {
      let sa = 0;
      let sb = 0;
      for (let j = 0; j < WINDOW; j++) for (let i = 0; i < WINDOW; i++) {
        sa += a[(y + j) * size + x + i]!;
        sb += b[(y + j) * size + x + i]!;
      }
      const n = WINDOW * WINDOW;
      const ma = sa / n;
      const mb = sb / n;
      let va = 0;
      let vb = 0;
      let cov = 0;
      for (let j = 0; j < WINDOW; j++) for (let i = 0; i < WINDOW; i++) {
        const da = a[(y + j) * size + x + i]! - ma;
        const db = b[(y + j) * size + x + i]! - mb;
        va += da * da;
        vb += db * db;
        cov += da * db;
      }
      va /= n - 1;
      vb /= n - 1;
      cov /= n - 1;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      windows++;
    }
  }
  return total / windows;
}

/** Low-frequency structural similarity of two pictures of the same shape, from about 0 (unrelated) to 1 (the same). */
export async function structuralSimilarity(a: Rgba, b: Rgba): Promise<number> {
  const [ga, gb] = await Promise.all([lowFrequency(a), lowFrequency(b)]);
  return Math.max(0, meanSsim(ga, gb, COMPARE_SIZE));
}

function spread(grid: Float64Array): number {
  const mean = grid.reduce((s, v) => s + v, 0) / grid.length;
  return Math.sqrt(grid.reduce((s, v) => s + (v - mean) ** 2, 0) / grid.length);
}

export interface QualityVerdict {
  accepted: boolean;
  /** Structural similarity to the source tile, or null when the output could not be compared. */
  score: number | null;
  threshold: number;
  /** Why it was rejected; empty when accepted. */
  reasons: string[];
  width: number | null;
  height: number | null;
}

export interface QualityInput {
  outputPath: string;
  /** The tile as it was sent: the pixels of its `send` rect. */
  sourceTile: Rgba;
  send: Pick<Rect, 'width' | 'height'>;
  fidelity: Fidelity;
}

/**
 * Decides whether a provider's output may become part of the picture. It must decode, have a plausible size and
 * shape, not be blank, and keep enough of the source tile's low-frequency structure for its fidelity level. A tile
 * that fails any check is never accepted silently.
 */
export async function evaluateOutput({ outputPath, sourceTile, send, fidelity }: QualityInput): Promise<QualityVerdict> {
  const threshold = FIDELITY_THRESHOLDS[fidelity];
  const reject = (reasons: string[], score: number | null, width: number | null, height: number | null): QualityVerdict => ({ accepted: false, score, threshold, reasons, width, height });

  let output: Rgba;
  try {
    output = await loadRgba(outputPath);
  } catch {
    return reject(['The output is not a readable image.'], null, null, null);
  }
  const { width, height } = output;

  if (Math.max(width, height) < MIN_OUTPUT_PX) return reject([`The output is only ${width}x${height} px, too small to use.`], null, width, height);
  const aspect = width / height / (send.width / send.height);
  if (Math.abs(aspect - 1) > ASPECT_TOLERANCE) {
    return reject([`The output is ${width}x${height} px, a different shape from the tile (${send.width}x${send.height}); the provider reframed it.`], null, width, height);
  }

  const normalized = (await normalizeTile(output, send)).image;
  const [sourceGrid, outputGrid] = await Promise.all([lowFrequency(sourceTile), lowFrequency(normalized)]);
  if (spread(outputGrid) < BLANK_STD && spread(sourceGrid) > FLAT_SOURCE_STD) return reject(['The output is a blank frame.'], 0, width, height);

  const score = Math.max(0, meanSsim(sourceGrid, outputGrid, COMPARE_SIZE));
  if (score < threshold) {
    return reject([`The output no longer matches the source tile closely enough (similarity ${score.toFixed(2)}, needs ${threshold.toFixed(2)} for ${fidelity} fidelity).`], score, width, height);
  }
  return { accepted: true, score, threshold, reasons: [], width, height };
}
