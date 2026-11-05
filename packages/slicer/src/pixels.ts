import type { Rect } from '@ie/contracts';
import sharp from 'sharp';

/** 8-bit RGBA pixels, row-major, 4 bytes per pixel. */
export interface Rgba {
  data: Buffer;
  width: number;
  height: number;
}

export const CHANNELS = 4;

/** Decodes an image to RGBA with EXIF orientation applied, so its size matches an `ImageAsset`. */
export async function loadRgba(filePath: string): Promise<Rgba> {
  const { data, info } = await sharp(filePath, { failOn: 'none' })
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const mod = (i: number, n: number): number => ((i % n) + n) % n;

/**
 * Maps any integer coordinate onto `0..n-1`. Inside the image it is the identity. Outside, `wrap`
 * reads from the opposite edge; otherwise the image is mirrored at its border (the edge pixel is
 * repeated: -1 -> 0, -2 -> 1, n -> n-1), however far out the coordinate is.
 */
export function mapIndex(i: number, n: number, wrap: boolean): number {
  if (i >= 0 && i < n) return i;
  if (wrap) return mod(i, n);
  const m = mod(i, 2 * n);
  return m < n ? m : 2 * n - 1 - m;
}

/**
 * Copies `rect` out of the image without resampling. Pixels outside the image come from
 * {@link mapIndex}. Returns a fresh RGBA buffer of `rect.width x rect.height`.
 */
export function extractRegion(src: Rgba, rect: Rect, wrap: boolean): Buffer {
  const out = Buffer.allocUnsafe(rect.width * rect.height * CHANNELS);
  const rowBytes = rect.width * CHANNELS;
  const inside = rect.x >= 0 && rect.x + rect.width <= src.width;

  const columns = new Int32Array(rect.width);
  if (!inside) for (let i = 0; i < rect.width; i++) columns[i] = mapIndex(rect.x + i, src.width, wrap);

  for (let j = 0; j < rect.height; j++) {
    const srcRow = mapIndex(rect.y + j, src.height, wrap) * src.width * CHANNELS;
    const outRow = j * rowBytes;
    if (inside) {
      src.data.copy(out, outRow, srcRow + rect.x * CHANNELS, srcRow + (rect.x + rect.width) * CHANNELS);
    } else {
      for (let i = 0; i < rect.width; i++) {
        const from = srcRow + columns[i]! * CHANNELS;
        src.data.copy(out, outRow + i * CHANNELS, from, from + CHANNELS);
      }
    }
  }
  return out;
}

/** Number of differing pixels between two same-size RGBA buffers; throws if the sizes differ. */
export function countDifferentPixels(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) throw new Error(`Buffers differ in size: ${a.length} vs ${b.length}`);
  let different = 0;
  for (let i = 0; i < a.length; i += CHANNELS) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) different++;
  }
  return different;
}
