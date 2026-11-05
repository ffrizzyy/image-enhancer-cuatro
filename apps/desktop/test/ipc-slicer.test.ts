import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ImageAsset } from '@ie/contracts';
import { planTiles } from '@ie/slicer';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createAssetRegistry } from '../main/assetRegistry.js';
import { handleIntakePreview } from '../main/ipc/intake.js';
import { handleSlicerPlan } from '../main/ipc/slicer.js';

let dir: string;
let file: string;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ie-desktop-slicer-'));
  file = path.join(dir, 'wide.png');
  writeFileSync(file, await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#446688' } }).png().toBuffer());
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const asset = (over: Partial<ImageAsset> = {}): ImageAsset => ({ id: 'A1', path: file, width: 3000, height: 2000, sha256: 'a'.repeat(64), ...over });
const registryWith = (a: ImageAsset) => {
  const registry = createAssetRegistry();
  registry.add(a);
  return registry;
};

describe('slicer.plan handler', () => {
  it('returns the same plan the slicer makes for the asset', () => {
    const result = handleSlicerPlan({ assetId: 'A1', grid: { rows: 2, cols: 3 }, overlapPct: 15 }, registryWith(asset()));
    expect(result).toEqual({ ok: true, value: planTiles({ width: 3000, height: 2000, rows: 2, cols: 3, overlapPct: 15, wrap: false }) });
  });

  it('plans with wrap when asked', () => {
    const result = handleSlicerPlan({ assetId: 'A1', grid: { rows: 2, cols: 2 }, overlapPct: 10, wrap: true }, registryWith(asset()));
    expect(result.ok && result.value.wrap).toBe(true);
    expect(result).toEqual({ ok: true, value: planTiles({ width: 3000, height: 2000, rows: 2, cols: 2, overlapPct: 10, wrap: true }) });
  });

  it('works at every supported grid and returns tiles in order', () => {
    for (let rows = 1; rows <= 6; rows++) {
      for (let cols = 1; cols <= 6; cols++) {
        const result = handleSlicerPlan({ assetId: 'A1', grid: { rows, cols }, overlapPct: 20 }, registryWith(asset()));
        expect(result.ok, `${rows}x${cols}`).toBe(true);
        if (result.ok) expect(result.value.tiles.map((t) => t.index)).toEqual(Array.from({ length: rows * cols }, (_, i) => i));
      }
    }
  });

  it('is invalid_request for an unknown image', () => {
    expect(handleSlicerPlan({ assetId: 'nope', grid: { rows: 1, cols: 1 }, overlapPct: 0 }, registryWith(asset()))).toMatchObject({
      ok: false,
      error: { code: 'invalid_request', message: expect.stringMatching(/no longer available/) },
    });
  });

  it('turns a grid the image cannot support into a message, not a throw', () => {
    const tiny = registryWith(asset({ width: 4, height: 4 }));
    expect(handleSlicerPlan({ assetId: 'A1', grid: { rows: 6, cols: 6 }, overlapPct: 0 }, tiny)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request', message: expect.stringMatching(/grid/i) },
    });
  });

  it.each([undefined, null, {}, { assetId: 'A1' }, { assetId: 'A1', grid: { rows: 0, cols: 1 }, overlapPct: 0 }, { assetId: 'A1', grid: { rows: 1, cols: 1 }, overlapPct: 41 }])(
    'is invalid_request for malformed payload %j',
    (payload) => {
      expect(handleSlicerPlan(payload, registryWith(asset()))).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    },
  );
});

describe('intake.preview handler', () => {
  it('returns a JPEG data URL no larger than the requested side, keeping the aspect ratio', async () => {
    const result = await handleIntakePreview({ assetId: 'A1', maxSide: 600 }, registryWith(asset()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect([result.value.width, result.value.height]).toEqual([600, 400]);
    const bytes = Buffer.from(result.value.dataUrl.split(',')[1]!, 'base64');
    const meta = await sharp(bytes).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 600, 400]);
  });

  it('never enlarges a small image', async () => {
    const small = path.join(dir, 'small.png');
    writeFileSync(small, await sharp({ create: { width: 200, height: 100, channels: 3, background: '#fff' } }).png().toBuffer());
    const result = await handleIntakePreview({ assetId: 'A1' }, registryWith(asset({ path: small, width: 200, height: 100 })));
    expect(result.ok && [result.value.width, result.value.height]).toEqual([200, 100]);
  });

  it('does not modify the image file', async () => {
    const before = await sharp(file).raw().toBuffer();
    await handleIntakePreview({ assetId: 'A1' }, registryWith(asset()));
    expect((await sharp(file).raw().toBuffer()).equals(before)).toBe(true);
  });

  it('says the file is gone when it has been moved or deleted', async () => {
    const result = await handleIntakePreview({ assetId: 'A1' }, registryWith(asset({ path: path.join(dir, 'moved.png') })));
    expect(result).toMatchObject({ ok: false, error: { code: 'file-not-found' } });
  });

  it('reports an unexpected renderer failure as internal, with no stack or path', async () => {
    const render = vi.fn().mockRejectedValue(new Error('boom at C:\\secret\\path'));
    const result = await handleIntakePreview({ assetId: 'A1' }, registryWith(asset()), render);
    expect(result).toEqual({ ok: false, error: { code: 'internal', message: 'The preview could not be made.' } });
  });

  it('rejects an invalid size and an unknown image', async () => {
    expect(await handleIntakePreview({ assetId: 'A1', maxSide: 10 }, registryWith(asset()))).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await handleIntakePreview({ assetId: 'zzz' }, registryWith(asset()))).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await handleIntakePreview(undefined, registryWith(asset()))).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('refuses a response that is not a valid preview', async () => {
    const render = vi.fn().mockResolvedValue({ dataUrl: 'not a data url', width: 10, height: 10 });
    expect(await handleIntakePreview({ assetId: 'A1' }, registryWith(asset()), render)).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
  });
});
