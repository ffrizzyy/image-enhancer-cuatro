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

const [K0, K1, K2, K3, K4] = KERNEL as [number, number, number, number, number];

/**
 * Blur by the 5-tap kernel and drop every other row and column, computing only the pixels that are kept.
 * Edges are replicated.
 */
function reduce(p: Plane): Plane {
  const w = Math.ceil(p.w / 2);
  const h = Math.ceil(p.h / 2);

  // Horizontal pass, at the kept columns only.
  const tmp = new Float32Array(w * p.h);
  for (let y = 0; y < p.h; y++) {
    const row = y * p.w;
    const out = y * w;
    for (let xo = 0; xo < w; xo++) {
      const x = 2 * xo;
      if (x >= 2 && x + 2 < p.w) {
        tmp[out + xo] = K0 * p.data[row + x - 2]! + K1 * p.data[row + x - 1]! + K2 * p.data[row + x]! + K3 * p.data[row + x + 1]! + K4 * p.data[row + x + 2]!;
      } else {
        let s = 0;
        for (let k = 0; k < 5; k++) s += KERNEL[k]! * p.data[row + clampIndex(x + k - 2, p.w)]!;
        tmp[out + xo] = s;
      }
    }
  }

  // Vertical pass, at the kept rows only.
  const result = new Float32Array(w * h);
  for (let yo = 0; yo < h; yo++) {
    const y = 2 * yo;
    const r0 = clampIndex(y - 2, p.h) * w;
    const r1 = clampIndex(y - 1, p.h) * w;
    const r2 = clampIndex(y, p.h) * w;
    const r3 = clampIndex(y + 1, p.h) * w;
    const r4 = clampIndex(y + 2, p.h) * w;
    const out = yo * w;
    for (let x = 0; x < w; x++) result[out + x] = K0 * tmp[r0 + x]! + K1 * tmp[r1 + x]! + K2 * tmp[r2 + x]! + K3 * tmp[r3 + x]! + K4 * tmp[r4 + x]!;
  }
  return { data: result, w, h };
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
 * that exist, so the borders are interpolated rather than darkened. Only the non-zero taps are visited: of the
 * five, an even output position sees three source samples and an odd one sees two.
 */
function expand(p: Plane, w: number, h: number): Plane {
  const evenRows = Math.ceil(h / 2);
  const source = (xo: number, row: number): number => (xo >= 0 && xo < p.w ? p.data[row + xo]! : 0);

  // Horizontal pass, for the rows that hold source samples.
  const tmp = new Float32Array(evenRows * w);
  for (let yo = 0; yo < Math.min(p.h, evenRows); yo++) {
    const row = yo * p.w;
    const out = yo * w;
    for (let x = 0; x < w; x++) {
      if (x % 2 === 0) {
        const xo = x / 2;
        tmp[out + x] = K0 * (x - 2 >= 0 ? source(xo - 1, row) : 0) + K2 * source(xo, row) + K4 * (x + 2 < w ? source(xo + 1, row) : 0);
      } else {
        const xo = (x - 1) / 2;
        tmp[out + x] = K1 * source(xo, row) + K3 * (x + 1 < w ? source(xo + 1, row) : 0);
      }
    }
  }

  // Vertical pass. Row `r` of the zero-inserted image is zero unless it is even, so only those rows contribute.
  const wx = expandWeights(w, p.w);
  const wy = expandWeights(h, p.h);
  const out = new Float32Array(w * h);
  const rowOf = (r: number): number => (r >= 0 && r < h ? (r / 2) * w : -1);
  for (let y = 0; y < h; y++) {
    const a = y % 2 === 0 ? rowOf(y - 2) : rowOf(y - 1);
    const b = y % 2 === 0 ? rowOf(y) : rowOf(y + 1);
    const c = y % 2 === 0 ? rowOf(y + 2) : -1;
    const ka = y % 2 === 0 ? K0 : K1;
    const kb = y % 2 === 0 ? K2 : K3;
    const kc = K4;
    const base = y * w;
    for (let x = 0; x < w; x++) {
      const s = (a >= 0 ? ka * tmp[a + x]! : 0) + (b >= 0 ? kb * tmp[b + x]! : 0) + (c >= 0 ? kc * tmp[c + x]! : 0);
      out[base + x] = wx[x]! * wy[y]! > 0 ? s / (wx[x]! * wy[y]!) : 0;
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

/** Block size of the cache-friendly transpose, in pixels. */
const TRANSPOSE_BLOCK = 32;

/** Swaps rows and columns, so a vertical blend can reuse the horizontal one. */
export function transpose(placed: Placed): Placed {
  const { image } = placed;
  const { width, height } = image;
  const out = Buffer.allocUnsafe(image.data.length);

  // A pixel is four bytes, so move it as one 32-bit word, in blocks that fit the cache.
  const aligned = image.data.byteOffset % 4 === 0 && out.byteOffset % 4 === 0;
  if (aligned) {
    const src = new Uint32Array(image.data.buffer, image.data.byteOffset, width * height);
    const dst = new Uint32Array(out.buffer, out.byteOffset, width * height);
    for (let by = 0; by < height; by += TRANSPOSE_BLOCK) {
      const yEnd = Math.min(height, by + TRANSPOSE_BLOCK);
      for (let bx = 0; bx < width; bx += TRANSPOSE_BLOCK) {
        const xEnd = Math.min(width, bx + TRANSPOSE_BLOCK);
        for (let y = by; y < yEnd; y++) for (let x = bx; x < xEnd; x++) dst[x * height + y] = src[y * width + x]!;
      }
    }
  } else {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const from = (y * width + x) * CHANNELS;
        image.data.copy(out, (x * height + y) * CHANNELS, from, from + CHANNELS);
      }
    }
  }
  return { image: { data: out, width: height, height: width }, x: placed.y, y: placed.x };
}
