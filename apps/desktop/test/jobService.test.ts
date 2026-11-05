import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { EnhanceRequest, ImageAsset, Job, JobProgress, ProviderId, SessionStatus } from '@ie/contracts';
import { openStore, type Store } from '@ie/orchestrator';
import { FakeAdapter, type FailureMode } from '@ie/providers/fake';
import type { ProviderAdapter } from '@ie/providers';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createAssetRegistry } from '../main/assetRegistry.js';
import {
  handleCreateAndRegisterJob,
  handleJobsCancel,
  handleJobsGet,
  handleJobsListRecent,
  handleJobsPause,
  handleJobsResume,
  handleJobsStart,
  handleJobsTileThumbnail,
} from '../main/ipc/jobs.js';
import { createJobService, JobServiceError, type JobService } from '../main/jobService.js';

let root: string;
let source: string;
beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'ie-desktop-jobs-'));
  source = path.join(root, 'source.png');
  const data = Buffer.alloc(800 * 400 * 3);
  for (let y = 0; y < 400; y++) for (let x = 0; x < 800; x++) data.set([128 + 90 * Math.sin(x / 31), 110 + 70 * Math.cos(y / 23), 120 + 60 * Math.sin((x + y) / 41)], (y * 800 + x) * 3);
  await sharp(data, { raw: { width: 800, height: 400, channels: 3 } }).png().toFile(source);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));

/** Slows every call down so a test can act while a job is mid-run. */
class Delayed implements ProviderAdapter {
  constructor(private readonly inner: FakeAdapter, private readonly ms: number, private readonly hook?: (call: number) => void) {}
  get id() { return this.inner.id; }
  get capabilities() { return this.inner.capabilities; }
  health() { return this.inner.health(); }
  async enhance(req: EnhanceRequest) {
    this.hook?.(this.inner.calls);
    await new Promise((resolve) => setTimeout(resolve, this.ms));
    return this.inner.enhance(req);
  }
}

let n = 0;
interface Harness {
  service: JobService;
  store: Store;
  progress: JobProgress[];
  logs: Array<{ jobId: string; level: string; message: string }>;
  shown: ProviderId[];
  dir: string;
  adapter: FakeAdapter;
}

function harness(options: { modes?: FailureMode | FailureMode[]; delayMs?: number; status?: () => SessionStatus; hook?: (call: number) => void; dir?: string; throwOnEnhance?: boolean } = {}): Harness {
  const dir = options.dir ?? path.join(root, `h-${++n}`);
  mkdirSync(dir, { recursive: true });
  const progress: JobProgress[] = [];
  const logs: Harness['logs'] = [];
  const shown: ProviderId[] = [];
  const hooks: { service: JobService | null } = { service: null };
  const store = openStore(path.join(dir, 'jobs.sqlite'), { onCommit: (c) => hooks.service?.notify(c) });
  stores.push(store);
  const adapter = new FakeAdapter({ id: 'gemini', outputDir: path.join(dir, 'provider'), ...(options.modes ? { modes: options.modes } : {}) });
  const wrapped: ProviderAdapter = options.throwOnEnhance
    ? { id: 'gemini', capabilities: adapter.capabilities, health: () => adapter.health(), enhance: async () => { throw new Error('the page crashed'); } }
    : new Delayed(adapter, options.delayMs ?? 0, options.hook);
  const service = createJobService({
    store,
    dataDir: dir,
    adapterFor: async () => ({ adapter: wrapped }),
    sessionStatus: async () => options.status?.() ?? 'ready',
    showProvider: (id) => void shown.push(id),
    emitProgress: (p) => progress.push(p),
    emitLog: (l) => logs.push(l),
    runOptions: { sleep: async () => {} },
  });
  hooks.service = service;
  return { service, store, progress, logs, shown, dir, adapter };
}

const job = (id: string, providerId: ProviderId = 'gemini', over: Partial<Job> = {}): Job => ({
  id,
  createdAt: '2026-11-05T10:00:00.000Z',
  source: { path: source, width: 800, height: 400, sha256: 'a'.repeat(64) },
  prompt: 'Enhance this tile.',
  promptSource: 'user',
  categoryId: 'env-realistic',
  categorySource: 'user',
  grid: { rows: 1, cols: 4, overlapPct: 15 },
  providerId,
  ...over,
});

const waitFor = async (condition: () => boolean, ms = 10_000) => {
  const stop = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > stop) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('register and list', () => {
  it('saves a job with its plan, shows it in recent jobs, and keeps it across a restart', async () => {
    const h = harness();
    h.service.register(job('J1'));
    expect(h.service.get('J1')).toMatchObject({ jobId: 'J1', state: 'idle', providerId: 'gemini', totalTiles: 4, completedTiles: 0 });
    expect(h.service.listRecent()).toEqual([{ id: 'J1', createdAt: '2026-11-05T10:00:00.000Z', state: 'idle', completedTiles: 0, totalTiles: 4 }]);

    const dbPath = h.store.path;
    h.store.close();
    stores.pop();
    const again = harness({ dir: path.dirname(dbPath) });
    expect(again.service.listRecent().map((j) => j.id)).toEqual(['J1']);
  });

  it('plans a wrap job as a wrap plan', () => {
    const h = harness();
    h.service.register(job('W', 'gemini', { grid: { rows: 1, cols: 2, overlapPct: 10, wrap: true } }));
    expect(h.store.getJob('W')!.plan.wrap).toBe(true);
  });

  it('refuses unknown jobs with a typed error', async () => {
    const h = harness();
    expect(() => h.service.get('nope')).toThrow(JobServiceError);
    await expect(h.service.start('nope')).rejects.toMatchObject({ code: 'not-found' });
    expect(() => h.service.pause('nope')).toThrow(expect.objectContaining({ code: 'not-found' }));
    expect(() => h.service.cancel('nope')).toThrow(expect.objectContaining({ code: 'not-found' }));
  });
});

describe('running a job', () => {
  it('starts in the background, returns at once, and pushes progress as the tiles finish', async () => {
    const h = harness({ delayMs: 15 });
    h.service.register(job('J1'));
    const started = await h.service.start('J1');
    expect(['preflight', 'running']).toContain(started.state); // returned before the run finished
    expect(h.service.isRunning('J1')).toBe(true);

    await h.service.whenIdle();
    expect(h.service.get('J1')).toMatchObject({ state: 'done', completedTiles: 4 });

    // Events, not polling: the screen heard about every step.
    const completed = h.progress.map((p) => p.completedTiles);
    expect(completed).toEqual([...completed].sort((a, b) => a - b)); // never goes backwards
    expect(new Set(completed)).toEqual(new Set([0, 1, 2, 3, 4]));
    expect(h.progress.at(-1)).toMatchObject({ state: 'done', completedTiles: 4 });
    expect(h.progress.some((p) => p.state === 'running')).toBe(true);
    expect(h.logs.map((l) => l.message)).toEqual(expect.arrayContaining(['Job idle → preflight', 'Tile 1: running → accepted', 'Job stitching → done']));
    expect(h.logs.every((l) => l.jobId === 'J1')).toBe(true);
  });

  it('sends one message per burst of writes, not one per write', async () => {
    const h = harness();
    h.service.register(job('J1'));
    await Promise.resolve(); // let the creation notice go out
    h.progress.length = 0;
    h.store.transaction(() => {
      h.store.setJobState('J1', 'preflight');
      h.store.updateTile('J1', 0, { note: 'a' });
      h.store.updateTile('J1', 1, { note: 'b' });
    });
    await Promise.resolve();
    expect(h.progress).toHaveLength(1);
    expect(h.progress[0]!.state).toBe('preflight');
  });

  it('is blocked by preflight when the session is not ready, with the reason on the job', async () => {
    const h = harness({ status: () => 'logged-out' });
    h.service.register(job('J1'));
    await h.service.start('J1');
    await h.service.whenIdle();
    expect(h.adapter.calls).toBe(0);
    expect(h.service.get('J1')).toMatchObject({ state: 'idle', error: expect.stringMatching(/logged out/) });
  });

  it('cannot start twice: a second start of a running job just reports it', async () => {
    const h = harness({ delayMs: 20 });
    h.service.register(job('J1'));
    await h.service.start('J1');
    await h.service.start('J1');
    await h.service.whenIdle();
    expect(h.adapter.calls).toBe(4); // not 8
  });

  it('refuses to start a job that is not idle, or to resume one that is', async () => {
    const h = harness();
    h.service.register(job('J1'));
    await h.service.resume('J1').then(
      () => expect.unreachable(),
      (e) => expect(e).toMatchObject({ code: 'illegal', message: expect.stringMatching(/idle cannot be resumed/) }),
    );
    await h.service.start('J1');
    await h.service.whenIdle();
    await expect(h.service.start('J1')).rejects.toMatchObject({ code: 'illegal' });
  });

  it('does not run two jobs on the same provider at once', async () => {
    const h = harness({ delayMs: 30 });
    h.service.register(job('A'));
    h.service.register(job('B'));
    await h.service.start('A');
    await expect(h.service.start('B')).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/already using gemini/) });
    await h.service.whenIdle();
    await h.service.start('B'); // free again
    await h.service.whenIdle();
    expect(h.service.get('B').state).toBe('done');
  });

  it('turns an unexpected crash into a failed job with the reason, not a hung one', async () => {
    const h = harness({ throwOnEnhance: true });
    h.service.register(job('J1'));
    await h.service.start('J1');
    await h.service.whenIdle();
    expect(h.service.get('J1')).toMatchObject({ state: 'failed', error: expect.stringMatching(/stopped unexpectedly: the page crashed/) });
    expect(h.service.isRunning('J1')).toBe(false);
    expect(h.logs.some((l) => l.level === 'error' && /page crashed/.test(l.message))).toBe(true);
  });
});

describe('pause, resume and cancel', () => {
  it('pauses a running job after the current tile, and resumes it to the end', async () => {
    const h = harness({ delayMs: 40 });
    h.service.register(job('J1'));
    await h.service.start('J1');
    await waitFor(() => h.service.get('J1').completedTiles >= 1);

    expect(h.service.pause('J1').state).toBe('paused');
    await h.service.whenIdle();
    const paused = h.service.get('J1');
    expect(paused).toMatchObject({ state: 'paused', pauseReason: 'user' });
    expect(paused.completedTiles).toBeLessThan(4);
    const callsWhenPaused = h.adapter.calls;

    await h.service.resume('J1');
    await h.service.whenIdle();
    expect(h.service.get('J1')).toMatchObject({ state: 'done', completedTiles: 4 });
    expect(h.adapter.calls).toBe(4); // no tile was run twice (the fake never fails here)
    expect(callsWhenPaused).toBeLessThan(4);
  });

  it('cancels a running job for good and stops the run', async () => {
    const h = harness({ delayMs: 40 });
    h.service.register(job('J1'));
    await h.service.start('J1');
    await waitFor(() => h.adapter.calls >= 1);
    expect(h.service.cancel('J1').state).toBe('cancelled');
    await h.service.whenIdle();
    expect(h.service.get('J1').state).toBe('cancelled');
    expect(h.adapter.calls).toBeLessThan(4);
    await expect(h.service.resume('J1')).rejects.toMatchObject({ code: 'illegal' });
  });

  it('says so when a pause or cancel is not possible', () => {
    const h = harness();
    h.service.register(job('J1'));
    expect(() => h.service.pause('J1')).toThrow(expect.objectContaining({ code: 'illegal' })); // idle
    h.service.cancel('J1');
    expect(() => h.service.cancel('J1')).toThrow(expect.objectContaining({ code: 'illegal' }));
  });

  it.each([['challenge', true], ['logged-out', true], ['quota', false]] as const)('a %s pause %s bring the provider window forward', async (mode, shows) => {
    const h = harness({ modes: ['ok', mode] });
    h.service.register(job('J1'));
    await h.service.start('J1');
    await h.service.whenIdle();
    expect(h.service.get('J1')).toMatchObject({ state: 'paused', pauseReason: mode });
    expect(h.shown).toEqual(shows ? ['gemini'] : []);
    if (mode === 'quota') expect(h.service.get('J1').resumeAfter).toBeDefined();
  });

  it('a paused job resumes after the problem is fixed', async () => {
    const h = harness({ modes: ['ok', 'challenge', 'ok', 'ok', 'ok', 'ok'] });
    h.service.register(job('J1'));
    await h.service.start('J1');
    await h.service.whenIdle();
    expect(h.service.get('J1').state).toBe('paused');
    await h.service.resume('J1');
    await h.service.whenIdle();
    expect(h.service.get('J1')).toMatchObject({ state: 'done', completedTiles: 4 });
  });
});

describe('restart', () => {
  it('restores a job that was running, and resume continues without redoing accepted tiles', async () => {
    const h = harness({ delayMs: 30 });
    h.service.register(job('J1'));
    await h.service.start('J1');
    await waitFor(() => h.service.get('J1').completedTiles >= 2);

    // The "crash": the first service stops being used while the database keeps what was written.
    const dbPath = h.store.path;
    const accepted = h.store.listTiles('J1').filter((t) => t.state === 'accepted').map((t) => [t.index, t.outputPath]);
    h.store.close();
    stores.pop();
    await h.service.whenIdle().catch(() => {});

    const after = harness({ dir: path.dirname(dbPath) });
    const restored = after.service.restore();
    expect(restored).toHaveLength(1);
    expect(restored[0]!.accepted).toBeGreaterThanOrEqual(accepted.length);

    await after.service.resume('J1');
    await after.service.whenIdle();
    expect(after.service.get('J1')).toMatchObject({ state: 'done', completedTiles: 4 });
    for (const [index, output] of accepted) expect(after.store.getTile('J1', index as number)!.outputPath).toBe(output);
    expect(after.adapter.calls).toBeLessThanOrEqual(4 - accepted.length);
  });
});

describe('tile thumbnails', () => {
  it('returns a small picture of a finished tile, never larger than asked', async () => {
    const h = harness();
    h.service.register(job('J1'));
    await h.service.start('J1');
    await h.service.whenIdle();
    const thumb = await h.service.tileThumbnail('J1', 0, 64);
    expect(thumb.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(Math.max(thumb.width, thumb.height)).toBeLessThanOrEqual(64);
    expect((await h.service.tileThumbnail('J1', 1)).width).toBeGreaterThan(0);
  });

  it('shows the piece of the picture a waiting tile will be made from, once the job has prepared it', async () => {
    const h = harness({ modes: ['challenge'] });
    h.service.register(job('J1'));
    await h.service.start('J1');
    await h.service.whenIdle(); // paused on the first tile: its output does not exist, its source piece does
    expect((await h.service.tileThumbnail('J1', 0, 100)).width).toBeGreaterThan(0);
  });

  it('says so when there is nothing to show', async () => {
    const h = harness();
    h.service.register(job('J1'));
    await expect(h.service.tileThumbnail('J1', 0)).rejects.toMatchObject({ code: 'not-found' });
    await expect(h.service.tileThumbnail('J1', 99)).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('IPC handlers', () => {
  it('start, get, pause, resume and cancel answer with validated progress', async () => {
    const h = harness({ delayMs: 40 });
    h.service.register(job('J1'));
    const start = await handleJobsStart({ jobId: 'J1' }, h.service);
    expect(start).toEqual({ ok: true, value: { jobId: 'J1', state: 'preflight' } }); // just where it is; the rest comes as events
    await waitFor(() => h.service.get('J1').completedTiles >= 1);

    const got = await handleJobsGet({ jobId: 'J1' }, h.service);
    expect(got, JSON.stringify(got)).toMatchObject({ ok: true, value: { jobId: 'J1' } });
    const paused = await handleJobsPause({ jobId: 'J1' }, h.service);
    expect(paused, JSON.stringify(paused)).toMatchObject({ ok: true, value: { state: 'paused' } });
    await h.service.whenIdle();
    const resumed = await handleJobsResume({ jobId: 'J1' }, h.service);
    expect(resumed, JSON.stringify(resumed)).toMatchObject({ ok: true });
    const cancelled = await handleJobsCancel({ jobId: 'J1' }, h.service);
    expect(cancelled, JSON.stringify(cancelled)).toMatchObject({ ok: true, value: { state: 'cancelled' } });
    await h.service.whenIdle();
  });

  it.each([undefined, null, {}, { jobId: '' }, { jobId: 5 }])('refuse a malformed request %j', async (payload) => {
    const h = harness();
    for (const handler of [handleJobsStart, handleJobsPause, handleJobsResume, handleJobsCancel, handleJobsGet]) {
      expect(await handler(payload, h.service)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    }
  });

  it('report a refused action as invalid_request with the reason, and an unknown job the same way', async () => {
    const h = harness();
    h.service.register(job('J1'));
    expect(await handleJobsPause({ jobId: 'J1' }, h.service)).toMatchObject({ ok: false, error: { code: 'invalid_request', message: expect.stringMatching(/idle cannot take "PAUSE"/) } });
    expect(await handleJobsGet({ jobId: 'zzz' }, h.service)).toMatchObject({ ok: false, error: { code: 'invalid_request', message: expect.stringMatching(/no longer exists/) } });
  });

  it('list recent jobs, with an optional limit', () => {
    const h = harness();
    for (const id of ['A', 'B', 'C']) h.service.register(job(id, 'gemini', { createdAt: `2026-11-0${id.charCodeAt(0) - 64}T00:00:00.000Z` }));
    const all = handleJobsListRecent(undefined, h.service);
    expect(all.ok && all.value.map((j) => j.id)).toEqual(['C', 'B', 'A']);
    expect(handleJobsListRecent({ limit: 1 }, h.service)).toMatchObject({ ok: true, value: [{ id: 'C' }] });
    expect(handleJobsListRecent({ limit: 0 }, h.service)).toMatchObject({ ok: false });
  });

  it('serve tile thumbnails and refuse bad requests', async () => {
    const h = harness();
    h.service.register(job('J1'));
    await handleJobsStart({ jobId: 'J1' }, h.service);
    await h.service.whenIdle();
    expect(await handleJobsTileThumbnail({ jobId: 'J1', index: 0, maxSide: 80 }, h.service)).toMatchObject({ ok: true });
    expect(await handleJobsTileThumbnail({ jobId: 'J1', index: -1 }, h.service)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await handleJobsTileThumbnail({ jobId: 'J1', index: 40 }, h.service)).toMatchObject({ ok: false, error: { code: 'invalid_request', message: expect.stringMatching(/does not exist/) } });
  });

  it('create the job and save it, so Start can run it', async () => {
    const h = harness();
    const registry = createAssetRegistry();
    const asset: ImageAsset = { id: 'A1', path: source, width: 800, height: 400, sha256: 'a'.repeat(64) };
    registry.add(asset);
    const created = handleCreateAndRegisterJob({ assetId: 'A1', prompt: '', categoryId: 'env-realistic', grid: { rows: 1, cols: 4, overlapPct: 15 }, providerId: 'gemini' }, registry, h.service);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(h.service.get(created.value.id)).toMatchObject({ state: 'idle', totalTiles: 4 });
    expect(handleCreateAndRegisterJob({ nonsense: true }, registry, h.service)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(handleCreateAndRegisterJob({ assetId: 'zzz', prompt: '', categoryId: 'env-realistic', grid: { rows: 1, cols: 1, overlapPct: 0 }, providerId: 'gemini' }, registry, h.service)).toMatchObject({ ok: false });
  });

  it('say the job could not be saved when saving fails', () => {
    const registry = createAssetRegistry();
    registry.add({ id: 'A1', path: source, width: 800, height: 400, sha256: 'a'.repeat(64) });
    const broken = { register: vi.fn(() => { throw new Error('disk full'); }) } as unknown as JobService;
    expect(handleCreateAndRegisterJob({ assetId: 'A1', prompt: '', categoryId: 'env-realistic', grid: { rows: 1, cols: 1, overlapPct: 0 }, providerId: 'gemini' }, registry, broken)).toMatchObject({
      ok: false,
      error: { code: 'internal', message: expect.stringMatching(/could not be saved: disk full/) },
    });
  });
});
