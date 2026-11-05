import type { BlendMode } from '@ie/contracts';
import type { Rgba } from '@ie/slicer';

import { toLinear, toSrgb8 } from './color';
import { findSeam } from './seam';

const CHANNELS = 4;

/** An image positioned in the output's coordinate system. */
export interface Placed {
  image: Rgba;
  x: number;
  y: number;
}

export interface BlendStats {
  chunks: number;
  /** The largest number of pixels held in floating-point working buffers at once (per plane). */
  peakFloatPixels: number;
}

export interface BlendOptions {
  mode: BlendMode;
  /** Rows blended at a time; bounds the floating-point memory. */
  chunkRows?: number;
  stats?: BlendStats;
}

export const DEFAULT_CHUNK_ROWS = 1024;
/** Overlaps narrower than this are not worth blending: they are split down the middle. */
const MIN_BLEND_WIDTH = 4;
const MAX_LEVELS = 5;
const FEATHER_MAX_WIDTH = 32;

// ---------------------------------------------------------------------------------------------
// Gaussian / Laplacian pyramids on single-channel float planes
// ---------------------------------------------------------------------------------------------

interface Plane {
  data: Float32Array;
  w: number;
  h: number;
}

const KERNEL = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];
const clampIndex = (i: number, n: number): number => (i < 0 ? 0 : i >= n ? n - 1 : i);

/** Separable 5-tap blur with edge replication. */
function blur(p: Plane): Plane {
  const tmp = new Float32Array(p.w * p.h);
  for (let y = 0; y < p.h; y++) {
    const row = y * p.w;
    for (let x = 0; x < p.w; x++) {
      let s = 0;
      for (let k = 0; k < 5; k++) s += KERNEL[k]! * p.data[row + clampIndex(x + k - 2, p.w)]!;
      tmp[row + x] = s;
    }
  }
  const out = new Float32Array(p.w * p.h);
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      let s = 0;
      for (let k = 0; k < 5; k++) s += KERNEL[k]! * tmp[clampIndex(y + k - 2, p.h) * p.w + x]!;
      out[y * p.w + x] = s;
    }
  }
  return { data: out, w: p.w, h: p.h };
}

function reduce(p: Plane): Plane {
  const b = blur(p);
  const w = Math.ceil(p.w / 2);
  const h = Math.ceil(p.h / 2);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = b.data[2 * y * p.w + 2 * x]!;
  return { data: out, w, h };
}

/** 1-D weight, at each output position, of the source samples that actually exist (even positions inside the source). */
function expandWeights(n: number, sourceLength: number): Float32Array {
  const weights = new Float32Array(n);
  for (let x = 0; x < n; x++) {
    let s = 0;
    for (let k = 0; k < 5; k++) {
      const i = x + k - 2;
      if (i >= 0 && i < n && i % 2 === 0 && i / 2 < sourceLength) s += KERNEL[k]!;
    }
    weights[x] = s;
  }
  return weights;
}

/**
 * Upsamples by two to exactly `w` x `h`. Zero-inserts then smooths, dividing by the weight of the samples
 * that exist, so the borders are interpolated rather than darkened.
 */
function expand(p: Plane, w: number, h: number): Plane {
  const up = new Float32Array(w * h);
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) if (2 * x < w && 2 * y < h) up[2 * y * w + 2 * x] = p.data[y * p.w + x]!;

  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = 0; k < 5; k++) {
        const i = x + k - 2;
        if (i >= 0 && i < w) s += KERNEL[k]! * up[y * w + i]!;
      }
      tmp[y * w + x] = s;
    }
  }
  const wx = expandWeights(w, p.w);
  const wy = expandWeights(h, p.h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = 0; k < 5; k++) {
        const i = y + k - 2;
        if (i >= 0 && i < h) s += KERNEL[k]! * tmp[i * w + x]!;
      }
      out[y * w + x] = wx[x]! * wy[y]! > 0 ? s / (wx[x]! * wy[y]!) : 0;
    }
  }
  return { data: out, w, h };
}

function gaussianPyramid(p: Plane, levels: number): Plane[] {
  const pyramid = [p];
  for (let i = 0; i < levels; i++) pyramid.push(reduce(pyramid[i]!));
  return pyramid;
}

/** Band-pass levels 0..levels-1; the last Gaussian level is kept separately by the caller. */
function laplacianPyramid(gaussian: Plane[]): Plane[] {
  return gaussian.slice(0, -1).map((g, i) => {
    const up = expand(gaussian[i + 1]!, g.w, g.h);
    const data = new Float32Array(g.data.length);
    for (let j = 0; j < data.length; j++) data[j] = g.data[j]! - up.data[j]!;
    return { data, w: g.w, h: g.h };
  });
}

/** Burt-Adelson multiband blend of one channel: each frequency band is mixed with its own, progressively softer, mask. */
function multibandChannel(a: Plane, b: Plane, maskPyramid: Plane[], levels: number): Plane {
  const ga = gaussianPyramid(a, levels);
  const gb = gaussianPyramid(b, levels);
  const la = laplacianPyramid(ga);
  const lb = laplacianPyramid(gb);

  const mix = (x: Plane, y: Plane, m: Plane): Plane => {
    const data = new Float32Array(x.data.length);
    for (let i = 0; i < data.length; i++) data[i] = (1 - m.data[i]!) * x.data[i]! + m.data[i]! * y.data[i]!;
    return { data, w: x.w, h: x.h };
  };

  let result = mix(ga[levels]!, gb[levels]!, maskPyramid[levels]!);
  for (let level = levels - 1; level >= 0; level--) {
    const up = expand(result, la[level]!.w, la[level]!.h);
    const band = mix(la[level]!, lb[level]!, maskPyramid[level]!);
    const data = new Float32Array(up.data.length);
    for (let i = 0; i < data.length; i++) data[i] = up.data[i]! + band.data[i]!;
    result = { data, w: up.w, h: up.h };
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Pairwise blending
// ---------------------------------------------------------------------------------------------

function paste(canvas: Buffer, canvasWidth: number, placed: Placed, originX: number, originY: number): void {
  const { image } = placed;
  for (let row = 0; row < image.height; row++) {
    const from = row * image.width * CHANNELS;
    const to = ((placed.y - originY + row) * canvasWidth + (placed.x - originX)) * CHANNELS;
    image.data.copy(canvas, to, from, from + image.width * CHANNELS);
  }
}

const levelsFor = (overlapWidth: number): number => Math.min(MAX_LEVELS, Math.max(1, Math.floor(Math.log2(overlapWidth)) - 1));

/**
 * Blends two images whose overlap spans the full height of the shared region: `a` to the left of `b`.
 * Outside the overlap the pixels are copied untouched. Inside it, a minimum-error seam decides which image
 * each pixel mostly comes from, and the mix is done in linear light, either as a multiband (Laplacian
 * pyramid) blend or a narrow feather. The overlap is processed in row chunks to bound memory.
 */
export function blendPair(first: Placed, second: Placed, options: BlendOptions): Placed {
  const [left, right] = first.x <= second.x ? [first, second] : [second, first];
  const originX = Math.min(left.x, right.x);
  const originY = Math.min(left.y, right.y);
  const width = Math.max(left.x + left.image.width, right.x + right.image.width) - originX;
  const height = Math.max(left.y + left.image.height, right.y + right.image.height) - originY;

  const canvas = Buffer.alloc(width * height * CHANNELS);
  paste(canvas, width, left, originX, originY);
  paste(canvas, width, right, originX, originY);
  const result: Placed = { image: { data: canvas, width, height }, x: originX, y: originY };

  const ix0 = right.x;
  const ix1 = Math.min(left.x + left.image.width, right.x + right.image.width);
  const iy0 = Math.max(left.y, right.y);
  const iy1 = Math.min(left.y + left.image.height, right.y + right.image.height);
  const ow = ix1 - ix0;
  const oh = iy1 - iy0;
  if (ow <= 0 || oh <= 0) return result;

  const pixelOf = (p: Placed, x: number, y: number): number => ((y - p.y) * p.image.width + (x - p.x)) * CHANNELS;

  if (ow < MIN_BLEND_WIDTH) {
    // Too narrow to blend: left half from `left`, right half from `right`.
    for (let y = iy0; y < iy1; y++) {
      for (let x = ix0; x < ix0 + Math.floor(ow / 2); x++) {
        const from = pixelOf(left, x, y);
        left.image.data.copy(canvas, ((y - originY) * width + (x - originX)) * CHANNELS, from, from + CHANNELS);
      }
    }
    return result;
  }

  // Minimum-error seam through the overlap.
  const levels = options.mode === 'multiband' ? levelsFor(ow) : 0;
  const energy = new Float32Array(ow * oh);
  for (let y = iy0; y < iy1; y++) {
    for (let x = ix0; x < ix1; x++) {
      const pa = pixelOf(left, x, y);
      const pb = pixelOf(right, x, y);
      let e = 0;
      for (let c = 0; c < 3; c++) e += (left.image.data[pa + c]! - right.image.data[pb + c]!) ** 2;
      energy[(y - iy0) * ow + (x - ix0)] = e;
    }
  }
  const seam = findSeam(energy, ow, oh, Math.min(Math.floor(ow / 4), 2 ** levels));

  const write = (x: number, y: number, r: number, g: number, b: number): void => {
    const at = ((y - originY) * width + (x - originX)) * CHANNELS;
    canvas[at] = r;
    canvas[at + 1] = g;
    canvas[at + 2] = b;
    canvas[at + 3] = 255;
  };

  if (options.mode === 'feather') {
    const feather = Math.max(2, Math.min(FEATHER_MAX_WIDTH, Math.floor(ow / 3)));
    for (let y = iy0; y < iy1; y++) {
      for (let x = ix0; x < ix1; x++) {
        const alpha = Math.min(1, Math.max(0, (x - ix0 - seam[y - iy0]!) / feather + 0.5));
        const pa = pixelOf(left, x, y);
        const pb = pixelOf(right, x, y);
        const mixed = [0, 1, 2].map((c) =>
          toSrgb8((1 - alpha) * toLinear(left.image.data[pa + c]!) + alpha * toLinear(right.image.data[pb + c]!)),
        );
        write(x, y, mixed[0]!, mixed[1]!, mixed[2]!);
      }
    }
    return result;
  }

  // Multiband, in row chunks with enough extra rows around each that the chunk edges stay invisible.
  const chunkRows = options.chunkRows ?? DEFAULT_CHUNK_ROWS;
  const pad = 2 ** (levels + 1);
  const rowMargin = 4 * 2 ** levels;
  const padLeft = Math.min(pad, ix0 - left.x);
  const padRight = Math.min(pad, right.x + right.image.width - ix1);
  const ex0 = ix0 - padLeft;
  const ex1 = ix1 + padRight;
  const cw = ex1 - ex0;

  for (let r0 = iy0; r0 < iy1; r0 += chunkRows) {
    const r1 = Math.min(iy1, r0 + chunkRows);
    const er0 = Math.max(iy0, r0 - rowMargin);
    const er1 = Math.min(iy1, r1 + rowMargin);
    const ch = er1 - er0;

    // Where one image is missing (outside its own extent), borrow the other so the extra context is neutral.
    const planesA = [0, 1, 2].map(() => new Float32Array(cw * ch));
    const planesB = [0, 1, 2].map(() => new Float32Array(cw * ch));
    const mask = new Float32Array(cw * ch);
    for (let y = er0; y < er1; y++) {
      for (let x = ex0; x < ex1; x++) {
        const i = (y - er0) * cw + (x - ex0);
        const fromA = x < left.x + left.image.width ? pixelOf(left, x, y) : pixelOf(right, x, y);
        const dataA = x < left.x + left.image.width ? left.image.data : right.image.data;
        const fromB = x >= right.x ? pixelOf(right, x, y) : pixelOf(left, x, y);
        const dataB = x >= right.x ? right.image.data : left.image.data;
        for (let c = 0; c < 3; c++) {
          planesA[c]![i] = toLinear(dataA[fromA + c]!);
          planesB[c]![i] = toLinear(dataB[fromB + c]!);
        }
        mask[i] = x < ix0 ? 0 : x >= ix1 ? 1 : x - ix0 > seam[y - iy0]! ? 1 : 0;
      }
    }

    const chunkLevels = Math.max(1, Math.min(levels, Math.floor(Math.log2(Math.min(cw, ch)))));
    const maskPyramid = gaussianPyramid({ data: mask, w: cw, h: ch }, chunkLevels);
    const blended = [0, 1, 2].map((c) =>
      multibandChannel({ data: planesA[c]!, w: cw, h: ch }, { data: planesB[c]!, w: cw, h: ch }, maskPyramid, chunkLevels),
    );

    for (let y = r0; y < r1; y++) {
      for (let x = ix0; x < ix1; x++) {
        const i = (y - er0) * cw + (x - ex0);
        write(x, y, toSrgb8(blended[0]!.data[i]!), toSrgb8(blended[1]!.data[i]!), toSrgb8(blended[2]!.data[i]!));
      }
    }
    if (options.stats) {
      options.stats.chunks++;
      options.stats.peakFloatPixels = Math.max(options.stats.peakFloatPixels, cw * ch);
    }
  }
  return result;
}

/** Swaps rows and columns, so a vertical blend can reuse the horizontal one. */
export function transpose(placed: Placed): Placed {
  const { image } = placed;
  const out = Buffer.allocUnsafe(image.data.length);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const from = (y * image.width + x) * CHANNELS;
      image.data.copy(out, (x * image.height + y) * CHANNELS, from, from + CHANNELS);
    }
  }
  return { image: { data: out, width: image.height, height: image.width }, x: placed.y, y: placed.x };
}
