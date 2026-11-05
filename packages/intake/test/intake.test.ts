import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ImageAsset } from '@ie/contracts';
import { getCategory } from '@ie/presets';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createJob, detectFormat, importImage, IntakeError, MAX_BYTES, MAX_DIMENSION, orientedSize } from '../src';
import type { IntakeErrorCode, JobConfig } from '../src';

let dir: string;
const file = (name: string): string => path.join(dir, name);

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } });

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ie-intake-'));

  writeFileSync(file('photo.png'), await solid(120, 60).png().toBuffer());
  writeFileSync(file('photo.jpg'), await solid(120, 60).jpeg().toBuffer());
  writeFileSync(file('photo.webp'), await solid(120, 60).webp().toBuffer());
  writeFileSync(file('rotated.jpg'), await solid(120, 60).jpeg().withMetadata({ orientation: 6 }).toBuffer());
  writeFileSync(file('wide.png'), await solid(MAX_DIMENSION + 1, 1).png().toBuffer());
  writeFileSync(file('max.png'), await solid(MAX_DIMENSION, 1).png().toBuffer());

  // Content decides the format, not the extension.
  writeFileSync(file('png-named-jpg.jpg'), readFileSync(file('photo.png')));
  writeFileSync(file('gif-named-png.png'), Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40)]));

  writeFileSync(file('anim.gif'), Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40)]));
  writeFileSync(file('logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
  writeFileSync(file('xml.svg'), '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  writeFileSync(file('notes.txt'), 'hello');
  writeFileSync(
    file('garbage.png'),
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]),
  );

  // A noisy image so a truncated copy loses real pixel data.
  const noise = await sharp(Buffer.alloc(300 * 300 * 3).map(() => Math.floor(Math.random() * 256)), {
    raw: { width: 300, height: 300, channels: 3 },
  })
    .jpeg({ quality: 95 })
    .toBuffer();
  writeFileSync(file('truncated.jpg'), noise.subarray(0, Math.floor(noise.length / 2)));

  mkdirSync(file('a-folder'));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function codeOf(promise: Promise<unknown>): Promise<IntakeErrorCode | 'no-error'> {
  try {
    await promise;
    return 'no-error';
  } catch (error) {
    if (error instanceof IntakeError) return error.code;
    throw error;
  }
}

describe('limits', () => {
  it('match the spec', () => {
    expect(MAX_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_DIMENSION).toBe(8192);
  });
});

describe('detectFormat / orientedSize', () => {
  it('detects formats from bytes', () => {
    expect(detectFormat(readFileSync(file('photo.png')))).toBe('png');
    expect(detectFormat(readFileSync(file('photo.jpg')))).toBe('jpeg');
    expect(detectFormat(readFileSync(file('photo.webp')))).toBe('webp');
    expect(detectFormat(readFileSync(file('anim.gif')))).toBe('gif');
    expect(detectFormat(readFileSync(file('logo.svg')))).toBe('svg');
    expect(detectFormat(readFileSync(file('xml.svg')))).toBe('svg');
    expect(detectFormat(Buffer.from('plain text'))).toBe('unknown');
    expect(detectFormat(Buffer.alloc(0))).toBe('unknown');
  });

  it('swaps width and height for orientations 5-8 only', () => {
    for (const o of [5, 6, 7, 8]) expect(orientedSize(120, 60, o)).toEqual({ width: 60, height: 120 });
    for (const o of [undefined, 1, 2, 3, 4]) expect(orientedSize(120, 60, o)).toEqual({ width: 120, height: 60 });
  });
});

describe('importImage', () => {
  it.each(['photo.png', 'photo.jpg', 'photo.webp'])('accepts %s', async (name) => {
    const asset = await importImage(file(name));
    expect(asset).toMatchObject({ width: 120, height: 60, path: file(name) });
    expect(asset.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('records the SHA-256 of the original bytes and leaves the file untouched', async () => {
    const target = file('photo.png');
    const before = { bytes: readFileSync(target), mtime: statSync(target).mtimeMs };

    const asset = await importImage(target);

    expect(asset.sha256).toBe(createHash('sha256').update(before.bytes).digest('hex'));
    expect(readFileSync(target).equals(before.bytes)).toBe(true);
    expect(statSync(target).mtimeMs).toBe(before.mtime);
  });

  it('applies EXIF orientation to the reported size', async () => {
    const asset = await importImage(file('rotated.jpg'));
    expect({ width: asset.width, height: asset.height }).toEqual({ width: 60, height: 120 });
  });

  it('returns a frozen asset without needing a category or prompt', async () => {
    const asset = await importImage(file('photo.png'));
    expect(Object.isFrozen(asset)).toBe(true);
    expect(Object.keys(asset).sort()).toEqual(['height', 'id', 'path', 'sha256', 'width']);
  });

  it('trusts content over extension', async () => {
    expect(await codeOf(importImage(file('png-named-jpg.jpg')))).toBe('no-error');
    expect(await codeOf(importImage(file('gif-named-png.png')))).toBe('unsupported-gif');
  });

  it('rejects each bad input with its own error code', async () => {
    expect(await codeOf(importImage(file('anim.gif')))).toBe('unsupported-gif');
    expect(await codeOf(importImage(file('logo.svg')))).toBe('unsupported-svg');
    expect(await codeOf(importImage(file('xml.svg')))).toBe('unsupported-svg');
    expect(await codeOf(importImage(file('notes.txt')))).toBe('unsupported-format');
    expect(await codeOf(importImage(file('garbage.png')))).toBe('corrupt-image');
    expect(await codeOf(importImage(file('truncated.jpg')))).toBe('corrupt-image');
    expect(await codeOf(importImage(file('missing.png')))).toBe('file-not-found');
    expect(await codeOf(importImage(file('a-folder')))).toBe('not-a-file');
  });

  it('enforces the byte limit before reading the file', async () => {
    expect(await codeOf(importImage(file('photo.png'), { limits: { maxBytes: 100 } }))).toBe('file-too-large');
  });

  it('enforces the per-side dimension limit, inclusive at 8192', async () => {
    expect(await codeOf(importImage(file('wide.png')))).toBe('dimensions-exceeded');
    expect(await importImage(file('max.png'))).toMatchObject({ width: MAX_DIMENSION, height: 1 });
  });

  it('measures the dimension limit after orientation', async () => {
    expect(await codeOf(importImage(file('rotated.jpg'), { limits: { maxDimension: 100 } }))).toBe(
      'dimensions-exceeded',
    );
  });

  it('uses an injected id generator', async () => {
    const asset = await importImage(file('photo.png'), { newId: () => 'ASSET1' });
    expect(asset.id).toBe('ASSET1');
  });

  it('error messages are specific', async () => {
    await expect(importImage(file('anim.gif'))).rejects.toThrow(/GIF/);
    await expect(importImage(file('logo.svg'))).rejects.toThrow(/SVG/);
  });
});

describe('createJob', () => {
  const asset: ImageAsset = Object.freeze({
    id: '01ASSET',
    path: 'C:/images/a.png',
    width: 4000,
    height: 3000,
    sha256: 'a'.repeat(64),
  });
  const base: JobConfig = {
    prompt: 'make it dusk',
    categoryId: 'env-realistic',
    grid: { rows: 2, cols: 3, overlapPct: 15 },
    providerId: 'gpt',
  };
  const code = (config: Partial<JobConfig>): string | undefined => {
    try {
      createJob(asset, { ...base, ...config });
    } catch (error) {
      return error instanceof IntakeError ? error.code : 'other';
    }
    return undefined;
  };

  it('stores an edited prompt with promptSource "user"', () => {
    const job = createJob(asset, base);
    expect(job).toMatchObject({
      prompt: 'make it dusk',
      promptSource: 'user',
      categoryId: 'env-realistic',
      categorySource: 'user',
      providerId: 'gpt',
      grid: { rows: 2, cols: 3, overlapPct: 15 },
      source: { path: asset.path, width: 4000, height: 3000, sha256: asset.sha256 },
    });
    expect(job.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it.each(['', '   ', '\n\t '])('resolves blank prompt %j to the category default', (prompt) => {
    const job = createJob(asset, { ...base, prompt });
    expect(job.prompt).toBe(getCategory('env-realistic')!.defaultPrompt);
    expect(job.promptSource).toBe('category-default');
  });

  it('keeps the user prompt verbatim, including surrounding spaces', () => {
    expect(createJob(asset, { ...base, prompt: '  keep spaces  ' }).prompt).toBe('  keep spaces  ');
  });

  it('accepts a 2000-character prompt and rejects 2001', () => {
    expect(code({ prompt: 'x'.repeat(2000) })).toBeUndefined();
    expect(code({ prompt: 'x'.repeat(2001) })).toBe('invalid-prompt');
  });

  it('requires a category that exists in the catalog', () => {
    expect(code({ categoryId: 'does-not-exist' })).toBe('unknown-category');
    expect(code({ categoryId: 'auto' })).toBe('unknown-category');
    expect(code({ categoryId: 'custom' })).toBeUndefined();
  });

  it('accepts the 6 (3x2), 8 (4x2) and custom grids; rejects out-of-range ones', () => {
    expect(code({ grid: { rows: 3, cols: 2, overlapPct: 15 } })).toBeUndefined();
    expect(code({ grid: { rows: 4, cols: 2, overlapPct: 15 } })).toBeUndefined();
    expect(code({ grid: { rows: 6, cols: 6, overlapPct: 40 } })).toBeUndefined();
    expect(code({ grid: { rows: 1, cols: 1, overlapPct: 0 } })).toBeUndefined();
    for (const grid of [
      { rows: 7, cols: 2, overlapPct: 10 },
      { rows: 2, cols: 7, overlapPct: 10 },
      { rows: 0, cols: 2, overlapPct: 10 },
      { rows: 2.5, cols: 2, overlapPct: 10 },
      { rows: 2, cols: 2, overlapPct: 41 },
      { rows: 2, cols: 2, overlapPct: -1 },
    ]) {
      expect(code({ grid })).toBe('invalid-grid');
    }
  });

  it('records auto-detect source and confidence, and ignores confidence otherwise', () => {
    const auto = createJob(asset, { ...base, categorySource: 'auto', categoryConfidence: 0.82 });
    expect(auto).toMatchObject({ categorySource: 'auto', categoryConfidence: 0.82 });

    const user = createJob(asset, { ...base, categoryConfidence: 0.82 });
    expect(user).not.toHaveProperty('categoryConfidence');

    expect(code({ categorySource: 'auto', categoryConfidence: 1.5 })).toBe('invalid-config');
  });

  it('rejects an unknown provider', () => {
    expect(code({ providerId: 'bing' as never })).toBe('invalid-config');
  });

  it('returns a deeply frozen job and supports injected id and clock', () => {
    const job = createJob(asset, base, { newId: () => 'JOB1', now: () => new Date('2026-11-05T12:00:00Z') });
    expect(job.id).toBe('JOB1');
    expect(job.createdAt).toBe('2026-11-05T12:00:00.000Z');
    expect(Object.isFrozen(job)).toBe(true);
    expect(Object.isFrozen(job.grid)).toBe(true);
    expect(Object.isFrozen(job.source)).toBe(true);
  });
});

describe('integration: import then create a job', () => {
  it('turns a real fixture into a Job that references the asset', async () => {
    const asset = await importImage(file('rotated.jpg'));
    const job = createJob(asset, {
      prompt: '',
      categoryId: 'photo-restore',
      grid: { rows: 2, cols: 3, overlapPct: 15 },
      providerId: 'gemini',
    });
    expect(job.source).toEqual({ path: asset.path, width: 60, height: 120, sha256: asset.sha256 });
    expect(job.promptSource).toBe('category-default');
    expect(job.prompt).toBe(getCategory('photo-restore')!.defaultPrompt);
  });
});
