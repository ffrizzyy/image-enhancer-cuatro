import path from 'node:path';

import sharp from 'sharp';

import { createImageSaver, WebAdapter } from '../src';
import { FakeAdapter } from '../src/adapters/fake';
import { describeProviderContract, type ContractContext, type Scenario } from './support/contractSuite';
import { FakeClock, FakePage, type PageScenario } from './support/fakePage';
import { testConfig } from './support/testConfig';

const request = (ctx: ContractContext) => ({
  attachments: [{ role: 'tile' as const, path: ctx.tilePath }],
  prompt: 'Enhance this tile.',
  timeoutMs: 20_000,
});

// The fake adapter: each scenario is a failure mode.
describeProviderContract('FakeAdapter', async (scenario, ctx) => ({
  adapter: new FakeAdapter({ outputDir: path.join(ctx.dir, 'fake-out'), modes: scenario }),
  request: request(ctx),
}));

// The shared WebAdapter driving a scripted chat page: each scenario is a page state.
const PAGE_SCENARIO: Record<Scenario, PageScenario> = {
  ok: 'ok',
  timeout: 'never',
  quota: 'quota',
  refusal: 'refusal',
  challenge: 'challenge',
  'logged-out': 'logged-out',
  'download-failed': 'download-failed',
};

describeProviderContract('WebAdapter on scripted pages', async (scenario, ctx) => {
  const clock = new FakeClock();
  const image = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#335577' } }).png().toBuffer();
  const adapter = new WebAdapter({
    driver: new FakePage({ scenario: PAGE_SCENARIO[scenario], clock, image, resultAfterPolls: 2 }),
    config: testConfig(),
    saveImage: createImageSaver(path.join(ctx.dir, 'web-out')),
    sleep: async (ms) => clock.advance(ms),
    random: () => 0.5,
    now: clock.now,
    pollMs: 1000,
  });
  return { adapter, request: request(ctx) };
});
