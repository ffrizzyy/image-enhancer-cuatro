import type { Rect, TilePlan } from '@ie/contracts';
import type { Rgba } from '@ie/slicer';

import { findOverlaps } from './colorMatch';

const CHANNELS = 4;

/**
 * Kinks smaller than this (a 2 grey-level step, squared) are below what can be seen, and keep a perfectly smooth
 * region from turning a rounding-sized step into a large ratio.
 */
const STEP_FLOOR = 4;

/** How far from a position its neighbours are taken as the local baseline: not the adjacent ones, which a seam also touches. */
const NEAR = 3;
const FAR = 12;

/** A seam may wander a few pixels along an overlap, so a kink is also measured over this many positions. */
const STEP_WIDTHS = [1, 3] as const;

/** The widest shift alignment corrects (`DEFAULT_MAX_SHIFT_PX`): the border strip that can hold shift fill instead of content. */
const BORDER = 8;

/** Segments of at least this many rows or columns, so a seam that exists only along part of an overlap still shows. */
const SEGMENT_LENGTH = 1024;
const MAX_SEGMENTS = 2;

/** Rows or columns beyond this many per segment are sampled on a stride, which keeps the metric fast on huge images. */
const MAX_SAMPLES_PER_POSITION = 2048;

export interface SeamReport {
  /**
   * How much the biggest abrupt step across any overlap exceeds the steps around it (1 = it does not). A seam is a
   * line of abrupt change running along an overlap; a texture, noise or the content itself is not, because they are
   * averaged out along the overlap. The worst overlap counts.
   */
  seamScore: number;
  perOverlap: Array<{ a: number; b: number; score: number }>;
}

type Lum = (x: number, y: number) => number;

/** Luminance (0..255) with the image treated as seamless for wrap plans and edge-clamped otherwise. */
function luminance(image: Rgba, wrap: boolean): Lum {
  const { data, width, height } = image;
  return (x, y) => {
    const cx = wrap ? ((x % width) + width) % width : Math.min(width - 1, Math.max(0, x));
    const cy = wrap ? ((y % height) + height) % height : Math.min(height - 1, Math.max(0, y));
    const i = (cy * width + cx) * CHANNELS;
    return 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
  };
}

/**
 * For each position across the overlap (a column for the 'x' axis, a row for 'y'): the mean over `span` of the
 * stitched luminance, as a ratio to the reference luminance (or the luminance alone without a reference).
 */
function differenceProfile(lum: Lum, reference: Lum | null, axis: 'x' | 'y', positions: { from: number; to: number }, span: { from: number; to: number }): Float64Array {
  const stride = Math.max(1, Math.ceil((span.to - span.from) / MAX_SAMPLES_PER_POSITION));
  const own = new Float64Array(positions.to - positions.from);
  const expected = new Float64Array(positions.to - positions.from);
  for (let p = positions.from; p < positions.to; p++) {
    let sum = 0;
    let sumReference = 0;
    let count = 0;
    for (let s = span.from; s < span.to; s += stride) {
      sum += axis === 'x' ? lum(p, s) : lum(s, p);
      if (reference) sumReference += axis === 'x' ? reference(p, s) : reference(s, p);
      count++;
    }
    own[p - positions.from] = count === 0 ? 0 : sum / count;
    expected[p - positions.from] = count === 0 ? 0 : sumReference / count;
  }
  if (!reference) return own;

  // Compare as a ratio to the reference, scaled back to grey levels. A change of brightness or contrast (the usual
  // difference between an enhanced image and its source) then cancels, whatever the content is.
  const typical = Math.max(1, expected.reduce((a, b) => a + b, 0) / expected.length);
  return own.map((v, i) => (v / Math.max(1, expected[i]!)) * typical);
}

/**
 * For each band position, how much its kink (the second difference over `width`: zero on any straight ramp, large at a
 * jump) exceeds the kinks of its neighbours a little further out. Smooth slopes and gentle tone transitions have almost
 * none, so only an abrupt step stands out.
 */
function kinkRatios(profile: Float64Array, band: { from: number; to: number }, origin: number, width: number): Float64Array {
  const kink = (i: number): number | null => (i - width >= 0 && i + width < profile.length ? (profile[i + width]! - 2 * profile[i]! + profile[i - width]!) ** 2 : null);
  const out = new Float64Array(band.to - band.from).fill(1);
  for (let p = band.from; p < band.to; p++) {
    const at = p - origin;
    const own = kink(at);
    if (own === null) continue;
    let sum = 0;
    let count = 0;
    for (let d = NEAR; d <= FAR; d++) {
      for (const q of [at - d, at + d]) {
        const k = kink(q);
        if (k !== null) {
          sum += k;
          count++;
        }
      }
    }
    if (count > 0) out[p - band.from] = (own + STEP_FLOOR) / (sum / count + STEP_FLOOR);
  }
  return out;
}
/** The range [from, to) clipped to [0, limit) unless the image wraps. */
const clipRange = (from: number, to: number, limit: number, wrap: boolean): { from: number; to: number } =>
  wrap ? { from, to } : { from: Math.max(0, from), to: Math.min(limit, to) };

function scoreOverlap(lum: Lum, reference: Lum | null, rect: Rect, image: Rgba, wrap: boolean): number {
  // Only the strips between neighbouring tiles. A square corner is covered by the strips that contain it, and is
  // too small to tell a seam from noise.
  const axis: 'x' | 'y' | null = rect.width < rect.height * 0.5 ? 'x' : rect.height < rect.width * 0.5 ? 'y' : null;
  if (axis === null) return 1;

  const across = axis === 'x' ? { from: rect.x, to: rect.x + rect.width } : { from: rect.y, to: rect.y + rect.height };
  const along = axis === 'x' ? { from: rect.y, to: rect.y + rect.height } : { from: rect.x, to: rect.x + rect.width };
  const limit = axis === 'x' ? image.width : image.height;
  const alongLimit = axis === 'x' ? image.height : image.width;

  const band = clipRange(across.from, across.to, limit, wrap);
  const reach = clipRange(across.from - FAR - 3, across.to + FAR + 3, limit, wrap);
  // Near the image border, a tile that had to be shifted back has no real content to fill in (nothing lies beyond it).
  // That is lost data, not a seam, so the rows or columns within the alignment range of the border are not measured.
  const span = wrap ? { from: along.from, to: along.to } : { from: Math.max(BORDER, along.from), to: Math.min(alongLimit - BORDER, along.to) };
  if (band.to <= band.from || span.to <= span.from) return 1;

  const segments = Math.max(1, Math.min(MAX_SEGMENTS, Math.floor((span.to - span.from) / SEGMENT_LENGTH)));
  let worst = 1;
  for (let s = 0; s < segments; s++) {
    const part = {
      from: span.from + Math.floor(((span.to - span.from) * s) / segments),
      to: span.from + Math.floor(((span.to - span.from) * (s + 1)) / segments),
    };
    const profile = differenceProfile(lum, reference, axis, reach, part);
    for (const width of STEP_WIDTHS) for (const ratio of kinkRatios(profile, band, reach.from, width)) worst = Math.max(worst, ratio);
  }
  return worst;
}

/**
 * Seam score of a stitched image: the worst abrupt step across any overlap of the plan, relative to the steps around it.
 * Wrap plans measure across the image border as well.
 *
 * Pass the source as `reference` (same size) so that edges which belong to the content cancel out: without it, a
 * long straight edge of the content that runs along an overlap counts as a seam.
 */
export function seamScore(plan: TilePlan, image: Rgba, reference?: Rgba): SeamReport {
  const sameSize = reference && reference.width === image.width && reference.height === image.height;
  const lum = luminance(image, plan.wrap);
  const ref = sameSize ? luminance(reference, plan.wrap) : null;
  const perOverlap = findOverlaps(plan).map(({ a, b, rect }) => ({ a, b, score: scoreOverlap(lum, ref, rect, image, plan.wrap) }));
  return { seamScore: perOverlap.reduce((worst, o) => Math.max(worst, o.score), 1), perOverlap };
}
