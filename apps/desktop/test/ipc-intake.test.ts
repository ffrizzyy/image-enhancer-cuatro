import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getFeatures, IntakeError } from '@ie/intake';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createAssetRegistry } from '../main/assetRegistry.js';
import { handleIntakeCreateJob, handleIntakeImport } from '../main/ipc/intake.js';
import { handlePresetsList, handlePresetsSuggest } from '../main/ipc/presets.js';

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ie-desktop-intake-'));
  writeFileSync(
    path.join(dir, 'ok.png'),
    await sharp({ create: { width: 40, height: 20, channels: 3, background: '#336699' } })
      .png()
      .toBuffer(),
  );
  writeFileSync(path.join(dir, 'anim.gif'), Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(30)]));
  writeFileSync(path.join(dir, 'bad.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 9)]));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('intake.import handler', () => {
  it('imports a real image into an ImageAsset', async () => {
    const result = await handleIntakeImport({ path: path.join(dir, 'ok.png') });
    expect(result).toMatchObject({ ok: true, value: { width: 40, height: 20, path: path.join(dir, 'ok.png') } });
  });

  it('passes the specific intake code and message through', async () => {
    const gif = await handleIntakeImport({ path: path.join(dir, 'anim.gif') });
    expect(gif).toMatchObject({ ok: false, error: { code: 'unsupported-gif' } });
    if (!gif.ok) expect(gif.error.message).toMatch(/GIF/);

    expect(await handleIntakeImport({ path: path.join(dir, 'bad.png') })).toMatchObject({
      ok: false,
      error: { code: 'corrupt-image' },
    });
    expect(await handleIntakeImport({ path: path.join(dir, 'nope.png') })).toMatchObject({
      ok: false,
      error: { code: 'file-not-found' },
    });
  });

  it.each([undefined, null, {}, { path: '' }, { path: 42 }, 'C:/x.png'])(
    'returns invalid_request for malformed payload %j',
    async (payload) => {
      expect(await handleIntakeImport(payload)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    },
  );

  it('maps unexpected failures to a generic internal error without leaking details', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('EACCES: C:/secret/path'));
    const result = await handleIntakeImport({ path: 'C:/x.png' }, failing);
    expect(result).toEqual({ ok: false, error: { code: 'internal', message: 'The image could not be imported.' } });
  });

  it('reports invalid_response if the importer returns a malformed asset', async () => {
    const bad = vi.fn().mockResolvedValue({ id: 'x', path: 'C:/x.png', width: -1, height: 1, sha256: 'nope' });
    expect(await handleIntakeImport({ path: 'C:/x.png' }, bad)).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' },
    });
  });

  it('uses the importer error code when it throws an IntakeError', async () => {
    const failing = vi.fn().mockRejectedValue(new IntakeError('file-too-large', 'too big'));
    expect(await handleIntakeImport({ path: 'C:/x.png' }, failing)).toEqual({
      ok: false,
      error: { code: 'file-too-large', message: 'too big' },
    });
  });
});

describe('intake.createJob handler', () => {
  const request = (assetId: string, over: Record<string, unknown> = {}) => ({
    assetId,
    prompt: '',
    categoryId: 'env-realistic',
    grid: { rows: 2, cols: 3, overlapPct: 15 },
    providerId: 'gemini',
    ...over,
  });

  it('creates a frozen-source Job for an imported asset, resolving a blank prompt to the category default', async () => {
    const registry = createAssetRegistry();
    const imported = await handleIntakeImport({ path: path.join(dir, 'ok.png') }, undefined, registry);
    if (!imported.ok) throw new Error('import failed');

    const result = handleIntakeCreateJob(request(imported.value.id), registry);
    expect(result).toMatchObject({
      ok: true,
      value: {
        categoryId: 'env-realistic',
        promptSource: 'category-default',
        providerId: 'gemini',
        source: { path: imported.value.path, width: 40, height: 20, sha256: imported.value.sha256 },
      },
    });
  });

  it('does not create anything for an unknown or never-imported asset', () => {
    const create = vi.fn();
    const result = handleIntakeCreateJob(request('NOPE'), createAssetRegistry(), create);
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(create).not.toHaveBeenCalled();
  });

  it('only registers assets that imported successfully', async () => {
    const registry = createAssetRegistry();
    await handleIntakeImport({ path: path.join(dir, 'anim.gif') }, undefined, registry);
    expect(registry.get('anything')).toBeUndefined();
  });

  it('passes intake validation errors through with their codes', async () => {
    const registry = createAssetRegistry();
    const imported = await handleIntakeImport({ path: path.join(dir, 'ok.png') }, undefined, registry);
    if (!imported.ok) throw new Error('import failed');

    expect(handleIntakeCreateJob(request(imported.value.id, { categoryId: 'nope' }), registry)).toMatchObject({
      ok: false,
      error: { code: 'unknown-category' },
    });
    expect(
      handleIntakeCreateJob(request(imported.value.id, { grid: { rows: 2, cols: 3, overlapPct: 15 }, prompt: 'x'.repeat(2001) }), registry),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it.each([undefined, {}, { assetId: 'a' }, request('a', { providerId: 'bing' }), request('a', { grid: { rows: 9, cols: 1, overlapPct: 0 } })])(
    'rejects malformed payload %j',
    (payload) => {
      expect(handleIntakeCreateJob(payload, createAssetRegistry())).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
    },
  );

  it('maps unexpected failures to a generic internal error', async () => {
    const registry = createAssetRegistry();
    const imported = await handleIntakeImport({ path: path.join(dir, 'ok.png') }, undefined, registry);
    if (!imported.ok) throw new Error('import failed');
    const boom = vi.fn(() => {
      throw new Error('secret');
    });
    expect(handleIntakeCreateJob(request(imported.value.id), registry, boom as never)).toEqual({
      ok: false,
      error: { code: 'internal', message: 'The job could not be created.' },
    });
  });
});

describe('presets.list handler', () => {
  it('returns the 19 prompt categories plus auto', () => {
    const result = handlePresetsList();
    expect(result.ok && result.value).toHaveLength(20);
  });

  it('maps failures to a typed error', () => {
    const boom = () => {
      throw new Error('x');
    };
    expect(handlePresetsList(boom)).toMatchObject({ ok: false, error: { code: 'internal' } });
  });
});

describe('intake.createJob: auto-detect source', () => {
  const req = (assetId: string, over: Record<string, unknown> = {}) => ({
    assetId,
    prompt: '',
    categoryId: 'pixel-art',
    grid: { rows: 2, cols: 3, overlapPct: 10 },
    providerId: 'gemini',
    ...over,
  });

  async function imported() {
    const registry = createAssetRegistry();
    const result = await handleIntakeImport({ path: path.join(dir, 'ok.png') }, undefined, registry);
    if (!result.ok) throw new Error('import failed');
    return { registry, id: result.value.id };
  }

  it('records categorySource "auto" and the confidence when the suggestion was kept', async () => {
    const { registry, id } = await imported();
    expect(handleIntakeCreateJob(req(id, { categorySource: 'auto', categoryConfidence: 0.72 }), registry)).toMatchObject({
      ok: true,
      value: { categorySource: 'auto', categoryConfidence: 0.72, categoryId: 'pixel-art' },
    });
  });

  it('defaults to "user" and drops a confidence that does not come with auto', async () => {
    const { registry, id } = await imported();
    const result = handleIntakeCreateJob(req(id, { categoryConfidence: 0.9 }), registry);
    expect(result).toMatchObject({ ok: true, value: { categorySource: 'user' } });
    expect(result.ok && result.value).not.toHaveProperty('categoryConfidence');
  });

  it('rejects an out-of-range confidence or unknown source', async () => {
    const { registry, id } = await imported();
    for (const over of [{ categorySource: 'auto', categoryConfidence: 1.5 }, { categorySource: 'guess' }]) {
      expect(handleIntakeCreateJob(req(id, over), registry)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    }
  });
});

describe('presets.suggestCategory handler', () => {
  const features = {
    width: 40, height: 20, aspect: 2, saturation: 0.3, colorfulness: 40, edgeDensity: 0.1, highFrequencyEnergy: 5,
    paletteSize: 300, blockiness: 0.01, blurVariance: 400, noiseEstimate: 3, transparencyRatio: 0, luminanceBimodality: 0.05,
  };

  async function setup() {
    const registry = createAssetRegistry();
    const result = await handleIntakeImport({ path: path.join(dir, 'ok.png') }, undefined, registry);
    if (!result.ok) throw new Error('import failed');
    return { registry, assetId: result.value.id };
  }

  it('suggests from the asset features and the prompt', async () => {
    const { registry, assetId } = await setup();
    const featuresFor = vi.fn().mockResolvedValue(features);
    const result = await handlePresetsSuggest({ assetId, prompt: 'pixel art sprite' }, { registry, featuresFor });

    expect(result).toMatchObject({ ok: true, value: { categoryId: 'pixel-art', lowConfidence: false } });
    expect(featuresFor).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: assetId }));
  });

  it('passes the prompt through to the suggester', async () => {
    const { registry, assetId } = await setup();
    const suggest = vi.fn().mockReturnValue({ categoryId: 'env-realistic', confidence: 0.5, alternatives: [], signals: ['x'], lowConfidence: true });
    await handlePresetsSuggest({ assetId, prompt: 'hello world' }, { registry, featuresFor: async () => features, suggest });
    expect(suggest).toHaveBeenCalledExactlyOnceWith(features, 'hello world');
  });

  it('rejects an unknown asset without analysing anything', async () => {
    const featuresFor = vi.fn();
    const result = await handlePresetsSuggest({ assetId: 'NOPE', prompt: '' }, { registry: createAssetRegistry(), featuresFor });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(featuresFor).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { assetId: 'a' }, { assetId: 'a', prompt: 'x'.repeat(2001) }, 'x'])('rejects malformed payload %j', async (payload) => {
    const result = await handlePresetsSuggest(payload, { registry: createAssetRegistry(), featuresFor: vi.fn() });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('maps analysis failures to a generic error without leaking details', async () => {
    const { registry, assetId } = await setup();
    const result = await handlePresetsSuggest(
      { assetId, prompt: '' },
      { registry, featuresFor: async () => Promise.reject(new Error('C:/secret/path')) },
    );
    expect(result).toEqual({ ok: false, error: { code: 'internal', message: 'The image could not be analysed.' } });
  });

  it('reports invalid_response if the suggester returns auto or custom', async () => {
    const { registry, assetId } = await setup();
    const suggest = vi.fn().mockReturnValue({ categoryId: 'auto', confidence: 0.9, alternatives: [], signals: ['x'], lowConfidence: false });
    expect(await handlePresetsSuggest({ assetId, prompt: '' }, { registry, featuresFor: async () => features, suggest })).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' },
    });
  });

  it('works end to end on a real image and reuses the cached features on the next call', async () => {
    const { registry, assetId } = await setup();
    const cacheDir = path.join(dir, 'features-cache');
    const featuresFor = async (asset: Parameters<typeof getFeatures>[0]) => (await getFeatures(asset, cacheDir)).features;

    const first = await handlePresetsSuggest({ assetId, prompt: '' }, { registry, featuresFor });
    expect(first.ok).toBe(true);

    const asset = registry.get(assetId)!;
    expect((await getFeatures(asset, cacheDir)).cached).toBe(true);
    expect(await handlePresetsSuggest({ assetId, prompt: '' }, { registry, featuresFor })).toEqual(first);
  });
});
