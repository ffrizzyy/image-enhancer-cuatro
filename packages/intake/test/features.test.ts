import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ImageFeaturesSchema, type ImageAsset } from '@ie/contracts';
import sharp, { type Color } from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { extractFeatures, getFeatures, importImage } from '../src';

let dir: string;
const file = (name: string): string => path.join(dir, name);
const asset = async (name: string) => {
  const meta = await sharp(file(name)).metadata();
  return { path: file(name), width: meta.width!, height: meta.height! };
};

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ie-features-'));
  const solid = (w: number, h: number, background: Color) => sharp({ create: { width: w, height: h, channels: 3, background } });

  writeFileSync(file('white.png'), await solid(200, 100, '#ffffff').png().toBuffer());
  writeFileSync(file('grey.png'), await solid(200, 100, '#808080').png().toBuffer());
  writeFileSync(file('red.png'), await solid(200, 100, '#ff0000').png().toBuffer());
  writeFileSync(file('one.png'), await solid(1, 1, '#123456').png().toBuffer());
  writeFileSync(file('two.png'), await solid(2, 2, '#123456').png().toBuffer());
  writeFileSync(file('rotated.jpg'), await solid(120, 60, '#336699').jpeg().withMetadata({ orientation: 6 }).toBuffer());

  const checker = Buffer.alloc(100 * 100 * 3);
  for (let i = 0; i < 100 * 100; i++) checker.fill(Math.floor(i / 100 + (i % 100)) % 2 === 0 ? 0 : 255, i * 3, i * 3 + 3);
  writeFileSync(file('checker.png'), await sharp(checker, { raw: { width: 100, height: 100, channels: 3 } }).png().toBuffer());

  // 8px vertical stripes: strong horizontal gradients at every boundary.
  const stripes = Buffer.alloc(96 * 96 * 3);
  for (let i = 0; i < 96 * 96; i++) stripes.fill(Math.floor((i % 96) / 8) % 2 === 0 ? 20 : 235, i * 3, i * 3 + 3);
  writeFileSync(file('stripes.png'), await sharp(stripes, { raw: { width: 96, height: 96, channels: 3 } }).png().toBuffer());

  const half = Buffer.alloc(100 * 100 * 4, 255);
  for (let i = 0; i < 100 * 100; i++) if (i % 100 < 50) half[i * 4 + 3] = 0;
  writeFileSync(file('half.png'), await sharp(half, { raw: { width: 100, height: 100, channels: 4 } }).png().toBuffer());
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('extractFeatures', () => {
  it('returns schema-valid features with the asset dimensions', async () => {
    const features = await extractFeatures(await asset('grey.png'));
    expect(ImageFeaturesSchema.safeParse(features).success).toBe(true);
    expect(features).toMatchObject({ width: 200, height: 100, aspect: 2 });
  });

  it('is deterministic', async () => {
    const a = await extractFeatures(await asset('checker.png'));
    const b = await extractFeatures(await asset('checker.png'));
    expect(a).toEqual(b);
  });

  it('describes a plain white image as flat, colourless and edge-free', async () => {
    expect(await extractFeatures(await asset('white.png'))).toMatchObject({
      saturation: 0,
      colorfulness: 0,
      edgeDensity: 0,
      paletteSize: 1,
      blockiness: 1,
      transparencyRatio: 0,
      luminanceBimodality: 1,
      noiseEstimate: 0,
      blurVariance: 0,
    });
  });

  it('measures colour and brightness', async () => {
    const red = await extractFeatures(await asset('red.png'));
    expect(red.saturation).toBe(1);
    expect(red.colorfulness).toBeGreaterThan(50);

    const grey = await extractFeatures(await asset('grey.png'));
    expect(grey).toMatchObject({ saturation: 0, colorfulness: 0, luminanceBimodality: 0 });
  });

  it('finds edges at stripe boundaries', async () => {
    const f = await extractFeatures(await asset('stripes.png'));
    expect(f.edgeDensity).toBeGreaterThan(0.15);
    expect(f.edgeDensity).toBeLessThan(0.4);
    expect(f.blockiness).toBeGreaterThan(0.8);
  });

  it('finds noise, high-frequency energy and no flat runs in a 1px checkerboard', async () => {
    const f = await extractFeatures(await asset('checker.png'));
    expect(f.blockiness).toBe(0);
    expect(f.noiseEstimate).toBeGreaterThan(10);
    expect(f.highFrequencyEnergy).toBeGreaterThan(100);
    expect(f.luminanceBimodality).toBe(1);
  });

  it('measures transparency', async () => {
    expect((await extractFeatures(await asset('half.png'))).transparencyRatio).toBeCloseTo(0.5, 1);
    expect((await extractFeatures(await asset('white.png'))).transparencyRatio).toBe(0);
  });

  it('handles 1x1 and 2x2 images without dividing by zero', async () => {
    for (const name of ['one.png', 'two.png']) {
      const f = await extractFeatures(await asset(name));
      expect(ImageFeaturesSchema.safeParse(f).success, name).toBe(true);
      expect(f.edgeDensity).toBe(0);
      expect(f.blurVariance).toBe(0);
    }
  });

  it('applies EXIF orientation when sampling', async () => {
    const imported = await importImage(file('rotated.jpg'));
    const f = await extractFeatures(imported);
    expect(f).toMatchObject({ width: 60, height: 120, aspect: 0.5 });
  });

  it('never modifies the source file', async () => {
    const before = { bytes: readFileSync(file('checker.png')), mtime: statSync(file('checker.png')).mtimeMs };
    await extractFeatures(await asset('checker.png'));
    expect(readFileSync(file('checker.png')).equals(before.bytes)).toBe(true);
    expect(statSync(file('checker.png')).mtimeMs).toBe(before.mtime);
  });

  it('analyses a large JPEG quickly (sanity bound, not the 50 MB target)', async () => {
    const big = file('big.jpg');
    writeFileSync(big, await sharp({ create: { width: 6000, height: 4000, channels: 3, background: '#6a8caf' } }).jpeg().toBuffer());
    const started = performance.now();
    await extractFeatures({ path: big, width: 6000, height: 4000 });
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe('getFeatures cache', () => {
  const imported = async (name: string): Promise<ImageAsset> => importImage(file(name));

  it('computes once, writes the cache by SHA-256, then reuses it', async () => {
    const cacheDir = path.join(dir, 'cache1');
    const a = await imported('grey.png');

    const first = await getFeatures(a, cacheDir);
    expect(first.cached).toBe(false);
    expect(first.featuresPath).toBe(path.join(cacheDir, `${a.sha256}.features.json`));
    expect(JSON.parse(readFileSync(first.featuresPath, 'utf8'))).toEqual(first.features);

    const mtime = statSync(first.featuresPath).mtimeMs;
    const second = await getFeatures(a, cacheDir);
    expect(second.cached).toBe(true);
    expect(second.features).toEqual(first.features);
    expect(statSync(first.featuresPath).mtimeMs).toBe(mtime);
  });

  it('does not reuse features when the image changes', async () => {
    const cacheDir = path.join(dir, 'cache2');
    const grey = await getFeatures(await imported('grey.png'), cacheDir);
    const red = await getFeatures(await imported('red.png'), cacheDir);
    expect(red.cached).toBe(false);
    expect(red.featuresPath).not.toBe(grey.featuresPath);
    expect(red.features.saturation).toBe(1);
  });

  it('recomputes a damaged or mismatched cache entry', async () => {
    const cacheDir = path.join(dir, 'cache3');
    const a = await imported('grey.png');
    const { featuresPath } = await getFeatures(a, cacheDir);

    writeFileSync(featuresPath, '{ not json');
    expect((await getFeatures(a, cacheDir)).cached).toBe(false);

    writeFileSync(featuresPath, JSON.stringify({ ...JSON.parse(readFileSync(featuresPath, 'utf8')), width: 999 }));
    expect((await getFeatures(a, cacheDir)).cached).toBe(false);
    expect((await getFeatures(a, cacheDir)).cached).toBe(true);
  });

  it('keys the cache by content hash', async () => {
    const a = await imported('grey.png');
    const { featuresPath } = await getFeatures(a, path.join(dir, 'cache4'));
    const expectedName = `${createHash('sha256').update(readFileSync(file('grey.png'))).digest('hex')}.features.json`;
    expect(path.basename(featuresPath)).toBe(expectedName);
  });
});
