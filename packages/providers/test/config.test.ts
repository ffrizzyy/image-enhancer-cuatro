import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { createImageSaver, IDLE_SELECTOR_KEYS, ProviderConfigSchema, REQUIRED_SELECTOR_KEYS, WebAdapter } from '../src';
import { FakeClock, FakePage } from './support/fakePage';
import { testConfig } from './support/testConfig';

type Obj = Record<string, unknown>;
/** The config as loose JSON, so tests can break it in ways the real type forbids. */
interface RawConfig {
  id: unknown;
  minOutputPx: unknown;
  urls: Obj;
  selectors: Obj;
  markers: Obj;
  timeouts: Obj;
  capabilities: Obj;
}

const valid = (): RawConfig => JSON.parse(JSON.stringify(testConfig())) as RawConfig;
const parses = (config: unknown): boolean => ProviderConfigSchema.safeParse(config).success;

describe('config schema', () => {
  it('accepts a complete config', () => {
    expect(parses(valid())).toBe(true);
  });

  it('requires every selector key the WebAdapter uses (parity)', () => {
    for (const key of REQUIRED_SELECTOR_KEYS) {
      const config = valid();
      delete config.selectors[key];
      expect(parses(config), `config without ${key}`).toBe(false);
    }
  });

  it('is generated from the same list the WebAdapter relies on', () => {
    expect(Object.keys(valid().selectors).sort()).toEqual([...REQUIRED_SELECTOR_KEYS].sort());
    for (const key of IDLE_SELECTOR_KEYS) expect(REQUIRED_SELECTOR_KEYS).toContain(key);
  });

  it('the WebAdapter really looks up every required key during a normal run (no dead keys)', async () => {
    const clock = new FakeClock();
    const image = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#000' } }).png().toBuffer();
    const page = new FakePage({ scenario: 'ok', clock, image, resultAfterPolls: 2 });
    const dir = mkdtempSync(path.join(tmpdir(), 'ie-cfg-'));
    try {
      const config = testConfig();
      await new WebAdapter({
        driver: page,
        config,
        saveImage: createImageSaver(dir),
        sleep: async (ms) => clock.advance(ms),
        now: clock.now,
      }).enhance({ attachments: [{ role: 'tile', path: 'C:/a.png' }], prompt: 'p', timeoutMs: 20_000 });

      const used = [...page.seen].flatMap((s) => s.split(',').map((p) => p.trim()));
      for (const key of REQUIRED_SELECTOR_KEYS) {
        expect(config.selectors[key].some((s) => used.includes(s)), `${key} was never looked up`).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('needs ordered fallbacks: at least one non-empty selector per key', () => {
    for (const bad of [[], ['']]) {
      const config = valid();
      config.selectors.promptInput = bad;
      expect(parses(config)).toBe(false);
    }
    const many = valid();
    many.selectors.promptInput = ['#a', '#b', '#c'];
    expect(parses(many)).toBe(true);
  });

  it('validates the URL, ids, timeouts, capabilities and output size', () => {
    const cases: Array<[string, (c: RawConfig) => void]> = [
      ['relative url', (c) => (c.urls.newChat = '/new')],
      ['missing url', (c) => delete c.urls.newChat],
      ['unknown provider', (c) => (c.id = 'bing')],
      ['zero timeout', (c) => (c.timeouts.generationMs = 0)],
      ['fractional timeout', (c) => (c.timeouts.attachMs = 1.5)],
      ['missing timeout', (c) => delete c.timeouts.downloadMs],
      ['no attachments allowed', (c) => (c.capabilities.maxAttachments = 0)],
      ['bad aspect', (c) => (c.capabilities.outputAspects = ['16:9'])],
      ['no aspects', (c) => (c.capabilities.outputAspects = [])],
      ['tiny output', (c) => (c.capabilities.approxOutputPx = 100)],
      ['zero minimum size', (c) => (c.minOutputPx = 0)],
    ];
    for (const [label, mutate] of cases) {
      const config = valid();
      mutate(config);
      expect(parses(config), label).toBe(false);
    }
  });

  it('validates state markers: all four present, each with at least one selector or phrase', () => {
    for (const kind of ['loggedOut', 'challenge', 'quota', 'refusal']) {
      const missing = valid();
      delete missing.markers[kind];
      expect(parses(missing), `no ${kind} marker`).toBe(false);

      const empty = valid();
      empty.markers[kind] = { selectors: [], text: [] };
      expect(parses(empty), `empty ${kind} marker`).toBe(false);
    }
    const selectorOnly = valid();
    selectorOnly.markers.quota = { selectors: ['.limit'], text: [] };
    expect(parses(selectorOnly)).toBe(true);
  });
});

describe('shipped provider configs', () => {
  const configDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config');
  const files = existsSync(configDir) ? readdirSync(configDir).filter((f) => f.endsWith('.json')) : [];

  // Provider configs arrive with their adapters (GPT, Gemini, Grok). Each one must validate and carry every key.
  it.each(files)('%s validates and has every required selector key', (file) => {
    const config = JSON.parse(readFileSync(path.join(configDir, file), 'utf8'));
    expect(parses(config)).toBe(true);
    expect(Object.keys(config.selectors).sort()).toEqual([...REQUIRED_SELECTOR_KEYS].sort());
  });

  it('has a config file named after its provider id', () => {
    for (const file of files) {
      const config = JSON.parse(readFileSync(path.join(configDir, file), 'utf8'));
      expect(`${config.id}.json`).toBe(file);
    }
  });
});
