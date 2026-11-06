import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Job, ProviderId, SessionStatus } from '@ie/contracts';
import { openStore, type Store } from '@ie/orchestrator';
import { FakeAdapter } from '@ie/providers/fake';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { handleExportSave } from '../main/ipc/export.js';
import { createJobService } from '../main/jobService.js';

let root: string;
let source: string;
beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'ie-flow-'));
  source = path.join(root, 'source.png');
  const data = Buffer.alloc(600 * 400 * 3);
  for (let y = 0; y < 400; y++) for (let x = 0; x < 600; x++) data.set([128 + 90 * Math.sin(x / 29), 110 + 70 * Math.cos(y / 21), 120 + 60 * Math.sin((x + y) / 37)], (y * 600 + x) * 3);
  await sharp(data, { raw: { width: 600, height: 400, channels: 3 } }).png().toFile(source);
});
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* temporary folder: the OS cleans up */
  }
});

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));

describe('the whole flow on the fake provider', () => {
  it('import -> run -> captcha pause -> resume -> result -> export, in every format', { timeout: 120_000 }, async () => {
    const dir = path.join(root, 'flow');
    mkdirSync(dir, { recursive: true });
    const hooks: { service: ReturnType<typeof createJobService> | null } = { service: null };
    const store = openStore(path.join(dir, 'jobs.sqlite'), { onCommit: (c) => hooks.service?.notify(c) });
    stores.push(store);

    // One adapter for the whole job, so its list of outcomes carries on after the resume.
    const adapter = new FakeAdapter({ id: 'gemini', outputDir: path.join(dir, 'provider'), modes: ['ok', 'challenge', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'] });
    const status = { value: 'ready' as SessionStatus };
    const shown: ProviderId[] = [];
    const service = createJobService({
      store,
      dataDir: dir,
      adapterFor: async () => ({ adapter }),
      sessionStatus: async () => status.value,
      showProvider: (id) => void shown.push(id),
      emitProgress: () => {},
      emitLog: () => {},
      runOptions: { sleep: async () => {} },
    });
    hooks.service = service;

    const job: Job = {
      id: 'FLOW',
      createdAt: '2026-11-06T10:00:00.000Z',
      source: { path: source, width: 600, height: 400, sha256: 'b'.repeat(64) },
      prompt: 'Enhance this tile.',
      promptSource: 'user',
      categoryId: 'env-realistic',
      categorySource: 'user',
      grid: { rows: 2, cols: 2, overlapPct: 15 },
      providerId: 'gemini',
    };
    service.register(job);

    // The second generation hits a human check: the job pauses and the provider window is brought forward.
    status.value = 'ready';
    await service.start('FLOW');
    await service.whenIdle();
    expect(service.get('FLOW')).toMatchObject({ state: 'paused', pauseReason: 'challenge' });
    expect(shown).toContain('gemini');

    // The person solves it; the job carries on to the end without repeating accepted tiles.
    await service.resume('FLOW');
    await service.whenIdle();
    const finished = service.get('FLOW');
    expect(finished.state).toBe('done');
    expect(finished.tiles.every((t) => t.state === 'accepted')).toBe(true);

    const result = await service.result('FLOW', 512);
    expect(result.metrics.seamScore).toBeLessThanOrEqual(1.2);

    // Export in every format; the dimensions are the finished picture's.
    for (const format of ['png', 'jpeg', 'webp'] as const) {
      const destination = path.join(dir, `out.${format}`);
      const saved = await handleExportSave({ imagePath: result.imagePath, format }, service, async () => destination);
      expect(saved.ok).toBe(true);
      const meta = await sharp(destination).metadata();
      expect([meta.width, meta.height]).toEqual([result.width, result.height]);
    }
  });
});
