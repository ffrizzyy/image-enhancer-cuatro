import type { Rect, TilePlan } from '@ie/contracts';
import type { Rgba } from '@ie/slicer';

import { labToRgb8, labToRgbFloat, rgbToLab, type Lab } from './color';

const CHANNELS = 4;
/** Overlaps smaller than this (pixels) carry too little information to match on. */
const MIN_OVERLAP_AREA = 256;
/** Each overlap is measured on at most this many sample pixels. */
const MAX_SAMPLES = 4096;
/** Below this standard deviation a Lab channel is flat and its gain cannot be estimated. */
const MIN_STD = 0.5;
const GAIN_RANGE: readonly [number, number] = [0.8, 1.25];
const OFFSET_LIMIT: Lab = [25, 30, 30];
/** How strongly each tile is pulled toward "no correction", relative to the overlap evidence. */
const REGULARIZATION = 0.05;
const IDENTITY_TOLERANCE = 1e-9;

export interface Overlap {
  a: number;
  b: number;
  /** Tile b is the same picture shifted by (ox, oy): b's pixel at (x - ox, y - oy) lies on a's pixel at (x, y). Non-zero only for wrap. */
  ox: number;
  oy: number;
  /** The shared region, in tile a's source coordinates. */
  rect: Rect;
}

/** Every pair of tile crops that share pixels, including pairs across the wrap-around edge. */
export function findOverlaps(plan: TilePlan): Overlap[] {
  const { width, height } = plan.source;
  const offsets: Array<[number, number]> = [[0, 0]];
  if (plan.wrap) {
    for (const oy of [-height, 0, height]) for (const ox of [-width, 0, width]) if (ox !== 0 || oy !== 0) offsets.push([ox, oy]);
  }

  const overlaps: Overlap[] = [];
  for (let i = 0; i < plan.tiles.length; i++) {
    for (let j = i + 1; j < plan.tiles.length; j++) {
      const A = plan.tiles[i]!.crop;
      const B = plan.tiles[j]!.crop;
      for (const [ox, oy] of offsets) {
        const x0 = Math.max(A.x, B.x + ox);
        const y0 = Math.max(A.y, B.y + oy);
        const x1 = Math.min(A.x + A.width, B.x + ox + B.width);
        const y1 = Math.min(A.y + A.height, B.y + oy + B.height);
        if (x1 - x0 >= 4 && y1 - y0 >= 4 && (x1 - x0) * (y1 - y0) >= MIN_OVERLAP_AREA) {
          overlaps.push({ a: i, b: j, ox, oy, rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
        }
      }
    }
  }
  return overlaps;
}

interface Samples {
  overlap: Overlap;
  count: number;
  /** Lab of tile a and tile b at each sample, 3 values per sample. */
  a: Float64Array;
  b: Float64Array;
}

function sampleOverlap(plan: TilePlan, images: ReadonlyMap<number, Rgba>, overlap: Overlap): Samples | null {
  const imageA = images.get(overlap.a);
  const imageB = images.get(overlap.b);
  if (!imageA || !imageB) return null;

  const cropA = plan.tiles[overlap.a]!.crop;
  const cropB = plan.tiles[overlap.b]!.crop;
  const { rect } = overlap;
  const stride = Math.max(1, Math.ceil(Math.sqrt((rect.width * rect.height) / MAX_SAMPLES)));
  const cols = Math.ceil(rect.width / stride);
  const rows = Math.ceil(rect.height / stride);

  const a = new Float64Array(cols * rows * 3);
  const b = new Float64Array(cols * rows * 3);
  let n = 0;
  for (let y = rect.y; y < rect.y + rect.height; y += stride) {
    for (let x = rect.x; x < rect.x + rect.width; x += stride) {
      const pa = ((y - cropA.y) * imageA.width + (x - cropA.x)) * CHANNELS;
      const pb = ((y - overlap.oy - cropB.y) * imageB.width + (x - overlap.ox - cropB.x)) * CHANNELS;
      a.set(rgbToLab(imageA.data[pa]!, imageA.data[pa + 1]!, imageA.data[pa + 2]!), n * 3);
      b.set(rgbToLab(imageB.data[pb]!, imageB.data[pb + 1]!, imageB.data[pb + 2]!), n * 3);
      n++;
    }
  }
  return { overlap, count: n, a, b };
}

export interface Correction {
  /** Per Lab channel: corrected = gain * value + offset. */
  gain: Lab;
  offset: Lab;
  identity: boolean;
}

const IDENTITY: Correction = { gain: [1, 1, 1], offset: [0, 0, 0], identity: true };

function channelStats(values: Float64Array, count: number, channel: number): { mean: number; std: number } {
  let sum = 0;
  for (let i = 0; i < count; i++) sum += values[i * 3 + channel]!;
  const mean = sum / count;
  let sq = 0;
  for (let i = 0; i < count; i++) sq += (values[i * 3 + channel]! - mean) ** 2;
  return { mean, std: Math.sqrt(sq / count) };
}

/** Solves the symmetric positive-definite system N x = rhs by Gaussian elimination with partial pivoting. */
function solve(N: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  const m = N.map((row, i) => [...row, rhs[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const d = m[col]![col]!;
    if (Math.abs(d) < 1e-12) continue;
    for (let r = col + 1; r < n; r++) {
      const factor = m[r]![col]! / d;
      for (let c = col; c <= n; c++) m[r]![c]! -= factor * m[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r]![n]!;
    for (let c = r + 1; c < n; c++) s -= m[r]![c]! * x[c]!;
    x[r] = Math.abs(m[r]![r]!) < 1e-12 ? 0 : s / m[r]![r]!;
  }
  return x;
}

/** Weighted least squares over differences `x_a - x_b = target`, with a weak pull of every x toward 0. */
function solveDifferences(n: number, equations: Array<{ a: number; b: number; target: number; weight: number }>): number[] {
  const N = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const rhs = new Array<number>(n).fill(0);
  let totalWeight = 0;
  for (const { a, b, target, weight } of equations) {
    const w2 = weight * weight;
    N[a]![a]! += w2;
    N[b]![b]! += w2;
    N[a]![b]! -= w2;
    N[b]![a]! -= w2;
    rhs[a]! += w2 * target;
    rhs[b]! -= w2 * target;
    totalWeight += w2;
  }
  const lambda = REGULARIZATION * Math.max(1, totalWeight / Math.max(1, equations.length));
  for (let i = 0; i < n; i++) N[i]![i]! += lambda;
  return solve(N, rhs);
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Per-tile Lab gain and offset, solved together over all overlaps so that every tile agrees with all of
 * its neighbours and the corrections cannot accumulate along a chain of tiles. A weak pull toward
 * "no correction" fixes the otherwise free overall level.
 */
function solveCorrections(tileCount: number, samples: readonly Samples[]): Correction[] {
  const stats = samples.map((s) => ({
    s,
    a: [0, 1, 2].map((c) => channelStats(s.a, s.count, c)),
    b: [0, 1, 2].map((c) => channelStats(s.b, s.count, c)),
  }));

  const solvedGain: number[][] = [];
  const solvedOffset: number[][] = [];
  for (let c = 0; c < 3; c++) {
    const gainEquations = stats
      .filter(({ a, b }) => a[c]!.std >= MIN_STD && b[c]!.std >= MIN_STD)
      .map(({ s, a, b }) => ({ a: s.overlap.a, b: s.overlap.b, target: Math.log(b[c]!.std / a[c]!.std), weight: Math.sqrt(s.count) }));
    const logGain = solveDifferences(tileCount, gainEquations);
    solvedGain.push(logGain.map((lg) => clamp(Math.exp(lg), GAIN_RANGE[0], GAIN_RANGE[1])));

    // a_gain * mean_a + offset_a = b_gain * mean_b + offset_b
    const offsetEquations = stats.map(({ s, a, b }) => ({
      a: s.overlap.a,
      b: s.overlap.b,
      target: solvedGain[c]![s.overlap.b]! * b[c]!.mean - solvedGain[c]![s.overlap.a]! * a[c]!.mean,
      weight: Math.sqrt(s.count),
    }));
    solvedOffset.push(solveDifferences(tileCount, offsetEquations).map((o) => clamp(o, -OFFSET_LIMIT[c]!, OFFSET_LIMIT[c]!)));
  }

  return Array.from({ length: tileCount }, (_, i) => {
    const gain: Lab = [solvedGain[0]![i]!, solvedGain[1]![i]!, solvedGain[2]![i]!];
    const offset: Lab = [solvedOffset[0]![i]!, solvedOffset[1]![i]!, solvedOffset[2]![i]!];
    const identity = gain.every((g) => Math.abs(g - 1) < IDENTITY_TOLERANCE) && offset.every((o) => Math.abs(o) < IDENTITY_TOLERANCE);
    return identity ? IDENTITY : { gain, offset, identity: false };
  });
}

export interface DeltaEReport {
  /** The largest per-overlap mean colour difference (CIE76) between the two tiles that share it. */
  maxDeltaE: number;
  perOverlap: Array<{ a: number; b: number; deltaE: number }>;
}

function report(samples: readonly Samples[], corrections: readonly Correction[]): DeltaEReport {
  const apply = (lab: Float64Array, i: number, c: Correction): Lab => [
    c.gain[0] * lab[i * 3]! + c.offset[0],
    c.gain[1] * lab[i * 3 + 1]! + c.offset[1],
    c.gain[2] * lab[i * 3 + 2]! + c.offset[2],
  ];
  const perOverlap = samples.map((s) => {
    let sum = 0;
    for (let i = 0; i < s.count; i++) {
      const p = apply(s.a, i, corrections[s.overlap.a]!);
      const q = apply(s.b, i, corrections[s.overlap.b]!);
      sum += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    }
    return { a: s.overlap.a, b: s.overlap.b, deltaE: sum / s.count };
  });
  return { maxDeltaE: perOverlap.reduce((m, o) => Math.max(m, o.deltaE), 0), perOverlap };
}

/** Images with at least this many pixels use the lookup table; smaller ones are corrected exactly, pixel by pixel. */
const LUT_MIN_PIXELS = 65_536;
/** Table nodes per channel: every 8th value from 0 to 248, then 255. */
const LUT_NODES = 33;
const NODE_VALUES = Array.from({ length: LUT_NODES }, (_, i) => (i < LUT_NODES - 1 ? i * 8 : 255));

/** For each 8-bit value: the table cell it falls in and how far across it (0..1). */
const LUT_CELL = new Uint8Array(256);
const LUT_FRACTION = new Float32Array(256);
for (let v = 0; v < 256; v++) {
  const cell = Math.min(LUT_NODES - 2, v >> 3);
  LUT_CELL[v] = cell;
  LUT_FRACTION[v] = (v - NODE_VALUES[cell]!) / (NODE_VALUES[cell + 1]! - NODE_VALUES[cell]!);
}

/**
 * The correction as a 33x33x33 table of how much each channel changes. The change is small and smooth, so
 * interpolating it is accurate to a small fraction of a level, where interpolating the colours themselves would not be.
 */
function deltaTable(correction: Correction): Float32Array {
  const { gain, offset } = correction;
  const table = new Float32Array(LUT_NODES ** 3 * 3);
  let at = 0;
  for (const r of NODE_VALUES) {
    for (const g of NODE_VALUES) {
      for (const b of NODE_VALUES) {
        const [l, a, bb] = rgbToLab(r, g, b);
        const [cr, cg, cb] = labToRgbFloat(gain[0] * l + offset[0], gain[1] * a + offset[1], gain[2] * bb + offset[2]);
        table[at++] = cr - r;
        table[at++] = cg - g;
        table[at++] = cb - b;
      }
    }
  }
  return table;
}

function applyWithTable(image: Rgba, correction: Correction): Rgba {
  const table = deltaTable(correction);
  const out = Buffer.from(image.data);
  const strideG = LUT_NODES * 3;
  const strideR = LUT_NODES * strideG;

  for (let i = 0; i < out.length; i += CHANNELS) {
    const r = out[i]!;
    const g = out[i + 1]!;
    const b = out[i + 2]!;
    const fr = LUT_FRACTION[r]!;
    const fg = LUT_FRACTION[g]!;
    const fb = LUT_FRACTION[b]!;
    const o = LUT_CELL[r]! * strideR + LUT_CELL[g]! * strideG + LUT_CELL[b]! * 3;

    const w000 = (1 - fr) * (1 - fg) * (1 - fb);
    const w001 = (1 - fr) * (1 - fg) * fb;
    const w010 = (1 - fr) * fg * (1 - fb);
    const w011 = (1 - fr) * fg * fb;
    const w100 = fr * (1 - fg) * (1 - fb);
    const w101 = fr * (1 - fg) * fb;
    const w110 = fr * fg * (1 - fb);
    const w111 = fr * fg * fb;

    for (let c = 0; c < 3; c++) {
      const delta =
        w000 * table[o + c]! +
        w001 * table[o + 3 + c]! +
        w010 * table[o + strideG + c]! +
        w011 * table[o + strideG + 3 + c]! +
        w100 * table[o + strideR + c]! +
        w101 * table[o + strideR + 3 + c]! +
        w110 * table[o + strideR + strideG + c]! +
        w111 * table[o + strideR + strideG + 3 + c]!;
      const v = out[i + c]! + delta + 0.5;
      out[i + c] = v <= 0 ? 0 : v >= 255 ? 255 : v;
    }
  }
  return { data: out, width: image.width, height: image.height };
}

/**
 * Applies a correction in Lab space. An identity correction returns the same image object. Large images go through
 * a lookup table (about four times faster); small ones are corrected exactly.
 */
export function applyCorrection(image: Rgba, correction: Correction): Rgba {
  if (correction.identity) return image;
  if (image.width * image.height >= LUT_MIN_PIXELS) return applyWithTable(image, correction);
  return applyExactly(image, correction);
}

/** The reference implementation: the exact Lab round trip for every pixel. */
export function applyExactly(image: Rgba, correction: Correction): Rgba {
  if (correction.identity) return image;
  const out = Buffer.from(image.data);
  const { gain, offset } = correction;
  for (let i = 0; i < out.length; i += CHANNELS) {
    const [l, a, b] = rgbToLab(out[i]!, out[i + 1]!, out[i + 2]!);
    const [r, g, bl] = labToRgb8(gain[0] * l + offset[0], gain[1] * a + offset[1], gain[2] * b + offset[2]);
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = bl;
  }
  return { data: out, width: image.width, height: image.height };
}
export interface MatchResult {
  /** The tile images with their corrections applied (untouched tiles are the same objects). */
  images: Map<number, Rgba>;
  corrections: Correction[];
  overlaps: number;
  before: DeltaEReport;
  after: DeltaEReport;
}

/**
 * Matches tile colours across the overlaps, in Lab, solved globally. Tiles listed in `exclude`
 * (for example tiles flagged for review) take no part: they are neither measured nor corrected.
 */
export function matchColors(plan: TilePlan, tileImages: ReadonlyMap<number, Rgba>, exclude: ReadonlySet<number> = new Set()): MatchResult {
  const usable = new Map([...tileImages].filter(([index]) => !exclude.has(index)));
  const samples = findOverlaps(plan)
    .map((overlap) => sampleOverlap(plan, usable, overlap))
    .filter((s): s is Samples => s !== null && s.count > 0);

  const identity = Array.from({ length: plan.tiles.length }, () => IDENTITY);
  const corrections = samples.length === 0 ? identity : solveCorrections(plan.tiles.length, samples);
  const before = report(samples, identity);
  const after = report(samples, corrections);

  const images = new Map<number, Rgba>();
  for (const [index, image] of tileImages) {
    images.set(index, exclude.has(index) ? image : applyCorrection(image, corrections[index] ?? IDENTITY));
  }
  return { images, corrections, overlaps: samples.length, before, after };
}
