import { describe, expect, it } from 'vitest';

import {
  CategorySchema,
  CategorySuggestionSchema,
  CreateJobRequestSchema,
  EnhanceRequestSchema,
  ExportRequestSchema,
  IPC_CHANNELS,
  IPC_EVENT_CHANNELS,
  IPC_VERSION,
  ImageAssetSchema,
  JobSchema,
  TilePlanSchema,
  ipcEventSchemas,
  ipcSchemas,
  parseIpcRequest,
  parseIpcResponse,
} from '../src/index.js';

const SHA = 'a'.repeat(64);
const NOW = '2026-11-05T10:00:00.000Z';

const promptCategory = {
  id: 'env-realistic',
  name: 'Realistic environment',
  kind: 'prompt',
  family: 'environment',
  fidelity: 'preserve',
  template: 'Improve {{tileRole}}. {{fidelityClause}} {{userPrompt}}',
  defaultPrompt: 'A weathered stone courtyard at golden hour',
  negative: ['text', 'watermark'],
  defaults: { grid: [3, 2], overlapPct: 12 },
  warnings: [],
};

const imageAsset = {
  id: 'asset-1',
  path: 'C:/images/source.png',
  width: 4096,
  height: 2048,
  sha256: SHA,
};

const job = {
  id: 'job-1',
  createdAt: NOW,
  source: { path: 'C:/images/source.png', width: 4096, height: 2048, sha256: SHA },
  prompt: 'A weathered stone courtyard at golden hour',
  promptSource: 'category-default',
  categoryId: 'env-realistic',
  categorySource: 'user',
  grid: { rows: 3, cols: 2, overlapPct: 12 },
  providerId: 'gpt',
};

const tilePlan = {
  source: { width: 4096, height: 2048 },
  grid: { rows: 3, cols: 2 },
  overlapPx: 128,
  wrap: false,
  tiles: [
    {
      index: 0,
      row: 0,
      col: 0,
      core: { x: 0, y: 0, width: 1365, height: 1024 },
      crop: { x: 0, y: 0, width: 1493, height: 1152 },
      send: { x: 0, y: 0, width: 1493, height: 1152 },
      edges: { top: true, right: false, bottom: false, left: true },
      role: 'corner',
    },
  ],
};

const jobProgress = {
  jobId: 'job-1',
  state: 'running',
  completedTiles: 1,
  totalTiles: 6,
  tiles: [{ index: 0, state: 'accepted', attempts: 1 }],
};

describe('IPC version', () => {
  it('is pinned to 1', () => {
    expect(IPC_VERSION).toBe(1);
  });
});

describe('IPC channel map', () => {
  it('covers every contract channel exactly once', () => {
    expect([...IPC_CHANNELS].sort()).toEqual(
      [
        'app.ping',
        'sessions.open',
        'sessions.status',
        'sessions.clear',
        'presets.list',
        'presets.get',
        'presets.suggestCategory',
        'intake.import',
        'intake.createJob',
        'intake.preview',
        'slicer.plan',
        'jobs.start',
        'jobs.pause',
        'jobs.resume',
        'jobs.cancel',
        'jobs.get',
        'jobs.listRecent',
        'stitch.run',
        'export.save',
        'settings.get',
        'settings.set',
      ].sort(),
    );
  });

  it('has a request and response schema for every channel', () => {
    for (const channel of IPC_CHANNELS) {
      expect(ipcSchemas[channel].request, `${channel} request`).toBeDefined();
      expect(ipcSchemas[channel].response, `${channel} response`).toBeDefined();
    }
  });

  it('has a schema for every event channel', () => {
    expect([...IPC_EVENT_CHANNELS].sort()).toEqual(['jobs.log', 'jobs.progress', 'sessions.status']);
    for (const channel of IPC_EVENT_CHANNELS) {
      expect(ipcEventSchemas[channel], channel).toBeDefined();
    }
  });

  it('accepts valid requests and rejects malformed ones', () => {
    expect(parseIpcRequest('app.ping', undefined).ok).toBe(true);
    expect(parseIpcRequest('sessions.open', { providerId: 'gemini' }).ok).toBe(true);
    expect(parseIpcRequest('sessions.open', { providerId: 'bing' }).ok).toBe(false);
    expect(parseIpcRequest('jobs.get', { jobId: '' }).ok).toBe(false);
    expect(parseIpcRequest('export.save', { imagePath: 'C:/out.png', format: 'gif' }).ok).toBe(
      false,
    );
  });

  it('accepts valid responses and rejects malformed ones', () => {
    expect(parseIpcResponse('app.ping', { version: '0.1.0', ipcVersion: 1 }).ok).toBe(true);
    expect(parseIpcResponse('app.ping', { version: '0.1.0', ipcVersion: 2 }).ok).toBe(false);
    expect(parseIpcResponse('jobs.get', jobProgress).ok).toBe(true);
    expect(parseIpcResponse('jobs.get', { ...jobProgress, state: 'exploded' }).ok).toBe(false);
  });

  it('returns a readable path for a malformed payload', () => {
    const result = parseIpcRequest('sessions.open', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('providerId');
    }
  });
});

describe('domain schemas', () => {
  it('accepts a valid ImageAsset and Job', () => {
    expect(ImageAssetSchema.safeParse(imageAsset).success).toBe(true);
    expect(JobSchema.safeParse(job).success).toBe(true);
  });

  it('rejects a Job with an empty prompt or bad sha', () => {
    expect(JobSchema.safeParse({ ...job, prompt: '' }).success).toBe(false);
    expect(JobSchema.safeParse({ ...job, source: { ...job.source, sha256: 'nope' } }).success).toBe(
      false,
    );
  });

  it('requires a template and defaultPrompt for prompt categories', () => {
    expect(CategorySchema.safeParse(promptCategory).success).toBe(true);

    const withoutTemplate: Record<string, unknown> = { ...promptCategory };
    delete withoutTemplate.template;
    expect(CategorySchema.safeParse(withoutTemplate).success).toBe(false);

    const withoutDefault: Record<string, unknown> = { ...promptCategory };
    delete withoutDefault.defaultPrompt;
    expect(CategorySchema.safeParse(withoutDefault).success).toBe(false);
  });

  it('accepts the auto meta-category without a template or default prompt', () => {
    const auto = {
      id: 'auto',
      name: 'Auto-detect',
      kind: 'auto',
      family: 'smart',
      fidelity: 'preserve',
      negative: [],
      defaults: { grid: [3, 2], overlapPct: 12 },
      warnings: [],
    };
    expect(CategorySchema.safeParse(auto).success).toBe(true);
  });

  it('rejects an auto suggestion that resolves to auto or custom', () => {
    const base = {
      categoryId: 'env-realistic',
      confidence: 0.8,
      alternatives: [{ categoryId: 'char-realistic', confidence: 0.2 }],
      signals: ['high saturation'],
      lowConfidence: false,
    };
    expect(CategorySuggestionSchema.safeParse(base).success).toBe(true);
    expect(CategorySuggestionSchema.safeParse({ ...base, categoryId: 'auto' }).success).toBe(false);
    expect(
      CategorySuggestionSchema.safeParse({
        ...base,
        alternatives: [{ categoryId: 'custom', confidence: 0.1 }],
      }).success,
    ).toBe(false);
    expect(CategorySuggestionSchema.safeParse({ ...base, confidence: 1.5 }).success).toBe(false);
  });

  it('accepts an empty prompt in CreateJobRequest but not an overlong one', () => {
    const request = {
      assetId: 'asset-1',
      prompt: '',
      categoryId: 'env-realistic',
      grid: { rows: 3, cols: 2, overlapPct: 12 },
      providerId: 'gpt',
    };
    expect(CreateJobRequestSchema.safeParse(request).success).toBe(true);
    expect(
      CreateJobRequestSchema.safeParse({ ...request, prompt: 'x'.repeat(2001) }).success,
    ).toBe(false);
    expect(
      CreateJobRequestSchema.safeParse({ ...request, grid: { rows: 7, cols: 2, overlapPct: 12 } })
        .success,
    ).toBe(false);
    expect(
      CreateJobRequestSchema.safeParse({ ...request, grid: { rows: 3, cols: 2, overlapPct: 41 } })
        .success,
    ).toBe(false);
  });

  it('validates a tile plan', () => {
    expect(TilePlanSchema.safeParse(tilePlan).success).toBe(true);
    expect(
      TilePlanSchema.safeParse({ ...tilePlan, tiles: [{ ...tilePlan.tiles[0], role: 'middle' }] })
        .success,
    ).toBe(false);
  });

  it('validates enhance and export requests', () => {
    expect(
      EnhanceRequestSchema.safeParse({
        attachments: [{ role: 'tile', path: 'C:/tile.png' }],
        prompt: 'enhance',
        timeoutMs: 120000,
      }).success,
    ).toBe(true);
    expect(
      EnhanceRequestSchema.safeParse({ attachments: [], prompt: 'enhance', timeoutMs: 120000 })
        .success,
    ).toBe(false);

    expect(
      ExportRequestSchema.safeParse({ imagePath: 'C:/out.png', format: 'jpeg', quality: 90 })
        .success,
    ).toBe(true);
    expect(
      ExportRequestSchema.safeParse({ imagePath: 'C:/out.png', format: 'jpeg', quality: 0 })
        .success,
    ).toBe(false);
  });

  it('accepts a partial settings update', () => {
    expect(ipcSchemas['settings.set'].request.safeParse({}).success).toBe(true);
    expect(ipcSchemas['settings.set'].request.safeParse({ pacingPreset: 'turbo' }).success).toBe(
      false,
    );
  });
});
