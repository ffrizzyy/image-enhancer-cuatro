import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  applyJobEvent,
  applyTileEvent,
  beginTile,
  IllegalTransitionError,
  MAX_ATTEMPTS,
  MIGRATIONS,
  nextRunnableTile,
  openStore,
  restoreJobs,
  settledOutcome,
  summarizeTiles,
  type Store,
} from '../src';
import { makeJob, rowPlan } from './support/fixtures';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ie-orch-resume-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const dbFile = () => path.join(dir, `db-${++n}.sqlite`);
const stores: Store[] = [];
const open = (file: string): Store => {
  const s = openStore(file);
  stores.push(s);
  return s;
};
afterEach(() => stores.splice(0).forEach((s) => s.close()));

/** A job already running with `count` tiles. */
function runningJob(store: Store, count = 4, id = 'J1') {
  store.createJob({ job: makeJob(id), plan: rowPlan(count), mode: 'chained' });
  applyJobEvent(store, id, { type: 'START' });
  applyJobEvent(store, id, { type: 'PREFLIGHT_PASSED' });
}

/** Runs a tile to acceptance the way the runner will. */
function accept(store: Store, index: number, id = 'J1') {
  const attempt = beginTile(store, id, index);
  store.finishAttempt(attempt.id, { outcome: 'ok', outputPath: `C:\\out\\${index}.png` });
  applyTileEvent(store, id, index, { type: 'ACCEPT' }, { outputPath: `C:\\out\\${index}.png` });
}

describe('applying events', () => {
  it('moves a job through its life and records each step', () => {
    const store = open(dbFile());
    runningJob(store, 2);
    applyJobEvent(store, 'J1', { type: 'PAUSE', reason: 'quota', resumeAfter: '2026-11-05T18:00:00.000Z' });
    expect(store.getJob('J1')).toMatchObject({ state: 'paused', pauseReason: 'quota', resumeAfter: '2026-11-05T18:00:00.000Z' });
    applyJobEvent(store, 'J1', { type: 'RESUME' });
    accept(store, 0);
    accept(store, 1);
    applyJobEvent(store, 'J1', { type: 'TILES_DONE' });
    applyJobEvent(store, 'J1', { type: 'STITCHED' });
    expect(store.getJob('J1')).toMatchObject({ state: 'done', pauseReason: null });
  });

  it('refuses an illegal event, changes nothing and says why', () => {
    const store = open(dbFile());
    store.createJob({ job: makeJob(), plan: rowPlan(2), mode: 'chained' });
    const events = store.listEvents('J1').length;

    expect(() => applyJobEvent(store, 'J1', { type: 'STITCHED' })).toThrow(IllegalTransitionError);
    expect(() => applyJobEvent(store, 'J1', { type: 'RESUME' })).toThrow(/idle cannot take "RESUME"/);
    expect(store.getJob('J1')!.state).toBe('idle');
    expect(store.listEvents('J1')).toHaveLength(events);
    expect(() => applyJobEvent(store, 'nope', { type: 'START' })).toThrow(IllegalTransitionError);
  });

  it('a cancelled or failed job cannot be restarted or resumed', () => {
    const store = open(dbFile());
    runningJob(store, 1);
    applyJobEvent(store, 'J1', { type: 'CANCEL' });
    for (const type of ['START', 'RESUME', 'PREFLIGHT_PASSED'] as const) expect(() => applyJobEvent(store, 'J1', { type }), type).toThrow(IllegalTransitionError);

    runningJob(store, 1, 'J2');
    applyJobEvent(store, 'J2', { type: 'FAIL', error: 'Missing selector: submitButton' });
    expect(() => applyJobEvent(store, 'J2', { type: 'RESUME' })).toThrow(IllegalTransitionError);
    expect(store.getJob('J2')).toMatchObject({ state: 'failed', error: 'Missing selector: submitButton' });
  });

  it('beginTile starts a tile only from pending or retrying, and never one already running or accepted', () => {
    const store = open(dbFile());
    runningJob(store, 2);
    beginTile(store, 'J1', 0);
    expect(() => beginTile(store, 'J1', 0)).toThrow(/running cannot take "START"/);
    applyTileEvent(store, 'J1', 0, { type: 'ACCEPT' });
    expect(() => beginTile(store, 'J1', 0)).toThrow(/accepted cannot take "START"/);
    expect(store.getTile('J1', 0)!.attempts).toBe(1);
  });

  it('retries a rejected tile twice, then sets it aside for review', () => {
    const store = open(dbFile());
    runningJob(store, 1);
    const states: string[] = [];
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const attempt = beginTile(store, 'J1', 0);
      store.finishAttempt(attempt.id, { outcome: 'rejected' });
      states.push(applyTileEvent(store, 'J1', 0, { type: 'REJECT' }).state);
    }
    expect(states).toEqual(['retrying', 'retrying', 'needs-review']);
    expect(store.getTile('J1', 0)!.attempts).toBe(MAX_ATTEMPTS);
  });

  it('a manual re-run queues the tile again with a fresh set of retries, keeping the attempt history', () => {
    const store = open(dbFile());
    runningJob(store, 1);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      beginTile(store, 'J1', 0);
      applyTileEvent(store, 'J1', 0, { type: 'REJECT' });
    }
    expect(store.getTile('J1', 0)!.state).toBe('needs-review');

    applyTileEvent(store, 'J1', 0, { type: 'RERUN' });
    expect(store.getTile('J1', 0)).toMatchObject({ state: 'pending', attempts: MAX_ATTEMPTS, attemptBase: MAX_ATTEMPTS });
    beginTile(store, 'J1', 0);
    expect(applyTileEvent(store, 'J1', 0, { type: 'REJECT' }).state).toBe('retrying'); // not needs-review again
    expect(store.listAttempts('J1', 0)).toHaveLength(MAX_ATTEMPTS + 1);
  });

  it('accepting a tile as it is, after review, keeps its output', () => {
    const store = open(dbFile());
    runningJob(store, 1);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      beginTile(store, 'J1', 0);
      applyTileEvent(store, 'J1', 0, { type: 'REJECT' }, { outputPath: 'C:\\out\\best.png' });
    }
    expect(applyTileEvent(store, 'J1', 0, { type: 'ACCEPT_AS_IS' })).toMatchObject({ state: 'accepted', outputPath: 'C:\\out\\best.png' });
  });
});

describe('which tile is next', () => {
  it('is the first tile in raster order that is pending or waiting for a retry', () => {
    const store = open(dbFile());
    runningJob(store, 4);
    expect(nextRunnableTile(store.listTiles('J1'))!.index).toBe(0);
    accept(store, 0);
    accept(store, 1);
    expect(nextRunnableTile(store.listTiles('J1'))!.index).toBe(2);
    beginTile(store, 'J1', 2);
    applyTileEvent(store, 'J1', 2, { type: 'REJECT' });
    expect(nextRunnableTile(store.listTiles('J1'))).toMatchObject({ index: 2, state: 'retrying' });
  });

  it('is nothing when every tile is accepted, set aside or failed', () => {
    const store = open(dbFile());
    runningJob(store, 2);
    accept(store, 0);
    beginTile(store, 'J1', 1);
    applyTileEvent(store, 'J1', 1, { type: 'FAIL' });
    expect(nextRunnableTile(store.listTiles('J1'))).toBeNull();
  });

  it('settledOutcome tells the runner what to do next', () => {
    const store = open(dbFile());
    runningJob(store, 2);
    expect(settledOutcome(store.listTiles('J1'))).toBe('in-progress');
    accept(store, 0);
    beginTile(store, 'J1', 1);
    expect(settledOutcome(store.listTiles('J1'))).toBe('in-progress'); // one is running
    applyTileEvent(store, 'J1', 1, { type: 'ACCEPT' });
    expect(settledOutcome(store.listTiles('J1'))).toBe('all-accepted');
    expect(summarizeTiles(store.listTiles('J1'))).toEqual({ accepted: 2, needsReview: 0, failed: 0, runnable: 0, running: 0, total: 2 });

    runningJob(store, 2, 'J2');
    accept(store, 0, 'J2');
    beginTile(store, 'J2', 1);
    applyTileEvent(store, 'J2', 1, { type: 'FAIL' });
    expect(settledOutcome(store.listTiles('J2'))).toBe('needs-review');
  });
});

describe('restart', () => {
  it('queues the cut-off tile again, keeps accepted tiles and continues from the first unfinished one', () => {
    const file = dbFile();
    const before = open(file);
    runningJob(before, 4);
    accept(before, 0);
    accept(before, 1);
    beginTile(before, 'J1', 2); // running when the app stops
    const accepted = before.listTiles('J1').filter((t) => t.state === 'accepted').map((t) => [t.index, t.outputPath, t.attempts]);
    before.close();
    stores.pop();

    const after = open(file);
    const restored = restoreJobs(after);
    expect(restored).toEqual([{ jobId: 'J1', state: 'running', interruptedTiles: [2], nextTile: 2, accepted: 2, total: 4, restitch: false }]);

    const tiles = after.listTiles('J1');
    expect(tiles.map((t) => t.state)).toEqual(['accepted', 'accepted', 'pending', 'pending']);
    expect(tiles.filter((t) => t.state === 'accepted').map((t) => [t.index, t.outputPath, t.attempts])).toEqual(accepted);
    // The cut-off attempt stays in the history, marked as interrupted; the retry allowance is not used up.
    expect(after.listAttempts('J1', 2)).toMatchObject([{ n: 1, outcome: 'interrupted' }]);
    expect(after.listAttempts('J1', 2)[0]!.finishedAt).not.toBeNull();
    expect(after.listEvents('J1').at(-1)).toMatchObject({ level: 'warn', message: expect.stringContaining('1 tile(s) were running') });

    // The runner continues with tile 2 as the same tile's second attempt, and tiles 0 and 1 are never started again.
    expect(beginTile(after, 'J1', 2).n).toBe(2);
    expect(() => beginTile(after, 'J1', 0)).toThrow(IllegalTransitionError);
  });

  it('leaves a paused job paused, with its reason and resume time', () => {
    const file = dbFile();
    const before = open(file);
    runningJob(before, 3);
    accept(before, 0);
    applyJobEvent(before, 'J1', { type: 'PAUSE', reason: 'quota', resumeAfter: '2026-11-05T18:00:00.000Z' });
    before.close();
    stores.pop();

    const after = open(file);
    expect(restoreJobs(after)).toEqual([{ jobId: 'J1', state: 'paused', interruptedTiles: [], nextTile: 1, accepted: 1, total: 3, restitch: false }]);
    expect(after.getJob('J1')).toMatchObject({ state: 'paused', pauseReason: 'quota', resumeAfter: '2026-11-05T18:00:00.000Z' });
  });

  it('puts a job caught in preflight back to idle, since nothing had started', () => {
    const file = dbFile();
    const before = open(file);
    before.createJob({ job: makeJob(), plan: rowPlan(2), mode: 'chained' });
    applyJobEvent(before, 'J1', { type: 'START' });
    before.close();
    stores.pop();

    const after = open(file);
    expect(restoreJobs(after)[0]).toMatchObject({ jobId: 'J1', state: 'idle', nextTile: 0 });
    expect(after.getJob('J1')!.error).toMatch(/closed during the pre-run checks/);
    applyJobEvent(after, 'J1', { type: 'START' }); // can be started again
  });

  it('flags a job that was being stitched, so it is stitched again from the accepted tiles', () => {
    const file = dbFile();
    const before = open(file);
    runningJob(before, 1);
    accept(before, 0);
    applyJobEvent(before, 'J1', { type: 'TILES_DONE' });
    before.close();
    stores.pop();

    expect(restoreJobs(open(file))).toEqual([{ jobId: 'J1', state: 'stitching', interruptedTiles: [], nextTile: null, accepted: 1, total: 1, restitch: true }]);
  });

  it('never touches finished, cancelled, failed or review-pending jobs', () => {
    const file = dbFile();
    const before = open(file);
    runningJob(before, 1, 'DONE');
    accept(before, 0, 'DONE');
    applyJobEvent(before, 'DONE', { type: 'TILES_DONE' });
    applyJobEvent(before, 'DONE', { type: 'STITCHED' });
    runningJob(before, 1, 'CANC');
    applyJobEvent(before, 'CANC', { type: 'CANCEL' });
    runningJob(before, 1, 'FAIL');
    applyJobEvent(before, 'FAIL', { type: 'FAIL', error: 'x' });
    runningJob(before, 1, 'REV');
    beginTile(before, 'REV', 0);
    applyTileEvent(before, 'REV', 0, { type: 'FAIL' });
    applyJobEvent(before, 'REV', { type: 'NEEDS_REVIEW' });
    const snapshot = before.listJobs().map((j) => [j.job.id, j.state, j.updatedAt]);
    before.close();
    stores.pop();

    const after = open(file);
    expect(restoreJobs(after)).toEqual([]);
    expect(after.listJobs().map((j) => [j.job.id, j.state, j.updatedAt])).toEqual(snapshot);
  });

  it('is safe to run twice', () => {
    const file = dbFile();
    const before = open(file);
    runningJob(before, 3);
    accept(before, 0);
    beginTile(before, 'J1', 1);
    before.close();
    stores.pop();

    const after = open(file);
    const first = restoreJobs(after);
    const second = restoreJobs(after);
    expect(first[0]!.interruptedTiles).toEqual([1]);
    expect(second[0]!.interruptedTiles).toEqual([]);
    expect(after.listTiles('J1').map((t) => t.state)).toEqual(['accepted', 'pending', 'pending']);
  });

  it('restores several jobs independently', () => {
    const file = dbFile();
    const before = open(file);
    runningJob(before, 2, 'A');
    beginTile(before, 'A', 0);
    runningJob(before, 2, 'B');
    accept(before, 0, 'B');
    before.close();
    stores.pop();

    const restored = restoreJobs(open(file));
    expect(restored.map((r) => [r.jobId, r.interruptedTiles, r.nextTile]).sort()).toEqual([['A', [0], 0], ['B', [], 1]]);
  });
});

describe('schema upgrade', () => {
  it('upgrades a version-1 database in place, keeping its rows', () => {
    const file = dbFile();
    const raw = new DatabaseSync(file);
    raw.exec(MIGRATIONS[0]!.sql);
    raw.exec('PRAGMA user_version = 1');
    raw.exec(`INSERT INTO jobs (id, created_at, updated_at, state, mode, provider_id, category_id, category_source, prompt, prompt_source, source_path, source_width, source_height, source_sha256, grid_rows, grid_cols, overlap_pct, plan_json)
      VALUES ('OLD', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 'running', 'chained', 'gpt', 'env-realistic', 'user', 'p', 'user', 'C:\\a.png', 100, 100, '${'a'.repeat(64)}', 1, 1, 10, '${JSON.stringify(rowPlan(1))}')`);
    raw.exec("INSERT INTO tiles (job_id, idx, state, attempts, updated_at) VALUES ('OLD', 0, 'accepted', 2, '2026-11-01T00:00:00.000Z')");
    raw.close();

    const store = open(file);
    expect(store.getTile('OLD', 0)).toMatchObject({ state: 'accepted', attempts: 2, attemptBase: 0 });
    expect(store.getJob('OLD')!.state).toBe('running');
    expect(restoreJobs(store)[0]).toMatchObject({ jobId: 'OLD', accepted: 1 });
  });
});
