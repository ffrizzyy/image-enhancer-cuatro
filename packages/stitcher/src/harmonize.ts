import type { Rgba } from '@ie/slicer';

const CHANNELS = 4;

/** Cells along the longer side of the image: coarse enough to see only large-scale drift, never detail. */
export const DEFAULT_HARMONIZE_CELLS = 16;

/** A correction is never allowed to change a channel by more than this factor, in either direction. */
const MIN_GAIN = 0.8;
const MAX_GAIN = 1.25;

/** Drift below 1% is invisible; leaving the pixels alone keeps unchanged tiles bit-exact. */
const DEADBAND = 0.01;

export interface HarmonizeOptions {
  /** Treat the image as seamless: the correction field wraps around, so opposite edges stay in agreement. */
  wrap?: boolean;
  cells?: number;
}

export interface HarmonizeResult {
  image: Rgba;
  /** False when the drift was within the dead band and the input was returned untouched. */
  applied: boolean;
  /** The largest correction, as a deviation from a gain of 1 (0.05 = 5%). */
  maxGainDeviation: number;
}

/** Mean of each channel over a `cols` x `rows` grid of blocks. The image may be any size. */
function cellMeans(image: Rgba, cols: number, rows: number): Float64Array {
  const { data, width, height } = image;
  const means = new Float64Array(cols * rows * 3);
  for (let r = 0; r < rows; r++) {
    const y0 = Math.floor((r * height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * height) / rows));
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c * width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((c + 1) * width) / cols));
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let y = y0; y < y1; y++) {
        for (let i = (y * width + x0) * CHANNELS, end = (y * width + x1) * CHANNELS; i < end; i += CHANNELS) {
          sr += data[i]!;
          sg += data[i + 1]!;
          sb += data[i + 2]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const at = (r * cols + c) * 3;
      means[at] = sr / n;
      means[at + 1] = sg / n;
      means[at + 2] = sb / n;
    }
  }
  return means;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

/** One 3x3 box smoothing pass over the gain grid, so one odd cell cannot create a visible blotch. */
function smooth(gains: Float64Array, cols: number, rows: number, wrap: boolean): Float64Array {
  const out = new Float64Array(gains.length);
  const wrapIndex = (i: number, n: number): number => (wrap ? (i + n) % n : Math.min(n - 1, Math.max(0, i)));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) sum += gains[(wrapIndex(r + dr, rows) * cols + wrapIndex(c + dc, cols)) * 3 + ch]!;
        }
        out[(r * cols + c) * 3 + ch] = sum / 9;
      }
    }
  }
  return out;
}

/** For every pixel position along one axis: the two nearest cell centres and the weight of the second. */
function axisWeights(length: number, cells: number, wrap: boolean): { i0: Int32Array; i1: Int32Array; w: Float32Array } {
  const i0 = new Int32Array(length);
  const i1 = new Int32Array(length);
  const w = new Float32Array(length);
  const size = length / cells;
  for (let p = 0; p < length; p++) {
    const u = (p + 0.5) / size - 0.5; // position in cell-centre units
    const floor = Math.floor(u);
    w[p] = u - floor;
    if (wrap) {
      i0[p] = (floor + cells) % cells;
      i1[p] = (floor + 1 + cells) % cells;
    } else {
      i0[p] = Math.min(cells - 1, Math.max(0, floor));
      i1[p] = Math.min(cells - 1, Math.max(0, floor + 1));
    }
  }
  return { i0, i1, w };
}

/**
 * Corrects large-scale brightness and colour drift of `stitched` against a low-frequency `reference` (the
 * source, or a downscaled whole-image pass used only as a reference; it may be any size).
 *
 * Only the *variation* of the correction across the image is applied: the overall tone the provider chose is kept.
 * The correction is a smooth multiplicative field with a coarse grid, so it cannot add detail.
 */
export function harmonize(stitched: Rgba, reference: Rgba, options: HarmonizeOptions = {}): HarmonizeResult {
  const wrap = options.wrap ?? false;
  const longer = Math.max(stitched.width, stitched.height);
  const cells = Math.max(1, options.cells ?? DEFAULT_HARMONIZE_CELLS);
  const cols = Math.max(1, Math.round((cells * stitched.width) / longer));
  const rows = Math.max(1, Math.round((cells * stitched.height) / longer));

  const own = cellMeans(stitched, cols, rows);
  const target = cellMeans(reference, cols, rows);

  // Gain per cell and channel, relative to the typical gain over the whole image.
  const raw = new Float64Array(own.length);
  for (let i = 0; i < raw.length; i++) raw[i] = (target[i]! + 1) / (own[i]! + 1);
  const typical = [0, 1, 2].map((ch) => median(Array.from({ length: cols * rows }, (_, cell) => raw[cell * 3 + ch]!)));
  for (let i = 0; i < raw.length; i++) raw[i] = raw[i]! / typical[i % 3]!;
  const gains = smooth(raw, cols, rows, wrap);
  for (let i = 0; i < gains.length; i++) gains[i] = Math.min(MAX_GAIN, Math.max(MIN_GAIN, gains[i]!));

  let maxGainDeviation = 0;
  for (const g of gains) maxGainDeviation = Math.max(maxGainDeviation, Math.abs(g - 1));
  if (maxGainDeviation < DEADBAND) return { image: stitched, applied: false, maxGainDeviation };

  const { width, height, data } = stitched;
  const out = Buffer.from(data);
  const xs = axisWeights(width, cols, wrap);
  const ys = axisWeights(height, rows, wrap);
  const rowGain = new Float32Array(cols * 3);

  for (let y = 0; y < height; y++) {
    const top = ys.i0[y]! * cols * 3;
    const bottom = ys.i1[y]! * cols * 3;
    const wy = ys.w[y]!;
    for (let k = 0; k < cols * 3; k++) rowGain[k] = gains[top + k]! * (1 - wy) + gains[bottom + k]! * wy;

    for (let x = 0, i = y * width * CHANNELS; x < width; x++, i += CHANNELS) {
      const a = xs.i0[x]! * 3;
      const b = xs.i1[x]! * 3;
      const wx = xs.w[x]!;
      for (let ch = 0; ch < 3; ch++) {
        const v = out[i + ch]! * (rowGain[a + ch]! * (1 - wx) + rowGain[b + ch]! * wx) + 0.5;
        out[i + ch] = v >= 255 ? 255 : v;
      }
    }
  }
  return { image: { data: out, width, height }, applied: true, maxGainDeviation };
}
