import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGptAdapter, createGrokAdapter, createImageSaver, loadProviderConfig } from '../src';
import { ElectronPageDriver } from '../src/electron';
import { describeProviderContract, type Scenario } from './support/contractSuite';
import { ChatPageSim, GPT_SPEC, GROK_SPEC, type ChatPageSpec } from './support/chatPageSim';

const MULTI_CASES = [
  ['gpt', createGptAdapter, GPT_SPEC],
  ['grok', createGrokAdapter, GROK_SPEC],
] as const;

/**
 * The live ChatGPT and Grok composers have a single-file input, so the real job (tile + reference) failed with
 * "Only 1 of 2 attachments appeared". Attaching one file at a time is what makes the second one register.
 */
describe('several attachments on a single-file input', () => {
  let dir: string;
  let png: Buffer;
  let paths: string[];

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ie-multi-'));
    png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#335577' } }).png().toBuffer();
    paths = ['tile.png', 'reference.png'].map((name) => path.join(dir, name));
    for (const file of paths) writeFileSync(file, png);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  for (const [id, create, spec] of MULTI_CASES) {
    it(`${id} attaches each file separately and both previews appear`, async () => {
      const base = loadProviderConfig(id);
      const config = { ...base, timeouts: { navigationMs: 2000, attachMs: 2000, generationMs: 600, downloadMs: 2000 } };
      const sim = new ChatPageSim(spec as ChatPageSpec, 'ok', png);
      const adapter = create({
        config,
        driver: new ElectronPageDriver(sim, { sleep: async () => {}, chooserTimeoutMs: 200, operationTimeoutMs: 2000 }),
        saveImage: createImageSaver(path.join(dir, `${id}-multi`)),
        sleep: async () => {},
        random: () => 0.5,
        pollMs: 20,
      });

      const result = await adapter.enhance({
        attachments: [
          { role: 'tile' as const, path: paths[0]! },
          { role: 'global-reference' as const, path: paths[1]! },
        ],
        prompt: 'Enhance this tile.',
        timeoutMs: 5000,
      });

      expect(result.imagePath).toBeTruthy();
      const attachCalls = sim.cdp.filter((call) => call.method === 'DOM.setFileInputFiles');
      expect(attachCalls.map((call) => (call.params?.files as string[]).length)).toEqual([1, 1]);
      const thumbs = config.selectors.attachmentThumb.join(', ');
      expect(sim.dom.window.document.querySelectorAll(thumbs)).toHaveLength(2);
    });
  }
});

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
