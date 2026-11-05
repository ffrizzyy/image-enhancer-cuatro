import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { EnhanceRequest, ProviderErrorKind } from '@ie/contracts';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROVIDER_ERROR_KINDS, ProviderError, type ProviderAdapter } from '../../src';

export type Scenario = 'ok' | 'timeout' | 'quota' | 'refusal' | 'challenge' | 'logged-out' | 'download-failed';

export interface ContractCase {
  adapter: ProviderAdapter;
  request: EnhanceRequest;
}

export interface ContractContext {
  dir: string;
  /** A real 600x400 PNG to use as the tile attachment. */
  tilePath: string;
}

const FAILURES: Array<[Exclude<Scenario, 'ok'>, ProviderErrorKind]> = [
  ['timeout', 'timeout'],
  ['quota', 'quota'],
  ['refusal', 'refusal'],
  ['challenge', 'challenge'],
  ['logged-out', 'logged-out'],
  ['download-failed', 'download-failed'],
];

/**
 * The suite every provider adapter must pass. Each adapter supplies a factory that puts it into a
 * named scenario (a fake in a failure mode, or a real adapter against a saved page state).
 */
export function describeProviderContract(label: string, make: (scenario: Scenario, ctx: ContractContext) => Promise<ContractCase>): void {
  describe(`provider contract: ${label}`, () => {
    let ctx: ContractContext;

    beforeAll(async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'ie-contract-'));
      const tilePath = path.join(dir, 'tile.png');
      writeFileSync(tilePath, await sharp({ create: { width: 600, height: 400, channels: 3, background: '#7799bb' } }).png().toBuffer());
      ctx = { dir, tilePath };
    });
    afterAll(() => rmSync(ctx.dir, { recursive: true, force: true }));

    it('identifies itself and declares sane capabilities', async () => {
      const { adapter } = await make('ok', ctx);
      expect(['gpt', 'gemini', 'grok']).toContain(adapter.id);
      expect(adapter.capabilities.maxAttachments).toBeGreaterThanOrEqual(1);
      expect(adapter.capabilities.approxOutputPx).toBeGreaterThanOrEqual(256);
      expect(adapter.capabilities.outputAspects.length).toBeGreaterThan(0);
      for (const aspect of adapter.capabilities.outputAspects) expect(['1:1', '2:3', '3:2']).toContain(aspect);
    });

    it('health() answers without generating and reports missing selectors as a list', async () => {
      const { adapter } = await make('ok', ctx);
      const health = await adapter.health();
      expect(typeof health.ok).toBe('boolean');
      expect(Array.isArray(health.missingSelectors)).toBe(true);
      if (health.ok) expect(health.missingSelectors).toEqual([]);
    });

    it('returns a real image file with its size and elapsed time', async () => {
      const { adapter, request } = await make('ok', ctx);
      const result = await adapter.enhance(request);

      expect(existsSync(result.imagePath)).toBe(true);
      const meta = await sharp(result.imagePath).metadata();
      expect({ width: meta.width, height: meta.height }).toEqual({ width: result.width, height: result.height });
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
      expect(Number.isFinite(result.elapsedMs)).toBe(true);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it.each(FAILURES)('maps the %s state to exactly one ProviderError kind, never a plain Error', async (scenario, kind) => {
      const { adapter, request } = await make(scenario, ctx);
      const error = await adapter.enhance(request).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).kind).toBe(kind);
      expect(PROVIDER_ERROR_KINDS).toContain((error as ProviderError).kind);
      expect((error as ProviderError).message.length).toBeGreaterThan(0);
    });

    it('never modifies the attachment files it was given', async () => {
      const { adapter, request } = await make('ok', ctx);
      const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
      const before = request.attachments.map((a) => hash(a.path));
      await adapter.enhance(request);
      expect(request.attachments.map((a) => hash(a.path))).toEqual(before);
    });

    it('rejects a malformed request with RangeError, not a provider failure', async () => {
      const { adapter, request } = await make('ok', ctx);
      await expect(adapter.enhance({ ...request, attachments: [] })).rejects.toThrow(RangeError);
      const tooMany = Array.from({ length: adapter.capabilities.maxAttachments + 1 }, () => request.attachments[0]!);
      await expect(adapter.enhance({ ...request, attachments: tooMany })).rejects.toThrow(RangeError);
    });
  });
}
