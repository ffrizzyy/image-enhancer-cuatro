import path from 'node:path';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { createGeminiAdapter, createImageSaver, loadProviderConfig } from '../src';
import { ElectronPageDriver } from '../src/electron';
import { describeProviderContract, type Scenario } from './support/contractSuite';
import { GeminiPageSim } from './support/geminiPageSim';

/**
 * The real Gemini adapter + the real Electron driver against a simulated Gemini page. The idle/menu/attach/send
 * structure is verified against the live site; the generation outcomes are unverified guesses (see
 * test/fixtures/gemini/README.md).
 */
describeProviderContract('Gemini on simulated page', async (scenario: Scenario, ctx) => {
  const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#335577' } }).png().toBuffer();
  const base = loadProviderConfig('gemini');
  // Short waits so the failure scenarios do not take real minutes.
  const config = { ...base, timeouts: { navigationMs: 2000, attachMs: 2000, generationMs: 600, downloadMs: 2000 } };

  const sim = new GeminiPageSim(scenario, png);
  const adapter = createGeminiAdapter({
    config,
    driver: new ElectronPageDriver(sim, { sleep: async () => {}, chooserTimeoutMs: 200, operationTimeoutMs: 2000 }),
    saveImage: createImageSaver(path.join(ctx.dir, 'gemini-out')),
    sleep: async () => {},
    random: () => 0.5,
    pollMs: 20,
  });
  return {
    adapter,
    request: { attachments: [{ role: 'tile' as const, path: ctx.tilePath }], prompt: 'Enhance this tile.', timeoutMs: 5000 },
  };
});

describe('Gemini config', () => {
  it('counts attachment previews one per file', () => {
    expect(loadProviderConfig('gemini').selectors.attachmentThumb).toEqual(['uploader-file-preview']);
  });
});
