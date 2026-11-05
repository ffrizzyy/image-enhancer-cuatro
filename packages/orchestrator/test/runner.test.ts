import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getCategory } from '@ie/presets';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  applyTileEvent,
  DEFAULT_PACING,
  MAX_ATTEMPTS,
  NEIGHBOR_NOTE,
  PRESERVE_COMPOSITION_CLAUSE,
  QUOTA_RESUME_AFTER_MS,
  REFERENCE_MAX_PX,
  REFERENCE_NOTE,
  restoreJobs,
  runJob,
  openStore,
  SOFTENED_USER_PROMPT,
  type RunJobOptions,
  type Store,
} from '../src';
import { ScriptedAdapter, setupJob, type JobSetup, type Step } from './support/scripted';

let root: string;
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ie-orch-runner-'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));

let n = 0;
async function setup(options: Parameters<typeof setupJob>[1] = {}): Promise<JobSetup> {
  const s = await setupJob(path.join(root, `t-${++n}`), options);
  stores.push(s.store);
  return s;
}

const base = (s: JobSetup, adapter: ScriptedAdapter, extra: Partial<RunJobOptions> = {}): RunJobOptions => ({
  store: s.store,
  jobId: s.job.id,
  adapter,
  workDir: s.workDir,
  getSessionStatus: async () => 'ready',
  sleep: async () => {},
  ...extra,
});
const adapterFor = (s: JobSetup, script?: readonly Step[] | ((call: number, req: never, tile: number) => Step), extra: object = {}) =>
  new ScriptedAdapter({ outputDir: path.join(s.dir, 'provider'), ...(script ? { script: script as never } : {}), ...extra });
const states = (s: JobSetup) => s.store.listTiles(s.job.id).map((t) => t.state);

describe('a job that goes well', () => {
  it('runs every tile in raster order, one at a time, then stitches', async () => {
    const s = await setup({ cols: 4 });
    const adapter = adapterFor(s, undefined, { delayMs: 5 });
    const result = await runJob(base(s, adapter));

    expect(result.state).toBe('done');
    expect(adapter.calls.map((c) => c.tile)).toEqual([0, 1, 2, 3]);
    expect(adapter.maxInFlight).toBe(1);
    expect(states(s)).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
    expect(result.stitched).toBeDefined();
    expect(existsSync(result.stitched!.imagePath)).toBe(true);
    expect(result.stitched!.flagged).toEqual([]);
    expect(s.store.getJob('J1')!.state).toBe('done');
  });

  it('records each tile output, attempt and state change before moving on', async () => {
    const s = await setup({ cols: 2 });
    await runJob(base(s, adapterFor(s)));
    for (const tile of s.store.listTiles('J1')) {
      expect(tile.outputPath).toMatch(new RegExp(`tile-00${tile.index}-try1\\.png$`));
      expect(existsSync(tile.outputPath!)).toBe(true);
    }
    expect(s.store.listAttempts('J1').map((a) => a.outcome)).toEqual(['ok', 'ok']);
    expect(s.store.listEvents('J1').map((e) => e.message)).toEqual(expect.arrayContaining(['Job idle → preflight', 'Job preflight → running', 'Tile 1: pending → running (attempt 1)', 'Tile 1: running → accepted', 'Tile 2: running → accepted', 'Job running → stitching', 'Job stitching → done']));
  });

  it('waits a random time between tiles, within the pacing range, and not after the last tile', async () => {
    const s = await setup({ cols: 3 });
    const sleep = vi.fn(async () => {});
    const random = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(1);
    await runJob(base(s, adapterFor(s), { sleep, random, pacing: { concurrency: 1, minDelayMs: 8000, maxDelayMs: 25_000 } }));
    expect(sleep.mock.calls.map((c) => (c as unknown as number[])[0])).toEqual([8000, 25_000]); // two gaps for three tiles
  });

  it('uses the default pacing of 8 to 25 seconds', () => {
    expect(DEFAULT_PACING).toEqual({ concurrency: 1, minDelayMs: 8000, maxDelayMs: 25_000 });
  });
});

describe('what each call is given', () => {
  it('sends the tile and a downscaled whole-picture reference first, with the position in words', async () => {
    const s = await setup({ cols: 4 });
    const adapter = adapterFor(s);
    await runJob(base(s, adapter));

    const first = adapter.calls[0]!;
    expect(first.attachments.map((a) => a.role)).toEqual(['tile', 'global-reference']);
    expect(first.attachments[0]!.path).toMatch(/tile-000\.png$/);
    expect(first.prompt).toContain(REFERENCE_NOTE);
    expect(first.prompt).not.toContain(NEIGHBOR_NOTE);
    expect(first.prompt).toContain('POSITION: this tile is'); // from the category's prompt builder
    expect(first.prompt).toContain('Enhance this tile.'); // the user's text

    const reference = await sharp(first.attachments[1]!.path).metadata();
    expect(Math.max(reference.width!, reference.height!)).toBeLessThanOrEqual(REFERENCE_MAX_PX);
    expect(reference.width! / reference.height!).toBeCloseTo(800 / 300, 1);
  });

  it('in chained mode adds the finished neighbour strip from the second tile on', async () => {
    const s = await setup({ cols: 4, mode: 'chained' });
    const adapter = adapterFor(s);
    await runJob(base(s, adapter));

    expect(adapter.calls.map((c) => c.attachments.map((a) => a.role))).toEqual([
      ['tile', 'global-reference'],
      ['tile', 'global-reference', 'neighbor'],
      ['tile', 'global-reference', 'neighbor'],
      ['tile', 'global-reference', 'neighbor'],
    ]);
    expect(adapter.calls[1]!.prompt).toContain(NEIGHBOR_NOTE);
    const strip = await sharp(adapter.calls[1]!.attachments[2]!.path).metadata();
    expect(strip.width).toBeGreaterThan(0);
    expect(adapter.calls[1]!.attachments[2]!.path).toMatch(/strip-001-from-000\.png$/); // taken from the tile on its left
  });

  it('in independent mode sends no neighbour strip', async () => {
    const s = await setup({ cols: 3, mode: 'independent' });
    const adapter = adapterFor(s);
    await runJob(base(s, adapter));
    expect(adapter.calls.every((c) => c.attachments.map((a) => a.role).join() === 'tile,global-reference')).toBe(true);
  });

  it('drops the strip, then the reference, for a provider that takes fewer attachments, but never the tile', async () => {
    for (const [max, expected] of [[2, ['tile', 'global-reference']], [1, ['tile']]] as const) {
      const s = await setup({ cols: 2 });
      const adapter = adapterFor(s, undefined, { maxAttachments: max });
      await runJob(base(s, adapter));
      expect(adapter.calls[1]!.attachments.map((a) => a.role), `max ${max}`).toEqual(expected);
    }
  });

  it('uses a tile-specific prompt override instead of the job prompt', async () => {
    const s = await setup({ cols: 2 });
    s.store.updateTile('J1', 1, { promptOverride: 'Keep this part matte and desaturated.' });
    const adapter = adapterFor(s);
    await runJob(base(s, adapter));
    expect(adapter.calls[0]!.prompt).toContain('Enhance this tile.');
    expect(adapter.calls[1]!.prompt).toContain('Keep this part matte and desaturated.');
    expect(adapter.calls[1]!.prompt).not.toContain('Enhance this tile.');
  });
});

describe('preflight', () => {
  it('blocks the run, with the reason and a cost preview, when the session is not ready', async () => {
    for (const status of ['logged-out', 'challenge', 'quota-limited', 'unknown'] as const) {
      const s = await setup({ cols: 2 });
      const adapter = adapterFor(s);
      const result = await runJob(base(s, adapter, { getSessionStatus: async () => status }));

      expect(result.state).toBe('idle');
      expect(adapter.calls).toHaveLength(0); // nothing was generated
      expect(result.preflight).toMatchObject({ ok: false, cost: { tiles: 2 } });
      expect(result.message).toMatch(/logged out|human check|usage limit|not been checked/);
      expect(s.store.getJob('J1')!.error).toBe(result.message);
    }
  });

  it('blocks when the provider page no longer matches, naming what is missing', async () => {
    const s = await setup({ cols: 2 });
    const adapter = adapterFor(s, undefined, { health: { ok: false, missingSelectors: ['promptInput', 'submitButton'] } });
    const result = await runJob(base(s, adapter));
    expect(result.state).toBe('idle');
    expect(result.message).toMatch(/missing: promptInput, submitButton/);
  });

  it('can be started again once the problem is fixed', async () => {
    const s = await setup({ cols: 2 });
    let status: 'logged-out' | 'ready' = 'logged-out';
    const adapter = adapterFor(s);
    expect((await runJob(base(s, adapter, { getSessionStatus: async () => status }))).state).toBe('idle');
    status = 'ready';
    expect((await runJob(base(s, adapter, { getSessionStatus: async () => status }))).state).toBe('done');
  });

  it('gives a cost preview: tiles, rough time, and what is used on the account', async () => {
    const s = await setup({ cols: 4 });
    const result = await runJob(base(s, adapterFor(s)));
    expect(result.preflight!.cost).toMatchObject({ tiles: 4, estimatedMinutes: expect.any(Number) });
    expect(result.preflight!.cost.estimatedMinutes).toBeGreaterThanOrEqual(1);
    expect(result.preflight!.cost.quotaNote).toMatch(/4 image generations on your gemini account/);
  });
});

describe('retries and review', () => {
  it('retries a picture that fails the quality gate with the preserve-composition clause, then accepts a good one', async () => {
    const s = await setup({ cols: 1 });
    const adapter = adapterFor(s, [{ do: 'bad' }, { do: 'ok' }]);
    const result = await runJob(base(s, adapter));

    expect(result.state).toBe('done');
    expect(adapter.calls[0]!.prompt).not.toContain(PRESERVE_COMPOSITION_CLAUSE);
    expect(adapter.calls[1]!.prompt).toContain(PRESERVE_COMPOSITION_CLAUSE);
    expect(s.store.listAttempts('J1', 0).map((a) => a.outcome)).toEqual(['rejected', 'ok']);
    expect(s.store.getTile('J1', 0)).toMatchObject({ state: 'accepted', attempts: 2, note: null });
  });

  it(`after ${MAX_ATTEMPTS} failed tries sets the tile aside for review, never accepting it, and keeps its best output`, async () => {
    const s = await setup({ cols: 2 });
    const adapter = adapterFor(s, (_call, _req, tile) => (tile === 0 ? { do: 'bad' } : { do: 'ok' }));
    const result = await runJob(base(s, adapter));

    expect(result.state).toBe('needs-review');
    expect(states(s)).toEqual(['needs-review', 'accepted']);
    const tile = s.store.getTile('J1', 0)!;
    expect(tile.attempts).toBe(MAX_ATTEMPTS);
    expect(tile.note).toMatch(/no longer matches the source tile/);
    expect(existsSync(tile.outputPath!)).toBe(true); // the reviewer can look at it
    expect(adapter.calls.filter((c) => c.tile === 0)).toHaveLength(MAX_ATTEMPTS);
    expect(result.stitched).toBeUndefined();
  });

  it('retries after a timeout or a failed download, using up tries', async () => {
    const s = await setup({ cols: 1 });
    const adapter = adapterFor(s, [{ do: 'error', kind: 'timeout' }, { do: 'error', kind: 'download-failed' }, { do: 'ok' }]);
    expect((await runJob(base(s, adapter))).state).toBe('done');
    expect(s.store.listAttempts('J1', 0).map((a) => [a.outcome, a.errorKind])).toEqual([['error', 'timeout'], ['error', 'download-failed'], ['ok', null]]);
  });

  it('a refusal is retried once with softer wording; a second refusal needs a person', async () => {
    const s = await setup({ cols: 1 });
    const adapter = adapterFor(s, [{ do: 'error', kind: 'refusal' }, { do: 'error', kind: 'refusal' }]);
    const result = await runJob(base(s, adapter));

    expect(result.state).toBe('needs-review');
    expect(adapter.calls).toHaveLength(2); // not three: the second refusal is final
    expect(adapter.calls[0]!.prompt).not.toContain(SOFTENED_USER_PROMPT);
    expect(adapter.calls[1]!.prompt).toContain(SOFTENED_USER_PROMPT);
    expect(adapter.calls[1]!.prompt).not.toContain('Enhance this tile.');
    expect(s.store.getTile('J1', 0)!.state).toBe('needs-review');
  });

  it('a refusal followed by success is accepted', async () => {
    const s = await setup({ cols: 1 });
    expect((await runJob(base(s, adapterFor(s, [{ do: 'error', kind: 'refusal' }, { do: 'ok' }])))).state).toBe('done');
  });

  it('after review a person can re-run the tile and the job finishes without touching the others', async () => {
    const s = await setup({ cols: 3 });
    const failing = adapterFor(s, (_c, _r, tile) => (tile === 1 ? { do: 'bad' } : { do: 'ok' }));
    expect((await runJob(base(s, failing))).state).toBe('needs-review');
    const acceptedOutputs = s.store.listTiles('J1').filter((t) => t.state === 'accepted').map((t) => t.outputPath);

    applyTileEvent(s.store, 'J1', 1, { type: 'RERUN' });
    const second = adapterFor(s);
    const result = await runJob(base(s, second));

    expect(result.state).toBe('done');
    expect(second.calls.map((c) => c.tile)).toEqual([1]); // only the re-run tile
    expect(s.store.listTiles('J1').filter((t) => t.index !== 1).map((t) => t.outputPath)).toEqual(acceptedOutputs);
    expect(s.store.getTile('J1', 1)).toMatchObject({ state: 'accepted', attempts: MAX_ATTEMPTS + 1 });
  });
});

describe('when the provider needs the user', () => {
  it.each([['challenge'], ['logged-out']] as const)('pauses on %s, queues the tile again and resumes where it stopped', async (kind) => {
    const s = await setup({ cols: 3 });
    const first = adapterFor(s, (call) => (call === 1 ? { do: 'error', kind } : { do: 'ok' }));
    const paused = await runJob(base(s, first));

    expect(paused.state).toBe('paused');
    expect(s.store.getJob('J1')).toMatchObject({ state: 'paused', pauseReason: kind, resumeAfter: null });
    expect(states(s)).toEqual(['accepted', 'pending', 'pending']); // the cut-off tile is back in the queue
    expect(s.store.getTile('J1', 1)!.attempts).toBe(1);
    expect(first.calls).toHaveLength(2); // and nothing else ran: no busy loop

    const second = adapterFor(s);
    const done = await runJob(base(s, second));
    expect(done.state).toBe('done');
    expect(second.calls.map((c) => c.tile)).toEqual([1, 2]); // tile 0 was not run again
  });

  it('pauses on a usage limit with a time to resume after', async () => {
    const s = await setup({ cols: 2 });
    const at = new Date('2026-11-05T12:00:00.000Z');
    const paused = await runJob(base(s, adapterFor(s, [{ do: 'error', kind: 'quota' }]), { now: () => at }));
    expect(paused.state).toBe('paused');
    expect(s.store.getJob('J1')).toMatchObject({ pauseReason: 'quota', resumeAfter: new Date(at.getTime() + QUOTA_RESUME_AFTER_MS).toISOString() });
  });

  it('fails the job, naming the missing selector, when the provider page has changed', async () => {
    const s = await setup({ cols: 3 });
    const result = await runJob(base(s, adapterFor(s, [{ do: 'ok' }, { do: 'error', kind: 'ui-changed', message: 'The page no longer matches.', selector: 'submitButton' }])));
    expect(result.state).toBe('failed');
    expect(result.message).toMatch(/selector: submitButton/);
    expect(s.store.getJob('J1')).toMatchObject({ state: 'failed', error: expect.stringContaining('submitButton') });
    expect(states(s)).toEqual(['accepted', 'failed', 'pending']);
  });

  it('a failed job cannot be run again', async () => {
    const s = await setup({ cols: 1 });
    await runJob(base(s, adapterFor(s, [{ do: 'error', kind: 'ui-changed' }])));
    const adapter = adapterFor(s);
    expect((await runJob(base(s, adapter))).state).toBe('failed');
    expect(adapter.calls).toHaveLength(0);
  });
});

describe('modes', () => {
  it('independent jobs run two tiles at a time when pacing allows', async () => {
    const s = await setup({ cols: 4, mode: 'independent' });
    const adapter = adapterFor(s, undefined, { delayMs: 30 });
    const result = await runJob(base(s, adapter, { pacing: { concurrency: 2, minDelayMs: 0, maxDelayMs: 0 } }));
    expect(result.state).toBe('done');
    expect(adapter.maxInFlight).toBe(2);
  });

  it('chained jobs stay at one tile at a time even if pacing asks for two', async () => {
    const s = await setup({ cols: 4, mode: 'chained' });
    const adapter = adapterFor(s, undefined, { delayMs: 20 });
    await runJob(base(s, adapter, { pacing: { concurrency: 2, minDelayMs: 0, maxDelayMs: 0 } }));
    expect(adapter.maxInFlight).toBe(1);
  });
});

describe('cancel, crash and stitching', () => {
  it('cancelling stops the job between tiles, and it stays cancelled', async () => {
    const s = await setup({ cols: 4 });
    const controller = new AbortController();
    const adapter = adapterFor(s);
    const result = await runJob(base(s, adapter, { signal: controller.signal, onTile: (index) => index === 1 && controller.abort() }));

    expect(result.state).toBe('cancelled');
    expect(adapter.calls.map((c) => c.tile)).toEqual([0, 1]);
    expect(s.store.getJob('J1')!.state).toBe('cancelled');
    expect((await runJob(base(s, adapterFor(s)))).state).toBe('cancelled');
  });

  it('after a crash mid-tile, a restart continues from that tile and never re-runs accepted ones', async () => {
    const s = await setup({ cols: 4 });
    const crashing = adapterFor(s, (call) => (call === 2 ? { do: 'crash' } : { do: 'ok' }));
    await expect(runJob(base(s, crashing))).rejects.toThrow('The process died.');
    expect(states(s)).toEqual(['accepted', 'accepted', 'running', 'pending']); // cut off mid-call

    // Restart: reopen the database, restore, run again.
    const dbPath = s.store.path;
    s.store.close();
    stores.pop();
    const reopened = openStore(dbPath);
    stores.push(reopened);
    expect(restoreJobs(reopened)).toMatchObject([{ jobId: 'J1', interruptedTiles: [2], nextTile: 2, accepted: 2 }]);

    const after = adapterFor({ ...s, store: reopened });
    const result = await runJob({ ...base({ ...s, store: reopened }, after) });
    expect(result.state).toBe('done');
    expect(after.calls.map((c) => c.tile)).toEqual([2, 3]);
    expect(reopened.listAttempts('J1', 2).map((a) => a.outcome)).toEqual(['interrupted', 'ok']);
  });

  it('fails the job, keeping every tile, when stitching fails', async () => {
    const s = await setup({ cols: 2 });
    const result = await runJob(base(s, adapterFor(s), { stitchFn: async () => { throw new Error('out of memory'); } }));
    expect(result.state).toBe('failed');
    expect(result.message).toMatch(/Stitching failed: out of memory/);
    expect(states(s)).toEqual(['accepted', 'accepted']);
  });

  it('passes the accepted outputs, the plan and the source to the stitcher', async () => {
    const s = await setup({ cols: 2 });
    const stitchFn = vi.fn(async () => ({ imagePath: 'x', metrics: { seamScore: 1, maxDeltaE: 0 }, flagged: [], flaggedDetails: [], harmonized: false, colors: null, timingsMs: { load: 0, align: 0, compose: 0, harmonize: 0, metrics: 0, write: 0, total: 0 } }));
    await runJob(base(s, adapterFor(s), { stitchFn }));
    const [input, io] = stitchFn.mock.calls[0] as unknown as [{ plan: unknown; tiles: Array<{ index: number; path: string }>; options: unknown }, { sourcePath: string }];
    expect(input.tiles.map((t) => t.index)).toEqual([0, 1]);
    expect(input.tiles.every((t) => existsSync(t.path))).toBe(true);
    expect(io.sourcePath).toBe(s.job.source.path);
    expect(input.options).toEqual({ blend: 'multiband', maxShiftPx: 8, harmonize: true });
  });

  it('fails a job whose category is not usable', async () => {
    const s = await setup({ cols: 1, categoryId: 'no-such-category' });
    const result = await runJob(base(s, adapterFor(s)));
    expect(result.state).toBe('failed');
    expect(result.message).toMatch(/not available/);
    expect(getCategory('env-realistic')).toBeDefined();
  });
});
