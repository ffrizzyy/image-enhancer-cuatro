import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EnhanceRequest } from '@ie/contracts';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as providers from '../src';
import { ProviderError } from '../src';
import { FAILING_MODES, FakeAdapter, FakeAdapterUnavailableError, type FailureMode } from '../src/adapters/fake';

let dir: string;
let tile: string;
let small: string;
let counter = 0;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ie-fake-'));
  tile = path.join(dir, 'tile.png');
  small = path.join(dir, 'small.png');
  writeFileSync(tile, await sharp({ create: { width: 600, height: 400, channels: 3, background: '#7799bb' } }).png().toBuffer());
  writeFileSync(small, await sharp({ create: { width: 100, height: 100, channels: 3, background: '#bb9977' } }).png().toBuffer());
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const request = (): EnhanceRequest => ({ attachments: [{ role: 'tile', path: tile }], prompt: 'x', timeoutMs: 1000 });
const outputDir = (): string => path.join(dir, `out-${counter++}`);

/** Runs `n` calls and returns the outcome of each: "ok" or the error kind. */
async function outcomes(adapter: FakeAdapter, n: number): Promise<string[]> {
  const result: string[] = [];
  for (let i = 0; i < n; i++) {
    result.push(await adapter.enhance(request()).then(() => 'ok', (e: ProviderError) => e.kind));
  }
  return result;
}

describe('development-only guard', () => {
  it('refuses to be created in production', () => {
    expect(() => new FakeAdapter({ outputDir: outputDir(), env: { NODE_ENV: 'production' } })).toThrow(FakeAdapterUnavailableError);
    expect(() => new FakeAdapter({ outputDir: outputDir(), env: {} })).toThrow(/development and test/);
  });

  it('is allowed in development, test, or with the explicit override', () => {
    for (const env of [{ NODE_ENV: 'development' }, { NODE_ENV: 'test' }, { IE_ALLOW_FAKE: '1' }]) {
      expect(() => new FakeAdapter({ outputDir: outputDir(), env })).not.toThrow();
    }
  });

  it('is not exported from the production entry point or its package export', () => {
    expect(Object.keys(providers).some((name) => /fake/i.test(name))).toBe(false);
    const manifest = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
    expect(manifest.exports['.'].import).not.toMatch(/fake/);
    expect(manifest.exports['./fake'].import).toMatch(/fake/);
  });
});

describe('failure modes', () => {
  it.each(FAILING_MODES)('mode %s throws a ProviderError of that exact kind', async (mode) => {
    const adapter = new FakeAdapter({ outputDir: outputDir(), modes: mode });
    const error = await adapter.enhance(request()).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe(mode);
  });

  it('covers every kind except ui-changed', () => {
    expect([...FAILING_MODES].sort()).toEqual(['challenge', 'download-failed', 'logged-out', 'quota', 'refusal', 'timeout']);
  });

  it('cycles a list of modes one per call', async () => {
    const modes: FailureMode[] = ['ok', 'quota', 'ok', 'timeout'];
    expect(await outcomes(new FakeAdapter({ outputDir: outputDir(), modes }), 6)).toEqual(['ok', 'quota', 'ok', 'timeout', 'ok', 'quota']);
  });

  it('is always ok with no modes and no failure rate', async () => {
    expect(new Set(await outcomes(new FakeAdapter({ outputDir: outputDir() }), 5))).toEqual(new Set(['ok']));
  });
});

describe('seeded random failures', () => {
  const make = (seed: number, failRate: number, failureModes?: typeof FAILING_MODES) =>
    new FakeAdapter({ outputDir: outputDir(), seed, failRate, ...(failureModes ? { failureModes } : {}) });

  it('gives the same sequence for the same seed, and a different one for another seed', async () => {
    const a = await outcomes(make(7, 0.5), 40);
    expect(await outcomes(make(7, 0.5), 40)).toEqual(a);
    expect(await outcomes(make(8, 0.5), 40)).not.toEqual(a);
    expect(a).toContain('ok');
    expect(a.some((o) => o !== 'ok')).toBe(true);
  });

  it('fails never at rate 0 and always at rate 1', async () => {
    expect(new Set(await outcomes(make(1, 0), 20))).toEqual(new Set(['ok']));
    expect((await outcomes(make(1, 1), 20)).every((o) => o !== 'ok')).toBe(true);
  });

  it('draws failures only from the allowed set', async () => {
    const seen = new Set(await outcomes(make(3, 1, ['quota', 'challenge']), 40));
    expect([...seen].sort()).toEqual(['challenge', 'quota']);
  });

  it('roughly honours the failure rate', async () => {
    const results = await outcomes(make(42, 0.3), 400);
    const rate = results.filter((r) => r !== 'ok').length / results.length;
    expect(rate).toBeGreaterThan(0.2);
    expect(rate).toBeLessThan(0.4);
  });
});

describe('ok results', () => {
  it('returns the tile enlarged 2x as a real PNG, named by call number', async () => {
    const out = outputDir();
    const adapter = new FakeAdapter({ outputDir: out });
    const result = await adapter.enhance(request());
    expect(result).toMatchObject({ width: 1200, height: 800, elapsedMs: 0 });
    expect(result.imagePath).toBe(path.join(out, 'fake-001.png'));
    const meta = await sharp(result.imagePath).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 1200, 800]);
    expect((await adapter.enhance(request())).imagePath).toBe(path.join(out, 'fake-002.png'));
  });

  it('honours scale and simulated elapsed time', async () => {
    const adapter = new FakeAdapter({ outputDir: outputDir(), scale: 1, simulatedMs: 1234 });
    expect(await adapter.enhance(request())).toMatchObject({ width: 600, height: 400, elapsedMs: 1234 });
  });

  it('enlarges the tile attachment, not another attachment listed first', async () => {
    const adapter = new FakeAdapter({ outputDir: outputDir() });
    const result = await adapter.enhance({
      ...request(),
      attachments: [{ role: 'global-reference', path: small }, { role: 'tile', path: tile }],
    });
    expect(result.width).toBe(1200);
  });

  it('falls back to the first attachment when none is marked as the tile', async () => {
    const adapter = new FakeAdapter({ outputDir: outputDir() });
    const result = await adapter.enhance({ ...request(), attachments: [{ role: 'neighbor', path: small }] });
    expect(result.width).toBe(200);
  });

  it('is reproducible: the same input gives byte-identical output', async () => {
    const [a, b] = [new FakeAdapter({ outputDir: outputDir() }), new FakeAdapter({ outputDir: outputDir() })];
    const [ra, rb] = [await a.enhance(request()), await b.enhance(request())];
    expect(readFileSync(ra.imagePath).equals(readFileSync(rb.imagePath))).toBe(true);
  });
});

describe('bookkeeping', () => {
  it('counts calls including failures, but not rejected malformed requests', async () => {
    const adapter = new FakeAdapter({ outputDir: outputDir(), modes: ['quota', 'ok'] });
    await outcomes(adapter, 2);
    expect(adapter.calls).toBe(2);
    await expect(adapter.enhance({ ...request(), attachments: [] })).rejects.toThrow(RangeError);
    const tooMany = Array.from({ length: 4 }, () => ({ role: 'tile' as const, path: tile }));
    await expect(adapter.enhance({ ...request(), attachments: tooMany })).rejects.toThrow(RangeError);
    expect(adapter.calls).toBe(2);
  });

  it('reports a healthy page and its id and capabilities', async () => {
    const adapter = new FakeAdapter({ outputDir: outputDir(), id: 'gemini' });
    expect(adapter.id).toBe('gemini');
    expect(adapter.capabilities.maxAttachments).toBe(3);
    expect(await adapter.health()).toEqual({ ok: true, missingSelectors: [] });
    expect(new FakeAdapter({ outputDir: outputDir() }).id).toBe('gpt');
  });
});
