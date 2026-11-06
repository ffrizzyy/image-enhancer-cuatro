import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { exportImage } from '../src/export';

let dir: string;
let source: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ie-export-'));
  source = path.join(dir, 'stitched.png');
  await sharp({ create: { width: 96, height: 64, channels: 4, background: { r: 30, g: 120, b: 200, alpha: 1 } } }).png().toFile(source);
});
afterAll(() => {
  // Windows can still hold a handle to a sharp-written file for a moment; a failed temp cleanup must not fail the suite.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* the OS will clean up the temporary folder */
  }
});

describe('exportImage', () => {
  it.each([
    ['png', 'png'],
    ['jpeg', 'jpeg'],
    ['webp', 'webp'],
  ] as const)('writes a %s file at the full size', async (format, expected) => {
    const destination = path.join(dir, `out.${format === 'jpeg' ? 'jpg' : format}`);
    const result = await exportImage({ imagePath: source, destination, format });

    expect(result).toEqual({ path: destination, width: 96, height: 64 });
    expect(existsSync(destination)).toBe(true);
    const meta = await sharp(destination).metadata();
    expect(meta.format).toBe(expected);
    expect([meta.width, meta.height]).toEqual([96, 64]);
  });

  it('flattens transparent pixels onto white for JPEG instead of turning them black', async () => {
    const transparent = path.join(dir, 'transparent.png');
    await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } }).png().toFile(transparent);

    const destination = path.join(dir, 'flattened.jpg');
    await exportImage({ imagePath: transparent, destination, format: 'jpeg' });
    const { data } = await sharp(destination).raw().toBuffer({ resolveWithObject: true });
    // The first pixel is white, not black.
    expect([...data.subarray(0, 3)]).toEqual([255, 255, 255]);
  });

  it('reports a source that is not a usable picture', async () => {
    await expect(exportImage({ imagePath: path.join(dir, 'missing.png'), destination: path.join(dir, 'x.png'), format: 'png' })).rejects.toThrow();
  });
});
