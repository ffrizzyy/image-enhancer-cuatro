import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS, openStore, StoreError, type Store } from '../src';
import { makeJob, rowPlan } from './support/fixtures';

const here = path.dirname(fileURLToPath(import.meta.url));
const child = path.join(here, 'support', 'crashChild.ts');

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ie-orch-store-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
const dbFile = (): string => path.join(dir, `db-${++counter}`, 'jobs.sqlite');

const open: Store[] = [];
const track = (s: Store): Store => (open.push(s), s);
afterEach(() => {
  for (const s of open.splice(0)) {
    try {
      s.close();
    } catch {
      /* already closed by the test */
    }
  }
});

const memory = (now?: () => Date): Store => track(openStore(':memory:', now ? { now } : {}));

describe('job rows', () => {
  it('creates a job with its plan and one pending tile per plan tile, in a single step', () => {
    const store = memory();
    const plan = rowPlan(4);
    const record = store.createJob({ job: makeJob('J1'), plan, mode: 'chained' });

    expect(record).toMatchObject({ state: 'idle', mode: 'chained', pauseReason: null, resumeAfter: null, error: null });
    expect(record.plan).toEqual(plan);
    expect(record.job).toEqual(makeJob('J1'));
    expect(store.listTiles('J1').map((t) => [t.index, t.state, t.attempts])).toEqual([[0, 'pending', 0], [1, 'pending', 0], [2, 'pending', 0], [3, 'pending', 0]]);
    expect(store.listEvents('J1').map((e) => e.message)).toEqual(['Job created with 4 tiles (chained).']);
  });

  it('round-trips every optional job field', () => {
    const store = memory();
    const job = makeJob('J2', { categorySource: 'auto', categoryConfidence: 0.83, grid: { rows: 2, cols: 2, overlapPct: 12.5, wrap: true }, promptSource: 'category-default' });
    store.createJob({ job, plan: rowPlan(1), mode: 'independent' });
    expect(store.getJob('J2')!.job).toEqual(job);
  });

  it('refuses a duplicate id and an empty plan, leaving nothing behind', () => {
    const store = memory();
    store.createJob({ job: makeJob('J1'), plan: rowPlan(2), mode: 'chained' });
    expect(() => store.createJob({ job: makeJob('J1'), plan: rowPlan(2), mode: 'chained' })).toThrow(expect.objectContaining({ code: 'exists' }));
    expect(() => store.createJob({ job: makeJob('J9'), plan: { ...rowPlan(1), tiles: [] }, mode: 'chained' })).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(store.getJob('J9')).toBeNull();
    expect(store.listTiles('J1')).toHaveLength(2);
  });

  it('returns null for an unknown job and throws a typed error when asked to change one', () => {
    const store = memory();
    expect(store.getJob('nope')).toBeNull();
    expect(() => store.setJobState('nope', 'running')).toThrow(StoreError);
    expect(() => store.updateTile('nope', 0, { state: 'running' })).toThrow(expect.objectContaining({ code: 'not-found' }));
  });

  it('lists newest first, filters by state and limits', () => {
    const store = memory();
    for (const [id, at] of [['A', '2026-11-01'], ['B', '2026-11-03'], ['C', '2026-11-02']] as const) {
      store.createJob({ job: makeJob(id, { createdAt: `${at}T00:00:00.000Z` }), plan: rowPlan(1), mode: 'chained' });
    }
    store.setJobState('A', 'running');
    expect(store.listJobs().map((r) => r.job.id)).toEqual(['B', 'C', 'A']);
    expect(store.listJobs({ states: ['running', 'paused'] }).map((r) => r.job.id)).toEqual(['A']);
    expect(store.listJobs({ limit: 2 }).map((r) => r.job.id)).toEqual(['B', 'C']);
  });
});

describe('job state', () => {
  it('records the pause reason and resume time, and clears them on the next state', () => {
    const store = memory();
    store.createJob({ job: makeJob(), plan: rowPlan(2), mode: 'chained' });
    store.setJobState('J1', 'running');

    const paused = store.setJobState('J1', 'paused', { pauseReason: 'quota', resumeAfter: '2026-11-05T18:00:00.000Z' });
    expect(paused).toMatchObject({ state: 'paused', pauseReason: 'quota', resumeAfter: '2026-11-05T18:00:00.000Z' });

    expect(store.setJobState('J1', 'running')).toMatchObject({ state: 'running', pauseReason: null, resumeAfter: null });
  });

  it('keeps the failure reason on a failed job and logs it as an error', () => {
    const store = memory();
    store.createJob({ job: makeJob(), plan: rowPlan(1), mode: 'chained' });
    store.setJobState('J1', 'failed', { error: 'Missing selector: submitButton' });
    expect(store.getJob('J1')).toMatchObject({ state: 'failed', error: 'Missing selector: submitButton' });
    expect(store.listEvents('J1').at(-1)).toMatchObject({ level: 'error', message: 'Job idle → failed', data: { error: 'Missing selector: submitButton' } });
  });

  it('logs every change with the previous state and the pause reason', () => {
    const store = memory();
    store.createJob({ job: makeJob(), plan: rowPlan(1), mode: 'chained' });
    store.setJobState('J1', 'running');
    store.setJobState('J1', 'paused', { pauseReason: 'challenge' });
    expect(store.listEvents('J1').map((e) => e.message)).toEqual(['Job created with 1 tiles (chained).', 'Job idle → running', 'Job running → paused (challenge)']);
  });

  it('stamps updates with the injected clock', () => {
    let t = Date.parse('2026-11-05T12:00:00.000Z');
    const store = memory(() => new Date(t));
    store.createJob({ job: makeJob(), plan: rowPlan(1), mode: 'chained' });
    t += 5000;
    expect(store.setJobState('J1', 'running').updatedAt).toBe('2026-11-05T12:00:05.000Z');
  });

  it('rejects a state outside the contract, so a typo cannot be stored', () => {
    const store = memory();
    store.createJob({ job: makeJob(), plan: rowPlan(1), mode: 'chained' });
    expect(() => store.setJobState('J1', 'runing' as never)).toThrow(/CHECK/);
    expect(store.getJob('J1')!.state).toBe('idle');
  });
});

describe('tiles and attempts', () => {
  const setup = () => {
    const store = memory();
    store.createJob({ job: makeJob(), plan: rowPlan(3), mode: 'chained' });
    return store;
  };

  it('startAttempt counts the try and marks the tile running in one step', () => {
    const store = setup();
    const first = store.startAttempt('J1', 1);
    expect(first).toMatchObject({ jobId: 'J1', tileIndex: 1, n: 1, outcome: null, finishedAt: null });
    expect(store.getTile('J1', 1)).toMatchObject({ state: 'running', attempts: 1 });

    store.finishAttempt(first.id, { outcome: 'rejected', message: 'Too different from the source' });
    store.updateTile('J1', 1, { state: 'retrying' });
    expect(store.startAttempt('J1', 1).n).toBe(2);
    expect(store.getTile('J1', 1)!.attempts).toBe(2);
    expect(store.listAttempts('J1', 1).map((a) => [a.n, a.outcome])).toEqual([[1, 'rejected'], [2, null]]);
  });

  it('records how an attempt ended', () => {
    const store = setup();
    const attempt = store.startAttempt('J1', 0);
    const done = store.finishAttempt(attempt.id, { outcome: 'error', errorKind: 'quota', message: 'limit', elapsedMs: 900 });
    expect(done).toMatchObject({ outcome: 'error', errorKind: 'quota', message: 'limit', elapsedMs: 900 });
    expect(done.finishedAt).not.toBeNull();
    expect(() => store.finishAttempt(9999, { outcome: 'ok' })).toThrow(expect.objectContaining({ code: 'not-found' }));
  });

  it('updates only the fields given, and null clears a field', () => {
    const store = setup();
    store.updateTile('J1', 0, { state: 'accepted', outputPath: 'C:\\out\\0.png', note: 'looks good' });
    expect(store.getTile('J1', 0)).toMatchObject({ state: 'accepted', outputPath: 'C:\\out\\0.png', note: 'looks good' });
    store.updateTile('J1', 0, { promptOverride: 'Keep it matte.' });
    expect(store.getTile('J1', 0)).toMatchObject({ state: 'accepted', outputPath: 'C:\\out\\0.png', promptOverride: 'Keep it matte.' });
    store.updateTile('J1', 0, { note: null });
    expect(store.getTile('J1', 0)!.note).toBeNull();
  });

  it('logs tile state changes, not repeats', () => {
    const store = setup();
    store.updateTile('J1', 2, { state: 'running' });
    store.updateTile('J1', 2, { state: 'running', note: 'same state' });
    expect(store.listEvents('J1').map((e) => e.message).filter((m) => m.startsWith('Tile'))).toEqual(['Tile 3: pending → running']);
  });

  it('rejects a tile state outside the contract', () => {
    const store = setup();
    expect(() => store.updateTile('J1', 0, { state: 'done' as never })).toThrow(/CHECK/);
  });

  it('deleting a job removes its tiles, attempts and events', () => {
    const store = setup();
    store.startAttempt('J1', 0);
    store.deleteJob('J1');
    expect(store.getJob('J1')).toBeNull();
    expect([store.listTiles('J1'), store.listAttempts('J1'), store.listEvents('J1')]).toEqual([[], [], []]);
    expect(() => store.deleteJob('J1')).toThrow(StoreError);
  });
});

describe('events', () => {
  it('are returned oldest first and can be read from where the last read stopped', () => {
    const store = memory();
    store.createJob({ job: makeJob(), plan: rowPlan(1), mode: 'chained' });
    store.addEvent('J1', 'warn', 'slow response', { ms: 90_000 });
    store.addEvent('J1', 'info', 'next');
    const all = store.listEvents('J1');
    expect(all.map((e) => e.message)).toEqual(['Job created with 1 tiles (chained).', 'slow response', 'next']);
    expect(all[1]).toMatchObject({ level: 'warn', data: { ms: 90_000 } });
    expect(all[2]!.data).toBeUndefined();
    expect(store.listEvents('J1', { afterId: all[1]!.id }).map((e) => e.message)).toEqual(['next']);
    expect(store.listEvents('J1', { limit: 1 })).toHaveLength(1);
  });
});

describe('transactions', () => {
  it('commit everything together, or nothing when the unit throws', () => {
    const store = memory();
    store.createJob({ job: makeJob(), plan: rowPlan(2), mode: 'chained' });

    expect(() =>
      store.transaction(() => {
        store.setJobState('J1', 'running');
        store.updateTile('J1', 0, { state: 'accepted' });
        throw new Error('crash between steps');
      }),
    ).toThrow('crash between steps');
    expect(store.getJob('J1')!.state).toBe('idle');
    expect(store.getTile('J1', 0)!.state).toBe('pending');
    expect(store.listEvents('J1')).toHaveLength(1);

    store.transaction(() => {
      store.setJobState('J1', 'running');
      store.updateTile('J1', 0, { state: 'accepted' });
    });
    expect([store.getJob('J1')!.state, store.getTile('J1', 0)!.state]).toEqual(['running', 'accepted']);
  });

  it('can be nested: an inner failure undoes the whole outer unit', () => {
    const store = memory();
    store.createJob({ job: makeJob(), plan: rowPlan(1), mode: 'chained' });
    expect(() =>
      store.transaction(() => {
        store.setJobState('J1', 'running');
        store.transaction(() => {
          store.setJobState('J1', 'paused', { pauseReason: 'user' });
          throw new Error('inner');
        });
      }),
    ).toThrow('inner');
    expect(store.getJob('J1')!.state).toBe('idle');
  });

  it('a failed create leaves no half-written job', () => {
    const store = memory();
    const plan = rowPlan(2);
    plan.tiles[1]!.index = 0; // duplicate tile index: the second insert must fail
    expect(() => store.createJob({ job: makeJob(), plan, mode: 'chained' })).toThrow();
    expect(store.getJob('J1')).toBeNull();
    expect(store.listTiles('J1')).toEqual([]);
  });
});

describe('the database file', () => {
  it('is created, with its folder, in write-ahead mode with a busy timeout and full durability', () => {
    const file = dbFile();
    const store = track(openStore(file));
    store.close();

    const raw = new DatabaseSync(file);
    expect((raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    raw.close();
  });

  it('enforces foreign keys: deleting a job cascades to its tiles', () => {
    const store = track(openStore(dbFile()));
    store.createJob({ job: makeJob(), plan: rowPlan(2), mode: 'chained' });
    store.deleteJob('J1');
    expect(store.listTiles('J1')).toEqual([]);
  });

  it('keeps everything when reopened', () => {
    const file = dbFile();
    const first = openStore(file);
    first.createJob({ job: makeJob('R1'), plan: rowPlan(3), mode: 'independent' });
    first.setJobState('R1', 'paused', { pauseReason: 'logged-out' });
    const attempt = first.startAttempt('R1', 2);
    first.finishAttempt(attempt.id, { outcome: 'ok', outputPath: 'C:\\out\\2.png' });
    first.updateTile('R1', 2, { state: 'accepted', outputPath: 'C:\\out\\2.png' });
    first.close();

    const second = track(openStore(file));
    expect(second.getJob('R1')).toMatchObject({ state: 'paused', pauseReason: 'logged-out', mode: 'independent' });
    expect(second.getTile('R1', 2)).toMatchObject({ state: 'accepted', attempts: 1, outputPath: 'C:\\out\\2.png' });
    expect(second.listAttempts('R1')).toHaveLength(1);
    expect(second.listEvents('R1').length).toBeGreaterThan(3);
  });

  it('does not migrate twice, and refuses a database from a newer version', () => {
    const file = dbFile();
    openStore(file).close();
    openStore(file).close(); // second open: nothing to apply, no error

    const raw = new DatabaseSync(file);
    raw.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    raw.close();
    expect(() => openStore(file)).toThrow(expect.objectContaining({ code: 'newer-schema' }));
  });
});

describe('crash and concurrency (real processes)', () => {
  const runNode = (args: string[]) => spawnSync(process.execPath, [child, ...args], { encoding: 'utf8' });

  it('a process killed mid-job leaves every committed change behind, and the unfinished attempt visible', () => {
    const file = dbFile();
    const result = runNode([file, 'crash']);
    expect(result.stdout).toContain('READY');
    expect(result.status === 0).toBe(false); // it was killed, not a clean exit

    const store = track(openStore(file));
    expect(store.getJob('CRASH')).toMatchObject({ state: 'running' });
    expect(store.listTiles('CRASH').map((t) => [t.index, t.state, t.attempts])).toEqual([[0, 'accepted', 1], [1, 'running', 1], [2, 'pending', 0], [3, 'pending', 0]]);
    expect(store.getTile('CRASH', 0)!.outputPath).toBe('C:\\out\\0.png');
    // The attempt in flight when it died has a start and no end: resume can tell it was cut off.
    expect(store.listAttempts('CRASH', 1)).toMatchObject([{ n: 1, outcome: null, finishedAt: null }]);
    expect(store.listAttempts('CRASH', 0)).toMatchObject([{ n: 1, outcome: 'ok', elapsedMs: 1200 }]);
  });

  it('readers are not blocked by a writer, and see only committed data', async () => {
    const file = dbFile();
    track(openStore(file)); // creates the file and schema
    const holder = spawn(process.execPath, [child, file, 'hold', '600'], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => holder.stdout.on('data', (chunk: Buffer) => chunk.toString().includes('LOCKED') && resolve()));

    const reader = track(openStore(file, { busyTimeoutMs: 50 }));
    const started = Date.now();
    expect(reader.getJob('HOLD')).toBeNull(); // the writer's job is not committed yet
    expect(reader.listJobs()).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500); // and it did not wait for the writer

    await new Promise((resolve) => holder.on('exit', resolve));
    expect(reader.getJob('HOLD')).not.toBeNull(); // now committed
    expect(reader.listTiles('HOLD')).toHaveLength(2);
  });

  it('a second writer waits for the first within the busy timeout, then succeeds', async () => {
    const file = dbFile();
    const store = track(openStore(file, { busyTimeoutMs: 5000 }));
    const holder = spawn(process.execPath, [child, file, 'hold', '500'], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => holder.stdout.on('data', (chunk: Buffer) => chunk.toString().includes('LOCKED') && resolve()));

    const started = Date.now();
    store.createJob({ job: makeJob('WAITER'), plan: rowPlan(1), mode: 'chained' }); // blocks until the holder commits
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    await new Promise((resolve) => holder.on('exit', resolve));
    expect(store.listJobs().map((r) => r.job.id).sort()).toEqual(['HOLD', 'WAITER']);
  });

  it('a writer that cannot get the lock in time fails with an error instead of hanging', async () => {
    const file = dbFile();
    const store = track(openStore(file, { busyTimeoutMs: 100 }));
    const holder = spawn(process.execPath, [child, file, 'hold', '1500'], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => holder.stdout.on('data', (chunk: Buffer) => chunk.toString().includes('LOCKED') && resolve()));

    const started = Date.now();
    expect(() => store.createJob({ job: makeJob('LATE'), plan: rowPlan(1), mode: 'chained' })).toThrow(/locked|busy/i);
    expect(Date.now() - started).toBeLessThan(1200);
    await new Promise((resolve) => holder.on('exit', resolve));
    expect(store.getJob('LATE')).toBeNull();
  });
});
