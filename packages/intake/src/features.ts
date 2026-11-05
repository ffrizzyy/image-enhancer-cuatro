import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ImageFeaturesSchema, type ImageAsset, type ImageFeatures } from '@ie/contracts';
import sharp from 'sharp';

/** Long side of the analysis downscale. */
export const ANALYSIS_SIZE = 256;

const round = (x: number): number => Math.round(x * 1e6) / 1e6;

interface Pixels {
  w: number;
  h: number;
  /** Colour channels composited over white, and luma, one entry per pixel. */
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  y: Float32Array;
  /** Pixels that are not (nearly) fully opaque. */
  transparent: number;
}

/** EXIF-corrected downscale to at most {@link ANALYSIS_SIZE}px, never enlarging. */
async function loadPixels(filePath: string, kernel: 'lanczos3' | 'nearest'): Promise<Pixels> {
  const { data, info } = await sharp(filePath, { failOn: 'none' })
    .rotate()
    .resize(ANALYSIS_SIZE, ANALYSIS_SIZE, { fit: 'inside', withoutEnlargement: true, kernel })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const n = info.width * info.height;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  const y = new Float32Array(n);
  let transparent = 0;
  for (let i = 0; i < n; i++) {
    const a = (data[i * 4 + 3] ?? 255) / 255;
    if (a < 0.98) transparent++;
    r[i] = (data[i * 4] ?? 0) * a + 255 * (1 - a);
    g[i] = (data[i * 4 + 1] ?? 0) * a + 255 * (1 - a);
    b[i] = (data[i * 4 + 2] ?? 0) * a + 255 * (1 - a);
    y[i] = 0.299 * r[i]! + 0.587 * g[i]! + 0.114 * b[i]!;
  }
  return { w: info.width, h: info.height, r, g, b, y, transparent };
}

/**
 * Deterministic image statistics for auto-detect, measured on a {@link ANALYSIS_SIZE}px
 * EXIF-corrected downscale. Transparent pixels are composited over white for colour
 * statistics. Reads the file; never modifies it.
 *
 * Definitions:
 * - saturation: mean HSV saturation, 0..1
 * - colorfulness: Hasler-Süsstrunk metric
 * - edgeDensity: share of pixels with Sobel gradient magnitude above 96, 0..1
 * - highFrequencyEnergy: mean |Laplacian| of luma
 * - paletteSize: 4-bit-per-channel colour bins holding at least 0.1% of pixels
 * - blockiness: share of horizontal and vertical neighbour pairs with identical colour, 0..1
 *   (high for pixel art, vector art and flat backgrounds; near 0 for photographs)
 * - blurVariance: variance of the Laplacian of luma (low means soft)
 * - noiseEstimate: Immerkaer's fast noise standard deviation estimate on luma
 * - transparencyRatio: share of pixels that are not fully opaque, 0..1
 * - luminanceBimodality: share of pixels in the darkest and lightest quarter of the luma range, 0..1
 *   (high for line art on paper and high-contrast graphics; mid-tone photographs score low)
 *
 * paletteSize and blockiness are measured on a nearest-neighbour downscale, so the flat blocks
 * and exact palettes of upscaled pixel art survive; everything else uses a smooth (Lanczos) downscale.
 */
export async function extractFeatures(asset: Pick<ImageAsset, 'path' | 'width' | 'height'>): Promise<ImageFeatures> {
  const [smooth, blocky] = await Promise.all([loadPixels(asset.path, 'lanczos3'), loadPixels(asset.path, 'nearest')]);
  const { w, h, r, g, b, y } = smooth;
  const n = w * h;

  let satSum = 0;
  let rgSum = 0;
  let ybSum = 0;
  let lowMass = 0;
  let highMass = 0;
  for (let i = 0; i < n; i++) {
    const max = Math.max(r[i]!, g[i]!, b[i]!);
    satSum += max === 0 ? 0 : (max - Math.min(r[i]!, g[i]!, b[i]!)) / max;
    rgSum += r[i]! - g[i]!;
    ybSum += 0.5 * (r[i]! + g[i]!) - b[i]!;
    if (y[i]! < 64) lowMass++;
    else if (y[i]! >= 192) highMass++;
  }
  const rgMean = rgSum / n;
  const ybMean = ybSum / n;
  let rgVar = 0;
  let ybVar = 0;
  for (let i = 0; i < n; i++) {
    rgVar += (r[i]! - g[i]! - rgMean) ** 2;
    ybVar += (0.5 * (r[i]! + g[i]!) - b[i]! - ybMean) ** 2;
  }
  const colorfulness = Math.sqrt(rgVar / n + ybVar / n) + 0.3 * Math.sqrt(rgMean ** 2 + ybMean ** 2);

  // Gradient, Laplacian and noise statistics on luma (interior pixels only).
  let edges = 0;
  let lapAbsSum = 0;
  let lapSum = 0;
  let lapSqSum = 0;
  let noiseSum = 0;
  let interior = 0;
  for (let row = 1; row < h - 1; row++) {
    for (let col = 1; col < w - 1; col++) {
      const i = row * w + col;
      const tl = y[i - w - 1]!;
      const t = y[i - w]!;
      const tr = y[i - w + 1]!;
      const l = y[i - 1]!;
      const c = y[i]!;
      const rt = y[i + 1]!;
      const bl = y[i + w - 1]!;
      const bt = y[i + w]!;
      const br = y[i + w + 1]!;

      const gx = tr + 2 * rt + br - (tl + 2 * l + bl);
      const gy = bl + 2 * bt + br - (tl + 2 * t + tr);
      if (Math.sqrt(gx * gx + gy * gy) > 96) edges++;

      const lap = 4 * c - t - bt - l - rt;
      lapAbsSum += Math.abs(lap);
      lapSum += lap;
      lapSqSum += lap * lap;
      noiseSum += Math.abs(tl + tr + bl + br - 2 * (t + l + rt + bt) + 4 * c);
      interior++;
    }
  }
  const lapMean = interior > 0 ? lapSum / interior : 0;

  // Palette and flat-run share, on the nearest-neighbour downscale.
  const bins = new Uint32Array(4096);
  const bn = blocky.w * blocky.h;
  let identicalPairs = 0;
  let pairs = 0;
  for (let i = 0; i < bn; i++) {
    bins[((blocky.r[i]! >> 4) << 8) | ((blocky.g[i]! >> 4) << 4) | (blocky.b[i]! >> 4)]!++;
    if (i % blocky.w + 1 < blocky.w) {
      pairs++;
      if (blocky.r[i] === blocky.r[i + 1] && blocky.g[i] === blocky.g[i + 1] && blocky.b[i] === blocky.b[i + 1]) identicalPairs++;
    }
    if (i + blocky.w < bn) {
      pairs++;
      if (blocky.r[i] === blocky.r[i + blocky.w] && blocky.g[i] === blocky.g[i + blocky.w] && blocky.b[i] === blocky.b[i + blocky.w]) {
        identicalPairs++;
      }
    }
  }
  let paletteSize = 0;
  for (const count of bins) if (count >= bn * 0.001) paletteSize++;

  const features = {
    width: asset.width,
    height: asset.height,
    aspect: asset.width / asset.height,
    saturation: satSum / n,
    colorfulness,
    edgeDensity: interior > 0 ? edges / interior : 0,
    highFrequencyEnergy: interior > 0 ? lapAbsSum / interior : 0,
    paletteSize,
    blockiness: pairs > 0 ? identicalPairs / pairs : 1,
    blurVariance: interior > 0 ? lapSqSum / interior - lapMean ** 2 : 0,
    noiseEstimate: interior > 0 ? (Math.sqrt(Math.PI / 2) * noiseSum) / (6 * interior) : 0,
    transparencyRatio: smooth.transparent / n,
    luminanceBimodality: (lowMass + highMass) / n,
  };

  return ImageFeaturesSchema.parse(
    Object.fromEntries(
      Object.entries(features).map(([key, value]) => [key, Number.isInteger(value) ? value : round(value)]),
    ),
  );
}

export interface CachedFeatures {
  features: ImageFeatures;
  featuresPath: string;
  /** True when the cache was used and nothing was recomputed. */
  cached: boolean;
}

/**
 * Features for an asset, computed once and cached under `cacheDir` by the image's SHA-256,
 * so a changed image can never reuse stale features. A damaged cache entry is recomputed.
 */
export async function getFeatures(asset: ImageAsset, cacheDir: string): Promise<CachedFeatures> {
  const featuresPath = path.join(cacheDir, `${asset.sha256}.features.json`);

  try {
    const stored = ImageFeaturesSchema.safeParse(JSON.parse(readFileSync(featuresPath, 'utf8')));
    if (stored.success && stored.data.width === asset.width && stored.data.height === asset.height) {
      return { features: stored.data, featuresPath, cached: true };
    }
  } catch {
    // Missing or unreadable: fall through and recompute.
  }

  const features = await extractFeatures(asset);
  mkdirSync(cacheDir, { recursive: true });
  const temp = `${featuresPath}.tmp`;
  writeFileSync(temp, JSON.stringify(features));
  renameSync(temp, featuresPath);
  return { features, featuresPath, cached: false };
}
