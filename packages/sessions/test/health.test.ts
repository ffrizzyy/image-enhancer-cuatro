// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ProviderId, SessionStatus } from '@ie/contracts';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import rawConfig from '../config/providers.json';
import { classify, createHealthProbe, factsScript, providersConfig, type PageFacts } from '../src/health';
import { PROVIDER_IDS } from '../src/partitions';
import { ProvidersConfigSchema } from '../src/schema';
import type { ProviderView } from '../src/types';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const STATES: SessionStatus[] = ['ready', 'logged-out', 'challenge', 'quota-limited', 'unknown'];

function factsFromHtml(provider: ProviderId, html: string): PageFacts {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  return dom.window.eval(factsScript(providersConfig[provider])) as PageFacts;
}

function viewReturning(evaluate: () => Promise<unknown>): ProviderView {
  return {
    partition: 'persist:test',
    setVisible: () => {},
    isVisible: () => false,
    loadURL: async () => {},
    evaluate: evaluate as ProviderView['evaluate'],
    close: () => {},
  };
}

describe('provider config', () => {
  it('validates for all three providers', () => {
    expect(ProvidersConfigSchema.safeParse(rawConfig).success).toBe(true);
    expect(Object.keys(providersConfig).sort()).toEqual([...PROVIDER_IDS].sort());
  });

  it.each(['ready', 'loggedOut', 'challenge', 'quota'] as const)(
    'parity: validation fails when probe key "%s" is removed',
    (key) => {
      for (const provider of PROVIDER_IDS) {
        const broken = structuredClone(rawConfig) as Record<string, { probes: Record<string, unknown> }>;
        delete broken[provider]?.probes[key];
        expect(ProvidersConfigSchema.safeParse(broken).success).toBe(false);
      }
    },
  );

  it('fails when a provider has no ready selector', () => {
    const broken = structuredClone(rawConfig);
    broken.gpt.probes.ready = [];
    expect(ProvidersConfigSchema.safeParse(broken).success).toBe(false);
  });
});

describe('status from HTML fixtures', () => {
  for (const provider of PROVIDER_IDS) {
    describe(provider, () => {
      it.each(STATES)('maps the %s fixture', (state) => {
        const html = readFileSync(path.join(fixtures, provider, `${state}.html`), 'utf8');
        expect(classify(factsFromHtml(provider, html))).toBe(state);
      });
    });
  }
});

describe('classify precedence', () => {
  const base: PageFacts = { ready: false, loggedOut: false, challenge: false, quota: false };

  it('challenge > quota > logged-out > ready > unknown', () => {
    expect(classify({ ...base, ready: true, loggedOut: true, quota: true, challenge: true })).toBe('challenge');
    expect(classify({ ...base, ready: true, loggedOut: true, quota: true })).toBe('quota-limited');
    expect(classify({ ...base, ready: true, loggedOut: true })).toBe('logged-out');
    expect(classify({ ...base, ready: true })).toBe('ready');
    expect(classify(base)).toBe('unknown');
  });

  it('treats missing facts as unknown', () => {
    expect(classify(null)).toBe('unknown');
    expect(classify(undefined)).toBe('unknown');
    expect(classify({})).toBe('unknown');
  });
});

describe('degradation', () => {
  it('an invalid selector counts as absent instead of throwing', () => {
    const config = structuredClone(providersConfig.gpt);
    config.probes.ready = ['[[[not a selector', '#prompt-textarea'];
    const dom = new JSDOM('<textarea id="prompt-textarea"></textarea>', { runScripts: 'outside-only' });
    const facts = dom.window.eval(factsScript(config)) as PageFacts;
    expect(facts.ready).toBe(true);
  });

  it('createHealthProbe returns unknown when the page script throws or returns junk', async () => {
    const probe = createHealthProbe();
    expect(await probe('gpt', viewReturning(() => Promise.reject(new Error('destroyed'))))).toBe('unknown');
    expect(await probe('gpt', viewReturning(async () => null))).toBe('unknown');
    expect(await probe('gpt', viewReturning(async () => ({ ready: true })))).toBe('ready');
  });

  it('reports unknown, instead of waiting forever, when the page never answers', async () => {
    const hanging = viewReturning(() => new Promise(() => {}));
    const started = performance.now();
    expect(await createHealthProbe(undefined, 30)('gpt', hanging)).toBe('unknown');
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('still returns a real answer that arrives before the timeout', async () => {
    expect(await createHealthProbe(undefined, 1000)('gpt', viewReturning(async () => ({ ready: true })))).toBe('ready');
  });});
