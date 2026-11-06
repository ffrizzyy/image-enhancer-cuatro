import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { EnhanceRequest, Job, ProviderId, SessionStatus } from '@ie/contracts';
import { openStore, type Store } from '@ie/orchestrator';
import type { ProviderAdapter } from '@ie/providers';
import { FakeAdapter, type FailureMode } from '@ie/providers/fake';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  handleJobsAcceptTile,
  handleJobsFinishReview,
  handleJobsRerunTile,
  handleJobsResult,
  handleJobsSetTileOverride,
} from '../main/ipc/jobs.js';
import { handleExportSave } from '../main/ipc/export.js';
import { createJobService, type JobService } from '../main/jobService.js';

let root: string;
let source: string;
beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'ie-desktop-review-'));
  source = path.join(root, 'source.png');
  const data = Buffer.alloc(800 * 400 * 3);
  for (let y = 0; y < 400; y++) for (let x = 0; x < 800; x++) data.set([128 + 90 * Math.sin(x / 31), 110 + 70 * Math.cos(y / 23), 120 + 60 * Math.sin((x + y) / 41)], (y * 800 + x) * 3);
  await sharp(data, { raw: { width: 800, height: 400, channels: 3 } }).png().toFile(source);
});
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* the OS will clean up the temporary folder */
  }
});

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));

/** An adapter that returns a picture unrelated to the tile for chosen tiles (so the quality gate sets them aside). */
class Picky implements ProviderAdapter {
  /** Every request it was given, so a test can see which prompt and pictures were used. */
  readonly requests: EnhanceRequest[] = [];
  constructor(private readonly inner: FakeAdapter, private readonly badTiles: Set<number>, private readonly outDir: string) {}
  get id() { return this.inner.id; }
  get capabilities() { return this.inner.capabilities; }
  health() { return this.inner.health(); }
  async enhance(req: EnhanceRequest) {
    this.requests.push(req);
    const tilePath = req.attachments.find((a) => a.role === 'tile')!.path;
    const match = /tile-(\d+)(?:-source)?\.png$/.exec(tilePath);
    const tile = match ? Number(match[1]) : -1;
    if (!this.badTiles.has(tile)) return this.inner.enhance(req);
    mkdirSync(this.outDir, { recursive: true });
    const out = path.join(this.outDir, `bad-${tile}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    const meta = await sharp(tilePath).metadata();
    await sharp({ create: { width: (meta.width ?? 100) * 2, height: (meta.height ?? 100) * 2, channels: 3, background: '#e0e0e0' } })
      .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${(meta.width ?? 100) * 2}" height="${(meta.height ?? 100) * 2}"><circle cx="30%" cy="60%" r="25%" fill="#aa2222"/><rect x="60%" y="10%" width="30%" height="30%" fill="#2222aa"/></svg>`) }])
      .png()
      .toFile(out);
    return { imagePath: out, width: (meta.width ?? 100) * 2, height: (meta.height ?? 100) * 2, elapsedMs: 5 };
  }
}

let n = 0;
interface H {
  service: JobService;
  store: Store;
  bad: Set<number>;
  shown: ProviderId[];
  restored: ProviderId[];
  logs: string[];
  status: { value: SessionStatus };
  fake: FakeAdapter;
  adapter: Picky;
}

function harness(options: { modes?: FailureMode[]; bad?: number[]; autoResume?: { settleMs?: number; maxInARow?: number } } = {}): H {
  const dir = path.join(root, `h-${++n}`);
  mkdirSync(dir, { recursive: true });
  const hooks: { service: JobService | null } = { service: null };
  const store = openStore(path.join(dir, 'jobs.sqlite'), { onCommit: (c) => hooks.service?.notify(c) });
  stores.push(store);
  const fake = new FakeAdapter({ id: 'gemini', outputDir: path.join(dir, 'provider'), ...(options.modes ? { modes: options.modes } : {}) });
  const bad = new Set(options.bad ?? []);
  const adapter = new Picky(fake, bad, path.join(dir, 'bad'));
  const shown: ProviderId[] = [];
  const restored: ProviderId[] = [];
  const logs: string[] = [];
  const status = { value: 'ready' as SessionStatus };
  const service = createJobService({
    store,
    dataDir: dir,
    adapterFor: async () => ({ adapter }),
    sessionStatus: async () => status.value,
    showProvider: (id) => void shown.push(id),
    restoreWindow: (id) => void restored.push(id),
    emitProgress: () => {},
    emitLog: (l) => void logs.push(l.message),
    runOptions: { sleep: async () => {} },
    ...(options.autoResume ? { autoResume: options.autoResume } : {}),
  });
  hooks.service = service;
  return { service, store, bad, shown, restored, logs, status, fake, adapter };
}

const job = (id = 'J1', cols = 4): Job => ({
  id,
  createdAt: '2026-11-05T10:00:00.000Z',
  source: { path: source, width: 800, height: 400, sha256: 'a'.repeat(64) },
  prompt: 'Enhance this tile.',
  promptSource: 'user',
  categoryId: 'env-realistic',
  categorySource: 'user',
  grid: { rows: 1, cols, overlapPct: 15 },
  providerId: 'gemini',
});

const settle = async (h: H) => h.service.whenIdle();
const waitFor = async (condition: () => boolean, ms = 8000) => {
  const stop = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > stop) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('review: a tile the provider could not get right', () => {
  it('ends the run in needs-review with the best attempt kept for the person to look at', async () => {
    const h = harness({ bad: [1] });
    h.service.register(job());
    await h.service.start('J1');
    await settle(h);

    const progress = h.service.get('J1');
    expect(progress.state).toBe('needs-review');
    expect(progress.tiles.map((t) => t.state)).toEqual(['accepted', 'needs-review', 'accepted', 'accepted']);
    const tile = progress.tiles[1]!;
    expect(tile.outputPath).toBeDefined(); // something to look at
    expect(tile.note).toMatch(/no longer matches the source tile/);
    expect((await h.service.tileThumbnail('J1', 1, 100)).width).toBeGreaterThan(0);
  });

  it('Accept as is keeps that picture, and the picture can then be put together', async () => {
    const h = harness({ bad: [1] });
    h.service.register(job());
    await h.service.start('J1');
    await settle(h);
    const kept = h.service.get('J1').tiles[1]!.outputPath;

    const afterAccept = h.service.acceptTile('J1', 1);
    expect(afterAccept.tiles[1]).toMatchObject({ state: 'accepted', outputPath: kept });
    expect(afterAccept.state).toBe('needs-review'); // the job waits for the person to say go

    await h.service.finishReview('J1');
    await settle(h);
    expect(h.service.get('J1')).toMatchObject({ state: 'done', completedTiles: 4 });
    expect(h.fake.calls).toBe(3); // the tile kept as is was not generated again
  });

  it('Try again runs only that tile, with a fresh set of retries, and carries on to the end', async () => {
    const h = harness({ bad: [2] });
    h.service.register(job());
    await h.service.start('J1');
    await settle(h);
    expect(h.service.get('J1').tiles[2]!.state).toBe('needs-review');
    const callsBefore = h.fake.calls;

    h.bad.clear(); // the provider does better this time
    await h.service.rerunTile('J1', 2);
    await settle(h);

    expect(h.service.get('J1')).toMatchObject({ state: 'done', completedTiles: 4 });
    expect(h.fake.calls).toBe(callsBefore + 1); // exactly one more generation, for that tile
    expect(h.store.getTile('J1', 2)!.attempts).toBeGreaterThan(3); // its history is kept
  });

  it('can be tried again repeatedly and still be accepted as is at the end', async () => {
    const h = harness({ bad: [0] });
    h.service.register(job());
    await h.service.start('J1');
    await settle(h);
    await h.service.rerunTile('J1', 0);
    await settle(h);
    expect(h.service.get('J1')).toMatchObject({ state: 'needs-review' });
    h.service.acceptTile('J1', 0);
    await h.service.finishReview('J1');
    await settle(h);
    expect(h.service.get('J1').state).toBe('done');
  });

  it('will not put the picture together while a tile is still undecided, and says which', async () => {
    const h = harness({ bad: [1, 3] });
    h.service.register(job());
    await h.service.start('J1');
    await settle(h);
    h.service.acceptTile('J1', 1);
    await expect(h.service.finishReview('J1')).rejects.toMatchObject({ code: 'illegal', message: expect.stringMatching(/Tile 4 still needs a decision/) });
    expect(h.service.get('J1').state).toBe('needs-review');
  });

  it('refuses to accept a tile that is not waiting for review', async () => {
    const h = harness({ bad: [1] });
    h.service.register(job());
    await h.service.start('J1');
    await settle(h);
    expect(() => h.service.acceptTile('J1', 0)).toThrow(expect.objectContaining({ code: 'illegal', message: expect.stringMatching(/accepted/) }));
    expect(() => h.service.acceptTile('J1', 99)).toThrow(expect.objectContaining({ code: 'not-found' }));
    expect(() => h.service.acceptTile('nope', 0)).toThrow(expect.objectContaining({ code: 'not-found' }));
  });

  it('finishing a review is only for a job that is waiting for one', async () => {
    const h = harness();
    h.service.register(job());
    await expect(h.service.finishReview('J1')).rejects.toMatchObject({ code: 'illegal' });
    await h.service.start('J1');
    await settle(h);
    await expect(h.service.finishReview('J1')).rejects.toMatchObject({ code: 'illegal', message: expect.stringMatching(/done is not waiting/) });
  });

  it('a finished job can have one tile re-run too', async () => {
    const h = harness();
    h.service.register(job());
    await h.service.start('J1');
    await settle(h);
    expect(h.service.get('J1').state).toBe('done');
    await h.service.rerunTile('J1', 1);
    await settle(h);
    expect(h.service.get('J1').state).toBe('done');
    expect(h.fake.calls).toBe(5);
  });

  it('answers through the IPC handlers with validated progress, and refuses bad requests', async () => {
    const h = harness({ bad: [1] });
    h.service.register(job());
    await h.service.start('J1');
    await settle(h);

    expect(await handleJobsAcceptTile({ jobId: 'J1', index: 1 }, h.service)).toMatchObject({ ok: true, value: { jobId: 'J1' } });
    expect(await handleJobsAcceptTile({ jobId: 'J1', index: 1 }, h.service)).toMatchObject({ ok: false, error: { code: 'invalid_request', message: expect.stringMatching(/Only a tile that needs review/) } });
    expect(await handleJobsAcceptTile({ jobId: 'J1', index: -1 }, h.service)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await handleJobsRerunTile({ nonsense: 1 }, h.service)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await handleJobsFinishReview({ jobId: 'J1' }, h.service)).toMatchObject({ ok: true });
    await settle(h);
    expect(await handleJobsFinishReview(undefined, h.service)).toMatchObject({ ok: false });
  });
});

describe('per-tile overrides and the Result screen', () => {
  it('keeps the stitched picture and its metrics, and serves previews over IPC', async () => {
    const h = harness();
    h.service.register(job());
    await expect(h.service.result('J1')).rejects.toMatchObject({ code: 'illegal', message: expect.stringMatching(/not been put together/) });

    await h.service.start('J1');
    await settle(h);
    const result = await h.service.result('J1', 512);
    expect(result).toMatchObject({ jobId: 'J1', width: 800, height: 400 });
    expect(result.plan.tiles).toHaveLength(4);
    expect(result.preview.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(result.sourcePreview.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(Math.max(result.preview.width, result.preview.height)).toBeLessThanOrEqual(512);
    expect(result.metrics.seamScore).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(result.stitchedAt))).toBe(false);
    expect(h.service.get('J1').result).toMatchObject({ stitchedAt: result.stitchedAt, flagged: result.flagged });

    const viaIpc = await handleJobsResult({ jobId: 'J1', maxSide: 512 }, h.service);
    expect(viaIpc).toMatchObject({ ok: true, value: { jobId: 'J1', stitchedAt: result.stitchedAt } });
    expect(await handleJobsResult({ jobId: 'J1', maxSide: 10 }, h.service)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await handleJobsResult({ jobId: 'nope' }, h.service)).toMatchObject({ ok: false, error: { code: 'invalid_request', message: expect.stringMatching(/no longer exists/) } });
  });

  it('exports the stitched picture through the save handler', async () => {
    const h = harness();
    h.service.register(job());
    await h.service.start('J1');
    await settle(h);

    const imagePath = h.service.get('J1').result!.imagePath;
    const destination = path.join(root, `export-${++n}.jpg`);
    expect(await handleExportSave({ imagePath, format: 'jpeg', quality: 80 }, h.service, async () => destination)).toMatchObject({
      ok: true,
      value: { path: destination },
    });
    const meta = await sharp(destination).metadata();
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([800, 400]);

    // Cancelling the save dialog is reported as a cancellation, not an error.
    expect(await handleExportSave({ imagePath, format: 'png' }, h.service, async () => null)).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });

    // Only a picture this app produced can be exported.
    expect(await handleExportSave({ imagePath: source, format: 'png' }, h.service, async () => path.join(root, 'nope.png'))).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });

  it('keeps a tile’s own prompt and uses it the next time that tile runs', async () => {    const h = harness();
    h.service.register(job());
    await h.service.start('J1');
    await settle(h);

    const changed = await h.service.setTileOverride('J1', 1, { prompt: '  Keep this part matte and desaturated.  ' });
    expect(changed.tiles[1]!.promptOverride).toBe('Keep this part matte and desaturated.');
    expect(h.store.getTile('J1', 1)!.promptOverride).toBe('Keep this part matte and desaturated.');

    const callsBefore = h.fake.calls;
    await h.service.rerunTile('J1', 1);
    await settle(h);
    expect(h.fake.calls).toBe(callsBefore + 1);
    const last = h.adapter.requests.at(-1)!;
    expect(last.prompt).toContain('Keep this part matte and desaturated.');
    expect(last.prompt).not.toContain('Enhance this tile.');

    // An empty prompt goes back to the job's own prompt.
    const cleared = await h.service.setTileOverride('J1', 1, { prompt: '' });
    expect(cleared.tiles[1]!.promptOverride).toBeUndefined();
    expect(h.store.getTile('J1', 1)!.promptOverride).toBeNull();
  });

  it('prepares, uses and clears a tile’s own source picture', async () => {
    const h = harness();
    h.service.register(job());
    await h.service.start('J1');
    await settle(h);

    const replacement = path.join(root, `replacement-${++n}.png`);
    await sharp({ create: { width: 90, height: 60, channels: 3, background: '#cc3366' } }).png().toFile(replacement);
    const changed = await h.service.setTileOverride('J1', 1, { sourcePath: replacement });
    const stored = changed.tiles[1]!.sourceOverride!;
    expect(stored).toMatch(/tile-001-source\.png$/);
    expect(existsSync(stored)).toBe(true);

    const send = h.store.getJob('J1')!.plan.tiles[1]!.send;
    const meta = await sharp(stored).metadata();
    expect([meta.width, meta.height]).toEqual([send.width, send.height]);

    const callsBefore = h.fake.calls;
    await h.service.rerunTile('J1', 1);
    await settle(h);
    expect(h.fake.calls).toBe(callsBefore + 1);
    const last = h.adapter.requests.at(-1)!;
    expect(last.attachments.find((a) => a.role === 'tile')!.path).toBe(stored);

    const cleared = await h.service.setTileOverride('J1', 1, { sourcePath: null });
    expect(cleared.tiles[1]!.sourceOverride).toBeUndefined();
    expect(existsSync(stored)).toBe(false);
  });

  it('answers override requests through IPC and refuses bad ones', async () => {
    const h = harness();
    h.service.register(job());
    await h.service.start('J1');
    await settle(h);

    expect(await handleJobsSetTileOverride({ jobId: 'J1', index: 2, prompt: 'Warmer light.' }, h.service)).toMatchObject({ ok: true, value: { jobId: 'J1' } });
    expect(h.service.get('J1').tiles[2]!.promptOverride).toBe('Warmer light.');

    expect(await handleJobsSetTileOverride({ jobId: 'J1', index: 2, prompt: 'x'.repeat(2001) }, h.service)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await handleJobsSetTileOverride({ jobId: 'J1', index: -1 }, h.service)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await handleJobsSetTileOverride({ jobId: 'J1', index: 99, prompt: 'x' }, h.service)).toMatchObject({ ok: false, error: { code: 'invalid_request', message: expect.stringMatching(/does not exist/) } });
    expect(await handleJobsSetTileOverride(undefined, h.service)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });
});

describe('auto resume', () => {
  it('resumes by itself once the session monitor reports the provider ready again', async () => {
    const h = harness({ modes: ['ok', 'challenge', 'ok', 'ok', 'ok'], autoResume: { settleMs: 60_000 } });
    h.service.register(job());
    await h.service.start('J1');
    await settle(h);
    expect(h.service.get('J1')).toMatchObject({ state: 'paused', pauseReason: 'challenge' });
    expect(h.shown).toEqual(['gemini']); // the person is called to the window

    h.status.value = 'challenge'; // the monitor sees the check
    h.service.onSessionStatus('gemini', 'challenge');
    await new Promise((r) => setTimeout(r, 700));
    expect(h.service.get('J1').state).toBe('paused'); // still waiting for the person

    h.status.value = 'ready'; // they solved it
    h.service.onSessionStatus('gemini', 'ready');
    await waitFor(() => h.service.get('J1').state === 'done');
    expect(h.service.get('J1').completedTiles).toBe(4);
    expect(h.restored).toEqual(['gemini']); // and the window goes back to how they want it
    expect(h.logs).toContain('Resuming by itself: the provider looks fine again.');
  });

  it('does not resume for a pause the user asked for', async () => {
    const h = harness();
    h.service.register(job());
    await h.service.start('J1');
    await waitFor(() => h.fake.calls >= 1);
    h.service.pause('J1');
    await settle(h);
    h.service.onSessionStatus('gemini', 'ready');
    await new Promise((r) => setTimeout(r, 700));
    expect(h.service.get('J1')).toMatchObject({ state: 'paused', pauseReason: 'user' });
  });

  it('ignores a provider that is still not ready', async () => {
    const h = harness({ modes: ['ok', 'logged-out'], autoResume: { settleMs: 60_000 } });
    h.service.register(job());
    await h.service.start('J1');
    await settle(h);
    h.service.onSessionStatus('gemini', 'logged-out');
    h.service.onSessionStatus('gemini', 'unknown');
    await new Promise((r) => setTimeout(r, 700));
    expect(h.service.get('J1').state).toBe('paused');
  });

  it('when the provider already looks ready after a pause, tries again soon by itself', async () => {
    const h = harness({ modes: ['ok', 'challenge'], autoResume: { settleMs: 60 } });
    h.service.register(job());
    await h.service.start('J1');
    await waitFor(() => h.service.get('J1').state === 'done');
    expect(h.shown.length).toBeGreaterThanOrEqual(1);
    expect(h.service.get('J1').completedTiles).toBe(4);
  });

  it('gives up after a few tries in a row with no tile finishing, so it cannot loop forever', async () => {
    const h = harness({ modes: ['challenge'], autoResume: { settleMs: 20, maxInARow: 2 } });
    h.service.register(job());
    await h.service.start('J1');
    await waitFor(() => h.logs.some((m) => /keeps pausing for the same reason/.test(m)));
    await settle(h);
    expect(h.service.get('J1').state).toBe('paused');
    expect(h.fake.calls).toBe(3); // the first try, plus two automatic ones
  });

  it('resets the count when a tile finishes in between', async () => {
    const h = harness({ modes: ['ok', 'challenge', 'ok', 'challenge', 'ok', 'challenge', 'ok', 'ok'], autoResume: { settleMs: 20, maxInARow: 1 } });
    h.service.register(job());
    await h.service.start('J1');
    await waitFor(() => h.service.get('J1').state === 'done');
    expect(h.service.get('J1').completedTiles).toBe(4);
  });

  it('resumes after a usage limit once its time has passed, not before', async () => {
    // The clock the runner uses is set an hour back, so the limit "resets" about 300 ms from now.
    const h = harness({ modes: ['ok', 'quota'] });
    h.service.register(job());
    // Rebuild with a shifted clock: harness() has no hook, so patch the run options through a second service.
    const shifted = createJobService({
      store: h.store,
      dataDir: path.join(root, `q-${++n}`),
      adapterFor: async () => ({ adapter: new Picky(h.fake, new Set(), path.join(root, 'bad-q')) }),
      sessionStatus: async () => 'ready',
      emitProgress: () => {},
      emitLog: () => {},
      runOptions: { sleep: async () => {}, now: () => new Date(Date.now() - 3_600_000 + 300) },
    });
    await shifted.start('J1');
    await shifted.whenIdle();
    expect(shifted.get('J1')).toMatchObject({ state: 'paused', pauseReason: 'quota' });
    const stillWaiting = shifted.get('J1').state; // right away: the time has not come
    expect(stillWaiting).toBe('paused');
    await waitFor(() => shifted.get('J1').state === 'done');
  });

  it('cancelling a paused job stops it resuming by itself', async () => {
    const h = harness({ modes: ['ok', 'challenge'], autoResume: { settleMs: 80 } });
    h.service.register(job());
    await h.service.start('J1');
    await settle(h);
    h.service.cancel('J1');
    await new Promise((r) => setTimeout(r, 250));
    expect(h.service.get('J1').state).toBe('cancelled');
  });
});