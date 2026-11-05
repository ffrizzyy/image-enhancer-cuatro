import { describe, expect, it } from 'vitest';

import {
  IPC_VERSION,
  ipcSchemas,
  parseIpcRequest,
  type AppSettings,
  type Category,
  type CategorySource,
  type CategorySuggestion,
  type EnhanceRequest,
  type EnhanceResult,
  type ImageAsset,
  type ImageFeatures,
  type IpcChannel,
  type Job,
  type JobState,
  type PauseReason,
  type ProviderErrorKind,
  type ProviderId,
  type SessionStatus,
  type StitchOptions,
  type StitchResult,
  type Tile,
  type TilePlan,
  type TileState,
} from '@ie/contracts';

const provider: ProviderId = 'gpt';
const status: SessionStatus = 'ready';
const jobState: JobState = 'idle';
const tileState: TileState = 'pending';
const pauseReason: PauseReason = 'challenge';
const errorKind: ProviderErrorKind = 'timeout';
const categorySource: CategorySource = 'auto';
const channel: IpcChannel = 'presets.suggestCategory';

const asset: ImageAsset = {
  id: 'asset-1',
  path: 'C:/images/source.png',
  width: 1024,
  height: 512,
  sha256: 'b'.repeat(64),
};

const features: ImageFeatures = {
  width: 256,
  height: 128,
  aspect: 2,
  saturation: 0.5,
  colorfulness: 20,
  edgeDensity: 0.2,
  highFrequencyEnergy: 0.1,
  paletteSize: 64,
  blockiness: 0.05,
  blurVariance: 100,
  noiseEstimate: 0.02,
  transparencyRatio: 0,
  luminanceBimodality: 0.3,
};

const category: Category = {
  id: 'auto',
  name: 'Auto-detect',
  kind: 'auto',
  family: 'smart',
  fidelity: 'preserve',
  negative: [],
  defaults: { grid: [3, 2], overlapPct: 12 },
  warnings: [],
};

const suggestion: CategorySuggestion = {
  categoryId: 'env-realistic',
  confidence: 0.7,
  alternatives: [],
  signals: ['smooth gradients'],
  lowConfidence: false,
};

const job: Job = {
  id: 'job-1',
  createdAt: '2026-11-05T10:00:00.000Z',
  source: { path: 'C:/images/source.png', width: 1024, height: 512, sha256: 'b'.repeat(64) },
  prompt: 'enhance',
  promptSource: 'user',
  categoryId: 'env-realistic',
  categorySource,
  grid: { rows: 3, cols: 2, overlapPct: 12 },
  providerId: provider,
};

const tile: Tile = {
  index: 0,
  row: 0,
  col: 0,
  core: { x: 0, y: 0, width: 512, height: 512 },
  crop: { x: 0, y: 0, width: 512, height: 512 },
  send: { x: 0, y: 0, width: 512, height: 512 },
  edges: { top: true, right: false, bottom: false, left: true },
  role: 'corner',
};

const plan: TilePlan = {
  source: { width: 1024, height: 512 },
  grid: { rows: 1, cols: 2 },
  overlapPx: 0,
  wrap: false,
  tiles: [tile],
};

const enhanceRequest: EnhanceRequest = {
  attachments: [{ role: 'tile', path: 'C:/tile.png' }],
  prompt: 'enhance',
  timeoutMs: 1000,
};

const enhanceResult: EnhanceResult = {
  imagePath: 'C:/out.png',
  width: 512,
  height: 512,
  elapsedMs: 500,
};

const stitchOptions: StitchOptions = { blend: 'multiband', maxShiftPx: 8, harmonize: true };
const stitchResult: StitchResult = {
  imagePath: 'C:/stitched.png',
  metrics: { seamScore: 0.1, maxDeltaE: 1.2 },
  flagged: [],
};
const settings: AppSettings = {
  firstRunAcknowledged: false,
  pacingPreset: 'safe',
  dataFolder: 'C:/data',
  watchMode: false,
  riskNoticeVersion: 1,
};

describe('package exports', () => {
  it('resolves every required type and value from the package entry point', () => {
    expect(IPC_VERSION).toBe(1);
    expect(ipcSchemas[channel]).toBeDefined();
    expect(parseIpcRequest('sessions.open', { providerId: provider }).ok).toBe(true);
    expect([
      asset,
      features,
      category,
      suggestion,
      job,
      plan,
      enhanceRequest,
      enhanceResult,
      stitchOptions,
      stitchResult,
      settings,
      status,
      jobState,
      tileState,
      pauseReason,
      errorKind,
    ]).toHaveLength(16);
  });
});
