import { afterEach, describe, expect, it } from 'vitest';

import { applyJobEvent, applyTileEvent, beginTile, jobProgress, openStore, recentJobs, type Store, type StoreChange } from '../src';
import { makeJob, rowPlan } from './support/fixtures';

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));

function withListener() {
  const changes: StoreChange[] = [];
  const store = openStore(':memory:', { onCommit: (c) => changes.push(c) });
  stores.push(store);
  return { store, changes };
}

describe('store change notifications', () => {
  it('announce each committed unit of work with the jobs it touched and the events it logged', () => {
    const { store, changes } = withListener();
    store.createJob({ job: makeJob('A'), plan: rowPlan(2), mode: 'chained' });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.jobIds).toEqual(['A']);
    expect(changes[0]!.events.map((e) => e.message)).toEqual(['Job created with 2 tiles (chained).']);

    applyJobEvent(store, 'A', { type: 'START' });
    expect(changes).toHaveLength(2);
    expect(changes[1]!.events.map((e) => e.message)).toEqual(['Job idle → preflight']);
  });

  it('send one notice for a unit of work however many writes it makes', () => {
    const { store, changes } = withListener();
    store.createJob({ job: makeJob('A'), plan: rowPlan(2), mode: 'chained' });
    changes.length = 0;
    store.transaction(() => {
      store.setJobState('A', 'running');
      store.updateTile('A', 0, { state: 'accepted' });
      store.setJobState('A', 'paused', { pauseReason: 'user' });
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.events.map((e) => e.message)).toEqual(['Job idle → running', 'Tile 1: pending → accepted', 'Job running → paused (user)']);
  });

  it('say nothing for a unit of work that was rolled back, and nothing leaks into the next one', () => {
    const { store, changes } = withListener();
    store.createJob({ job: makeJob('A'), plan: rowPlan(1), mode: 'chained' });
    changes.length = 0;
    expect(() =>
      store.transaction(() => {
        store.setJobState('A', 'running');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(changes).toHaveLength(0);

    store.setJobState('A', 'running');
    expect(changes).toHaveLength(1);
    expect(changes[0]!.events.map((e) => e.message)).toEqual(['Job idle → running']); // not the rolled-back one too
  });

  it('are sent after the data can be read back', () => {
    let seen: string | null = null;
    const store = openStore(':memory:', { onCommit: () => void (seen = store.getJob('A')?.state ?? null) });
    stores.push(store);
    store.createJob({ job: makeJob('A'), plan: rowPlan(1), mode: 'chained' });
    expect(seen).toBe('idle');
  });

  it('cover tile and attempt writes even when they log no event', () => {
    const { store, changes } = withListener();
    store.createJob({ job: makeJob('A'), plan: rowPlan(1), mode: 'chained' });
    applyJobEvent(store, 'A', { type: 'START' });
    applyJobEvent(store, 'A', { type: 'PREFLIGHT_PASSED' });
    const attempt = beginTile(store, 'A', 0);
    changes.length = 0;
    store.finishAttempt(attempt.id, { outcome: 'ok' });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ jobIds: ['A'], events: [] });
  });

  it('are not disturbed by a listener that throws', () => {
    const store = openStore(':memory:', {
      onCommit: () => {
        throw new Error('listener bug');
      },
    });
    stores.push(store);
    expect(() => store.createJob({ job: makeJob('A'), plan: rowPlan(1), mode: 'chained' })).not.toThrow();
    expect(store.getJob('A')).not.toBeNull();
  });
});

describe('jobProgress', () => {
  it('is null for an unknown job', () => {
    expect(jobProgress(openStoreTracked(), 'nope')).toBeNull();
  });

  const openStoreTracked = (): Store => {
    const s = openStore(':memory:');
    stores.push(s);
    return s;
  };

  it('describes the job and every tile for the Run screen', () => {
    const store = openStoreTracked();
    store.createJob({ job: makeJob('A'), plan: rowPlan(3), mode: 'chained' });
    applyJobEvent(store, 'A', { type: 'START' });
    applyJobEvent(store, 'A', { type: 'PREFLIGHT_PASSED' });

    const a0 = beginTile(store, 'A', 0);
    store.finishAttempt(a0.id, { outcome: 'ok', outputPath: 'C:\\out\\0.png' });
    applyTileEvent(store, 'A', 0, { type: 'ACCEPT' }, { outputPath: 'C:\\out\\0.png' });
    const a1 = beginTile(store, 'A', 1);
    store.finishAttempt(a1.id, { outcome: 'error', errorKind: 'timeout', message: 'slow' });
    applyTileEvent(store, 'A', 1, { type: 'REJECT' }, { note: 'slow' });

    expect(jobProgress(store, 'A')).toEqual({
      jobId: 'A',
      state: 'running',
      providerId: 'gemini',
      prompt: 'Enhance this tile.',
      grid: { rows: 1, cols: 3 },
      completedTiles: 1,
      totalTiles: 3,
      tiles: [
        { index: 0, state: 'accepted', attempts: 1, outputPath: 'C:\\out\\0.png' },
        { index: 1, state: 'retrying', attempts: 1, errorKind: 'timeout', note: 'slow' },
        { index: 2, state: 'pending', attempts: 0 },
      ],
    });
  });

  it('carries the pause reason, the resume time and the failure reason', () => {
    const store = openStoreTracked();
    store.createJob({ job: makeJob('A'), plan: rowPlan(1), mode: 'chained' });
    applyJobEvent(store, 'A', { type: 'START' });
    applyJobEvent(store, 'A', { type: 'PREFLIGHT_PASSED' });
    applyJobEvent(store, 'A', { type: 'PAUSE', reason: 'quota', resumeAfter: '2026-11-05T18:00:00.000Z' });
    expect(jobProgress(store, 'A')).toMatchObject({ state: 'paused', pauseReason: 'quota', resumeAfter: '2026-11-05T18:00:00.000Z' });
    expect(jobProgress(store, 'A')).not.toHaveProperty('error');

    applyJobEvent(store, 'A', { type: 'FAIL', error: 'Missing selector: submitButton' });
    const failed = jobProgress(store, 'A')!;
    expect(failed).toMatchObject({ state: 'failed', error: 'Missing selector: submitButton' });
    expect(failed).not.toHaveProperty('pauseReason');
  });

  it('carries each tile’s own prompt and source, and the stitched result once there is one', () => {
    const store = openStoreTracked();
    store.createJob({ job: makeJob('A'), plan: rowPlan(2), mode: 'chained' });
    store.updateTile('A', 1, { promptOverride: 'Keep the window matte.', sourceOverride: 'C:\\jobs\\A\\tiles\\tile-001-source.png' });
    expect(jobProgress(store, 'A')!.tiles[1]).toMatchObject({
      promptOverride: 'Keep the window matte.',
      sourceOverride: 'C:\\jobs\\A\\tiles\\tile-001-source.png',
    });

    store.setJobResult('A', { imagePath: 'C:\\jobs\\A\\stitched.png', metrics: { seamScore: 1.05, maxDeltaE: 0.8 }, flagged: [1], stitchedAt: '2026-11-06T10:00:00.000Z' });
    expect(jobProgress(store, 'A')!.result).toEqual({
      imagePath: 'C:\\jobs\\A\\stitched.png',
      metrics: { seamScore: 1.05, maxDeltaE: 0.8 },
      flagged: [1],
      stitchedAt: '2026-11-06T10:00:00.000Z',
    });
  });

  it('does not report an old error on a tile that has since been accepted', () => {
    const store = openStoreTracked();
    store.createJob({ job: makeJob('A'), plan: rowPlan(1), mode: 'chained' });
    applyJobEvent(store, 'A', { type: 'START' });
    applyJobEvent(store, 'A', { type: 'PREFLIGHT_PASSED' });
    const first = beginTile(store, 'A', 0);
    store.finishAttempt(first.id, { outcome: 'error', errorKind: 'timeout' });
    applyTileEvent(store, 'A', 0, { type: 'REJECT' });
    const second = beginTile(store, 'A', 0);
    store.finishAttempt(second.id, { outcome: 'ok' });
    applyTileEvent(store, 'A', 0, { type: 'ACCEPT' }, { note: null });
    expect(jobProgress(store, 'A')!.tiles[0]).toEqual({ index: 0, state: 'accepted', attempts: 2 });
  });
});

describe('recentJobs', () => {
  it('lists the newest jobs first, with progress counts, up to the limit', () => {
    const store = openStore(':memory:');
    stores.push(store);
    for (const [id, at] of [['A', '2026-11-01'], ['B', '2026-11-03'], ['C', '2026-11-02']] as const) {
      store.createJob({ job: makeJob(id, { createdAt: `${at}T00:00:00.000Z` }), plan: rowPlan(2), mode: 'chained' });
    }
    store.updateTile('B', 0, { state: 'accepted' });

    expect(recentJobs(store).map((j) => j.id)).toEqual(['B', 'C', 'A']);
    expect(recentJobs(store, 2)).toHaveLength(2);
    expect(recentJobs(store)[0]).toEqual({ id: 'B', createdAt: '2026-11-03T00:00:00.000Z', state: 'idle', completedTiles: 1, totalTiles: 2 });
  });
});
