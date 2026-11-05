import { writeFileSync } from 'node:fs';

import type { Rgba } from '@ie/slicer';
import sharp from 'sharp';

import { labToRgb8, rgbToLab } from '../../src';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A textured, non-repeating test image: smooth value noise in three channels plus sharp-edged coloured
 * rectangles. It has structure at every scale, so a shift is unambiguous.
 */
export function structured(width: number, height: number, seed: number): Rgba {
  const rand = rng(seed);
  const cell = 20;
  const gw = Math.ceil(width / cell) + 2;
  const gh = Math.ceil(height / cell) + 2;
  const grids = [0, 1, 2].map(() => Float32Array.from({ length: gw * gh }, () => rand() * 255));

  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const gx = x / cell;
      const gy = y / cell;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const fx = gx - x0;
      const fy = gy - y0;
      for (let c = 0; c < 3; c++) {
        const g = grids[c]!;
        const top = g[y0 * gw + x0]! * (1 - fx) + g[y0 * gw + x0 + 1]! * fx;
        const bottom = g[(y0 + 1) * gw + x0]! * (1 - fx) + g[(y0 + 1) * gw + x0 + 1]! * fx;
        data[(y * width + x) * 4 + c] = top * (1 - fy) + bottom * fy;
      }
      data[(y * width + x) * 4 + 3] = 255;
    }
  }

  const rectangles = Math.round((width * height) / 4000);
  for (let r = 0; r < rectangles; r++) {
    const rw = 6 + Math.floor(rand() * 40);
    const rh = 6 + Math.floor(rand() * 40);
    const rx = Math.floor(rand() * Math.max(1, width - rw));
    const ry = Math.floor(rand() * Math.max(1, height - rh));
    const colour = [rand() * 255, rand() * 255, rand() * 255];
    for (let y = ry; y < Math.min(height, ry + rh); y++) {
      for (let x = rx; x < Math.min(width, rx + rw); x++) data.set(colour.map(Math.round), (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

export function flat(width: number, height: number, value = 128): Rgba {
  const data = Buffer.alloc(width * height * 4, value);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { data, width, height };
}

export async function writePng(image: Rgba, file: string): Promise<void> {
  writeFileSync(file, await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } }).png().toBuffer());
}

export async function blur(image: Rgba, sigma: number): Promise<Rgba> {
  const { data, info } = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } })
    .blur(sigma)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export async function resize(image: Rgba, width: number, height: number): Promise<Rgba> {
  const { data, info } = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } })
    .resize(width, height, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Simulates a provider changing brightness and contrast: out = in * gain + offset (clamped). */
export function adjust(image: Rgba, gain: number, offset: number): Rgba {
  const data = Buffer.from(image.data);
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) data[i + c] = Math.max(0, Math.min(255, Math.round(data[i + c]! * gain + offset)));
  }
  return { data, width: image.width, height: image.height };
}

export const pixel = (image: Rgba, x: number, y: number): number[] => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];

/** Mean absolute difference of the RGB channels over a region. */
export function meanAbsDiff(a: Rgba, b: Rgba, region: { x: number; y: number; width: number; height: number }): number {
  let sum = 0;
  for (let y = region.y; y < region.y + region.height; y++) {
    for (let x = region.x; x < region.x + region.width; x++) {
      for (let c = 0; c < 3; c++) sum += Math.abs(a.data[(y * a.width + x) * 4 + c]! - b.data[(y * b.width + x) * 4 + c]!);
    }
  }
  return sum / (region.width * region.height * 3);
}

export interface LabCast {
  dL?: number;
  da?: number;
  db?: number;
  /** Multiplies L about mid-grey, i.e. a contrast change. */
  gainL?: number;
}

/** Simulates a provider shifting a tile's colour: a cast applied in Lab. */
export function castLab(image: Rgba, cast: LabCast): Rgba {
  const data = Buffer.from(image.data);
  for (let i = 0; i < data.length; i += 4) {
    const [l, a, b] = rgbToLab(data[i]!, data[i + 1]!, data[i + 2]!);
    const [r, g, bl] = labToRgb8(((l - 50) * (cast.gainL ?? 1) + 50) + (cast.dL ?? 0), a + (cast.da ?? 0), b + (cast.db ?? 0));
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = bl;
  }
  return { data, width: image.width, height: image.height };
}

export function solid(width: number, height: number, rgb: readonly [number, number, number]): Rgba {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([rgb[0], rgb[1], rgb[2], 255], i);
  return { data, width, height };
}