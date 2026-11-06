import path from 'node:path';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { createGptAdapter, createGrokAdapter, createImageSaver, loadProviderConfig } from '../src';
import { ElectronPageDriver } from '../src/electron';
import { describeProviderContract, type Scenario } from './support/contractSuite';
import { ChatPageSim, GPT_SPEC, GROK_SPEC, type ChatPageSpec } from './support/chatPageSim';

/**
 * The real GPT and Grok adapters + the real Electron driver against simulated pages built from their configs.
 * They prove the config-driven flow end to end; they do not prove the live sites look like these pages.
 */
const CASES = [
  ['gpt', createGptAdapter, GPT_SPEC],
  ['grok', createGrokAdapter, GROK_SPEC],
] as const;

for (const [id, create, spec] of CASES) {
  describeProviderContract(`${id} on simulated page`, async (scenario: Scenario, ctx) => {
    const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#335577' } }).png().toBuffer();
    const base = loadProviderConfig(id);
    const config = { ...base, timeouts: { navigationMs: 2000, attachMs: 2000, generationMs: 600, downloadMs: 2000 } };
    const sim = new ChatPageSim(spec as ChatPageSpec, scenario, png);
    const adapter = create({
      config,
      driver: new ElectronPageDriver(sim, { sleep: async () => {}, chooserTimeoutMs: 200, operationTimeoutMs: 2000 }),
      saveImage: createImageSaver(path.join(ctx.dir, `${id}-out`)),
      sleep: async () => {},
      random: () => 0.5,
      pollMs: 20,
    });
    return {
      adapter,
      request: { attachments: [{ role: 'tile' as const, path: ctx.tilePath }], prompt: 'Enhance this tile.', timeoutMs: 5000 },
    };
  });
}
