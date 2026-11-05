import type { TilePlan } from '@ie/contracts';
import { extractRegion, loadRgba, type Rgba } from '@ie/slicer';

import { cropToCrop, normalizeTile } from './normalize';

const CHANNELS = 4;

export const DEFAULT_MAX_SHIFT_PX = 8;

/** Long-side target for the medium search level; small enough to be fast, large enough to keep structure. */
const COARSE_TARGET = 128;
/** The wide search looks this many times `maxShiftPx` out, so a large shift is measured rather than missed. */
const WIDE_FACTOR = 4;
/** Smallest image side (in pixels) the wide level may shrink to. */
const MIN_WIDE_SIDE = 24;
/** The coarse levels correlate on a central window of at most this many pixels per side. */
const COARSE_WINDOW = 96;
/** The full-resolution refinement uses a central window of at most this many pixels per side. */
const REFINE_WINDOW = 256;
/** A correlation peak below this is not trusted. */
const MIN_SCORE = 0.4;
/** A region whose grayscale variance is below this has no structure to align on. */
const FLAT_VARIANCE = 4;

interface Gray {
  data: Float32Array;
  width: number;
  height: number;
}

interface Window {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function toGray(image: Rgba): Gray {
  const n = image.width * image.height;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * CHANNELS;
    data[i] = 0.299 * image.data[o]! + 0.587 * image.data[o + 1]! + 0.114 * image.data[o + 2]!;
  }
  return { data, width: image.width, height: image.height };
}

/** Box-filter downsample by an integer factor. */
function downsample(gray: Gray, factor: number): Gray {
  if (factor === 1) return gray;
  const width = Math.floor(gray.width / factor);
  const height = Math.floor(gray.height / factor);
  const data = new Float32Array(width * height);
  const area = factor * factor;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let j = 0; j < factor; j++) {
        const row = (y * factor + j) * gray.width + x * factor;
        for (let i = 0; i < factor; i++) sum += gray.data[row + i]!;
      }
      data[y * width + x] = sum / area;
    }
  }
  return { data, width, height };
}

function variance(gray: Gray): number {
  let sum = 0;
  let sumSq = 0;
  for (const v of gray.data) {
    sum += v;
    sumSq += v * v;
  }
  const n = gray.data.length;
  return sumSq / n - (sum / n) ** 2;
}

const centerWindow = (g: Gray, cap: number): Window => {
  const w = Math.min(g.width, cap);
  const h = Math.min(g.height, cap);
  const x0 = Math.floor((g.width - w) / 2);
  const y0 = Math.floor((g.height - h) / 2);
  return { x0, y0, x1: x0 + w, y1: y0 + h };
};

/**
 * Normalized cross-correlation of `ref` with `tile` displaced by (u, v): tile pixel (x + u, y + v)
 * is compared with ref pixel (x, y) over the part of `window` where both exist. One pass, using
 * running sums. Returns -1 when the overlap is too small or flat to mean anything.
 */
function ncc(ref: Gray, tile: Gray, u: number, v: number, window: Window): number {
  const x0 = Math.max(window.x0, -u, 0);
  const y0 = Math.max(window.y0, -v, 0);
  const x1 = Math.min(window.x1, tile.width - u, ref.width);
  const y1 = Math.min(window.y1, tile.height - v, ref.height);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 8 || h < 8) return -1;

  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let y = y0; y < y1; y++) {
    const ra = y * ref.width;
    const rb = (y + v) * tile.width + u;
    for (let x = x0; x < x1; x++) {
      const a = ref.data[ra + x]!;
      const b = tile.data[rb + x]!;
      sa += a;
      sb += b;
      saa += a * a;
      sbb += b * b;
      sab += a * b;
    }
  }
  const n = w * h;
  const varA = saa - (sa * sa) / n;
  const varB = sbb - (sb * sb) / n;
  if (varA / n < 1e-3 || varB / n < 1e-3) return -1;
  return (sab - (sa * sb) / n) / Math.sqrt(varA * varB);
}

interface Peak {
  u: number;
  v: number;
  score: number;
}

/** Best offset within `range` of (centerU, centerV). */
function search(ref: Gray, tile: Gray, centerU: number, centerV: number, range: number, window: Window): Peak {
  let best: Peak = { u: centerU, v: centerV, score: -2 };
  for (let v = centerV - range; v <= centerV + range; v++) {
    for (let u = centerU - range; u <= centerU + range; u++) {
      const score = ncc(ref, tile, u, v, window);
      if (score > best.score) best = { u, v, score };
    }
  }
  return best;
}

export interface ShiftEstimate {
  /** Where the tile's content sits relative to the reference: tile pixel (x + dx, y + dy) shows ref pixel (x, y). */
  dx: number;
  dy: number;
  /** Peak normalized cross-correlation, -1..1. */
  score: number;
  /** The correlation peak is strong enough to trust. When false, (0, 0) is returned. */
  confident: boolean;
  /** The reference has no structure to align on (a flat area), so no shift can be measured. */
  flat: boolean;
  /** The shift is larger than `maxShiftPx` (or beyond what the search could measure). */
  exceedsMax: boolean;
}

/**
 * A tile should be reviewed when its shift is too large, or when the reference has structure but the
 * tile matches nothing in it (different content, or a shift beyond the search). A flat reference is
 * simply uninformative and does not need review.
 */
export const needsReview = (e: ShiftEstimate): boolean => e.exceedsMax || (!e.confident && !e.flat);

/**
 * Estimates the integer translation between a reference and a tile of the same size, on
 * downsampled grayscale: a wide search several times `maxShiftPx` out at very low resolution, a medium
 * search around its winner, then a full-resolution refinement.
 */
export function estimateShift(reference: Rgba, tile: Rgba, maxShiftPx = DEFAULT_MAX_SHIFT_PX): ShiftEstimate {
  if (reference.width !== tile.width || reference.height !== tile.height) {
    throw new RangeError('Reference and tile must have the same size.');
  }
  const ref = toGray(reference);
  const img = toGray(tile);

  if (variance(ref) < FLAT_VARIANCE) return { dx: 0, dy: 0, score: -1, confident: false, flat: true, exceedsMax: false };

  const minSide = Math.min(ref.width, ref.height);
  const factor = Math.max(1, Math.floor(Math.max(ref.width, ref.height) / COARSE_TARGET));
  const wideFactor = Math.max(factor, Math.min(factor * WIDE_FACTOR, Math.floor(minSide / MIN_WIDE_SIDE)));
  const wideShift = WIDE_FACTOR * maxShiftPx;

  // Wide: measure shifts well beyond the limit at very low resolution.
  let centerU = 0;
  let centerV = 0;
  let mediumRange = Math.ceil(wideShift / factor) + 1;
  let atWideEdge = false;
  if (wideFactor > factor) {
    const wideRef = downsample(ref, wideFactor);
    const wideImg = downsample(img, wideFactor);
    const wideRange = Math.ceil(wideShift / wideFactor) + 1;
    const wide = search(wideRef, wideImg, 0, 0, wideRange, centerWindow(wideRef, COARSE_WINDOW));
    atWideEdge = Math.abs(wide.u) === wideRange || Math.abs(wide.v) === wideRange;
    centerU = Math.round((wide.u * wideFactor) / factor);
    centerV = Math.round((wide.v * wideFactor) / factor);
    mediumRange = Math.ceil(wideFactor / factor) + 1;
  }

  // Medium: refine the wide winner at the coarse resolution.
  const mediumRef = downsample(ref, factor);
  const mediumImg = downsample(img, factor);
  const medium = search(mediumRef, mediumImg, centerU, centerV, mediumRange, centerWindow(mediumRef, COARSE_WINDOW));

  // Fine: full resolution, on a central window so the cost stays bounded.
  const fine = search(ref, img, medium.u * factor, medium.v * factor, factor, centerWindow(ref, REFINE_WINDOW));

  if (fine.score < MIN_SCORE) {
    return { dx: 0, dy: 0, score: Math.max(fine.score, -1), confident: false, flat: false, exceedsMax: false };
  }
  const exceedsMax = atWideEdge || Math.abs(fine.u) > maxShiftPx || Math.abs(fine.v) > maxShiftPx;
  return { dx: fine.u, dy: fine.v, score: fine.score, confident: true, flat: false, exceedsMax };
}

/** Moves image content by (dx, dy) whole pixels; pixels that would come from outside repeat the nearest edge pixel. */
export function shiftImage(image: Rgba, dx: number, dy: number): Rgba {
  if (dx === 0 && dy === 0) return image;
  const out = Buffer.allocUnsafe(image.data.length);
  const clamp = (v: number, n: number): number => Math.min(n - 1, Math.max(0, v));
  for (let y = 0; y < image.height; y++) {
    const srcRow = clamp(y - dy, image.height) * image.width;
    for (let x = 0; x < image.width; x++) {
      const from = (srcRow + clamp(x - dx, image.width)) * CHANNELS;
      image.data.copy(out, (y * image.width + x) * CHANNELS, from, from + CHANNELS);
    }
  }
  return { data: out, width: image.width, height: image.height };
}

export interface AlignedTile {
  index: number;
  /** The tile cut to its `crop` rect, with any trusted small shift removed. */
  image: Rgba;
  /** The shift detected: removed from `image` unless the tile is flagged or the estimate is not confident. */
  shift: { dx: number; dy: number };
  score: number;
  /** The correlation peak was strong enough to trust. */
  confident: boolean;
  /** Needs review: shifted by more than `maxShiftPx`, or it matches nothing in the source. Left uncorrected. */
  flagged: boolean;
  /** The provider output had a different shape and was centre-cropped to fit. */
  croppedToAspect: boolean;
}

export interface AlignResult {
  tiles: AlignedTile[];
  /** Indexes of tiles that need review. Never dropped from `tiles`. */
  flagged: number[];
}

export interface AlignInput {
  plan: TilePlan;
  /** The original image, used as the alignment reference. */
  source: Rgba;
  outputs: ReadonlyArray<{ index: number; path: string }>;
  maxShiftPx?: number;
}

/**
 * Normalizes every provider output to its tile geometry and aligns it to the source. A tile
 * shifted by up to `maxShiftPx` is corrected; a tile that is shifted more, or matches nothing in
 * the source, is flagged and left as is.
 */
export async function alignTiles({ plan, source, outputs, maxShiftPx = DEFAULT_MAX_SHIFT_PX }: AlignInput): Promise<AlignResult> {
  const tiles: AlignedTile[] = [];

  for (const tile of plan.tiles) {
    const output = outputs.find((o) => o.index === tile.index);
    if (!output) throw new Error(`Missing output for tile ${tile.index}`);

    const { image: normalized, croppedToAspect } = await normalizeTile(await loadRgba(output.path), tile.send);
    const reference: Rgba = { data: extractRegion(source, tile.crop, plan.wrap), width: tile.crop.width, height: tile.crop.height };
    const estimate = estimateShift(reference, cropToCrop(normalized, tile), maxShiftPx);

    const flagged = needsReview(estimate);
    // Correct on the full send-size image, so real padding pixels move into the crop with the content.
    const trusted = estimate.confident && !flagged;
    const corrected = trusted ? shiftImage(normalized, -estimate.dx, -estimate.dy) : normalized;

    tiles.push({
      index: tile.index,
      image: cropToCrop(corrected, tile),
      shift: { dx: estimate.dx, dy: estimate.dy },
      score: estimate.score,
      confident: estimate.confident,
      flagged,
      croppedToAspect,
    });
  }

  return { tiles, flagged: tiles.filter((t) => t.flagged).map((t) => t.index) };
}
