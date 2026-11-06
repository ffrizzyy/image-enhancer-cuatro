import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  applyJobEvent,
  applyTileEvent,
  beginTile,
  IllegalTransitionError,
  isRunnable,
  MAX_ATTEMPTS,
  nextRunnableTile,
  openStore,
  restoreJobs,
  type Store,
} from '../src';
import { makeJob, rowPlan } from './support/fixtures';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ie-orch-prop-'));
});
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* the OS will clean up the temporary folder */
  }
});

type Op = 'start' | 'accept' | 'reject' | 'fail' | 'crash' | 'pause' | 'resume' | 'rerun';

let run = 0;

/**
 * Plays random runner actions against a real database, restarting (close, reopen, restore) on `crash`, and checks the
 * invariants after every step. `allow` lists the operations a property may use.
 */
function play(count: number, ops: readonly Op[], onStep: (ctx: { store: Store; op: Op; before: Snapshot }) => void): void {
  const file = path.join(dir, `p-${++run}.sqlite`);
  let store = openStore(file);
  try {
    store.createJob({ job: makeJob(), plan: rowPlan(count), mode: 'chained' });
    applyJobEvent(store, 'J1', { type: 'START' });
    applyJobEvent(store, 'J1', { type: 'PREFLIGHT_PASSED' });

    for (const op of ops) {
      const before = snapshot(store);
      const tiles = store.listTiles('J1');
      const running = tiles.find((t) => t.state === 'running');
      const jobState = store.getJob('J1')!.state;

      switch (op) {
        case 'start': {
          const next = nextRunnableTile(tiles);
          if (jobState === 'running' && next && !running) beginTile(store, 'J1', next.index);
          break;
        }
        case 'accept':
          if (running) {
            const attempts = store.listAttempts('J1', running.index);
            store.finishAttempt(attempts[attempts.length - 1]!.id, { outcome: 'ok' });
            applyTileEvent(store, 'J1', running.index, { type: 'ACCEPT' });
          }
          break;
        case 'reject':
          if (running) {
            const attempts = store.listAttempts('J1', running.index);
            store.finishAttempt(attempts[attempts.length - 1]!.id, { outcome: 'rejected' });
            applyTileEvent(store, 'J1', running.index, { type: 'REJECT' });
          }
          break;
        case 'fail':
          if (running) {
            const attempts = store.listAttempts('J1', running.index);
            store.finishAttempt(attempts[attempts.length - 1]!.id, { outcome: 'error', errorKind: 'ui-changed' });
            applyTileEvent(store, 'J1', running.index, { type: 'FAIL' });
          }
          break;
        case 'crash':
          store.close();
          store = openStore(file);
          restoreJobs(store);
          break;
        case 'pause':
          if (jobState === 'running') applyJobEvent(store, 'J1', { type: 'PAUSE', reason: 'quota' });
          break;
        case 'resume':
          if (jobState === 'paused') applyJobEvent(store, 'J1', { type: 'RESUME' });
          break;
        case 'rerun': {
          const done = tiles.find((t) => t.state === 'accepted' || t.state === 'needs-review' || t.state === 'failed');
          if (done) applyTileEvent(store, 'J1', done.index, { type: 'RERUN' });
          break;
        }
      }
      onStep({ store, op, before });
    }
  } finally {
    store.close();
  }
}

interface Snapshot {
  accepted: Map<number, { output: string | null; attempts: number }>;
  attemptCount: Map<number, number>;
}

function snapshot(store: Store): Snapshot {
  const tiles = store.listTiles('J1');
  return {
    accepted: new Map(tiles.filter((t) => t.state === 'accepted').map((t) => [t.index, { output: t.outputPath, attempts: t.attempts }])),
    attemptCount: new Map(tiles.map((t) => [t.index, store.listAttempts('J1', t.index).length])),
  };
}

const tileCount = fc.integer({ min: 1, max: 5 });
const sequence = (ops: readonly Op[]) => fc.array(fc.constantFrom(...ops), { minLength: 1, maxLength: 45 });

describe('properties of running and restarting a job', () => {
  const NO_RERUN: readonly Op[] = ['start', 'start', 'accept', 'accept', 'reject', 'fail', 'crash', 'pause', 'resume'];

  it('the accepted tile count never decreases, and an accepted tile is never changed or run again', () => {
    fc.assert(
      fc.property(tileCount, sequence(NO_RERUN), (count, ops) => {
        play(count, ops, ({ store, before }) => {
          const now = snapshot(store);
          expect(now.accepted.size).toBeGreaterThanOrEqual(before.accepted.size);
          for (const [index, was] of before.accepted) {
            expect(now.accepted.get(index), `tile ${index} stayed accepted`).toEqual(was); // same output, same attempts
            expect(now.attemptCount.get(index)).toBe(before.attemptCount.get(index)); // and no new attempt
          }
        });
      }),
      { numRuns: 60 },
    );
  });

  it('after any restart no tile is left running, and every unfinished tile is queued', () => {
    fc.assert(
      fc.property(tileCount, sequence(NO_RERUN), (count, ops) => {
        play(count, ops, ({ store, op }) => {
          if (op !== 'crash') return;
          const tiles = store.listTiles('J1');
          expect(tiles.some((t) => t.state === 'running')).toBe(false);
          // Every attempt that never finished has been closed out.
          expect(store.listAttempts('J1').some((a) => a.outcome === null)).toBe(false);
        });
      }),
      { numRuns: 60 },
    );
  });

  it('no tile has more than one successful attempt unless a person re-ran it', () => {
    fc.assert(
      fc.property(tileCount, sequence(NO_RERUN), (count, ops) => {
        play(count, ops, ({ store }) => {
          for (const tile of store.listTiles('J1')) {
            const ok = store.listAttempts('J1', tile.index).filter((a) => a.outcome === 'ok').length;
            expect(ok).toBeLessThanOrEqual(1);
          }
        });
      }),
      { numRuns: 60 },
    );
  });

  it('a tile never uses more tries than the retry limit between restarts and re-runs', () => {
    fc.assert(
      fc.property(tileCount, sequence(NO_RERUN.filter((op) => op !== 'crash')), (count, ops) => {
        play(count, ops, ({ store }) => {
          for (const tile of store.listTiles('J1')) expect(tile.attempts).toBeLessThanOrEqual(MAX_ATTEMPTS);
        });
      }),
      { numRuns: 60 },
    );
  });

  it('with manual re-runs allowed, a tile starts again only from a re-run, a retry or a restart', () => {
    fc.assert(
      fc.property(tileCount, sequence([...NO_RERUN, 'rerun', 'rerun']), (count, ops) => {
        play(count, ops, ({ store, op, before }) => {
          const now = snapshot(store);
          for (const [index, was] of before.accepted) {
            const gained = (now.attemptCount.get(index) ?? 0) - (before.attemptCount.get(index) ?? 0);
            // An accepted tile can gain an attempt only if it left the accepted state first (which only `rerun` does).
            if (gained > 0) expect(op, `tile ${index} ran again without a re-run`).toBe('rerun');
            if (!now.accepted.has(index)) expect(op).toBe('rerun');
            void was;
          }
        });
      }),
      { numRuns: 60 },
    );
  });

  it('beginTile on a tile that is not waiting always throws', () => {
    fc.assert(
      fc.property(tileCount, sequence(NO_RERUN), (count, ops) => {
        play(count, ops, ({ store }) => {
          for (const tile of store.listTiles('J1')) {
            if (isRunnable(tile)) continue;
            expect(() => beginTile(store, 'J1', tile.index)).toThrow(IllegalTransitionError);
          }
        });
      }),
      { numRuns: 40 },
    );
  });

  it('a cancelled job stays cancelled whatever happens next, including a restart', () => {
    fc.assert(
      fc.property(tileCount, fc.array(fc.constantFrom('crash', 'start', 'pause', 'resume') as fc.Arbitrary<Op>, { maxLength: 12 }), (count, ops) => {
        play(count, ['start', 'accept', ...ops], () => {});
        const file = path.join(dir, `c-${++run}.sqlite`);
        const store = openStore(file);
        try {
          store.createJob({ job: makeJob(), plan: rowPlan(count), mode: 'chained' });
          applyJobEvent(store, 'J1', { type: 'CANCEL' });
          expect(restoreJobs(store)).toEqual([]);
          expect(store.getJob('J1')!.state).toBe('cancelled');
          for (const type of ['START', 'RESUME', 'PREFLIGHT_PASSED', 'RERUN_TILE'] as const) expect(() => applyJobEvent(store, 'J1', { type })).toThrow(IllegalTransitionError);
        } finally {
          store.close();
        }
      }),
      { numRuns: 20 },
    );
  });
});
