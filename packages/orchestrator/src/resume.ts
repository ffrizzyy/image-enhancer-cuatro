import type { JobState } from '@ie/contracts';

import type { Store, TileRecord } from './store.ts';
import { applyJobEvent, applyTileEvent } from './transitions.ts';

/** Tiles the runner may start: waiting, or waiting for a retry. Accepted tiles are never in this list. */
export const isRunnable = (tile: Pick<TileRecord, 'state'>): boolean => tile.state === 'pending' || tile.state === 'retrying';

/** The first tile, in raster order, that still has work to do; null when none does. */
export function nextRunnableTile(tiles: readonly TileRecord[]): TileRecord | null {
  return tiles.find(isRunnable) ?? null;
}

export type TileSummary = { accepted: number; needsReview: number; failed: number; runnable: number; running: number; total: number };

export function summarizeTiles(tiles: readonly TileRecord[]): TileSummary {
  const count = (state: TileRecord['state']): number => tiles.filter((t) => t.state === state).length;
  return {
    accepted: count('accepted'),
    needsReview: count('needs-review'),
    failed: count('failed'),
    runnable: tiles.filter(isRunnable).length,
    running: count('running'),
    total: tiles.length,
  };
}

/** What the runner should do once no tile is waiting or running. */
export function settledOutcome(tiles: readonly TileRecord[]): 'in-progress' | 'all-accepted' | 'needs-review' {
  const s = summarizeTiles(tiles);
  if (s.runnable > 0 || s.running > 0) return 'in-progress';
  return s.accepted === s.total ? 'all-accepted' : 'needs-review';
}

export interface RestoredJob {
  jobId: string;
  state: JobState;
  /** Tiles that were mid-attempt when the app stopped. They are queued again; the cut-off attempt is kept in the log. */
  interruptedTiles: number[];
  /** Where the runner picks up: the first tile that is not finished. Null when there is none left. */
  nextTile: number | null;
  accepted: number;
  total: number;
  /** The job was being stitched; stitching starts again from the accepted tiles. */
  restitch: boolean;
}

/** Job states that may have been in flight when the app stopped. */
const RESTORABLE: readonly JobState[] = ['preflight', 'running', 'paused', 'stitching'];

/**
 * Call once on startup. Brings jobs that were in flight back to a state the runner can continue from:
 * - a tile cut off mid-attempt is queued again (its attempt is marked `interrupted`);
 * - a job caught in preflight goes back to idle, since nothing had started;
 * - accepted tiles, finished jobs and terminal jobs (`failed`, `cancelled`) are left exactly as they are.
 * Paused jobs stay paused: resuming is the user's decision. Everything is written before it returns.
 */
export function restoreJobs(store: Store): RestoredJob[] {
  const restored: RestoredJob[] = [];
  for (const record of store.listJobs({ states: RESTORABLE })) {
    const jobId = record.job.id;
    const interruptedTiles: number[] = [];

    store.transaction(() => {
      if (record.state === 'preflight') {
        applyJobEvent(store, jobId, { type: 'PREFLIGHT_BLOCKED', reason: 'The app was closed during the pre-run checks. Start again.' });
        return;
      }

      for (const tile of store.listTiles(jobId)) {
        if (tile.state !== 'running') continue;
        for (const attempt of store.listAttempts(jobId, tile.index).filter((a) => a.outcome === null)) {
          store.finishAttempt(attempt.id, { outcome: 'interrupted', message: 'The app stopped while this tile was running.' });
        }
        applyTileEvent(store, jobId, tile.index, { type: 'INTERRUPT' });
        interruptedTiles.push(tile.index);
      }
      if (interruptedTiles.length > 0) {
        store.addEvent(jobId, 'warn', `Restored after a restart: ${interruptedTiles.length} tile(s) were running and are queued again.`, { tiles: interruptedTiles.map((i) => i + 1) });
      } else {
        store.addEvent(jobId, 'info', 'Restored after a restart.');
      }
    });

    const after = store.getJob(jobId)!;
    const tiles = store.listTiles(jobId);
    restored.push({
      jobId,
      state: after.state,
      interruptedTiles,
      nextTile: nextRunnableTile(tiles)?.index ?? null,
      accepted: summarizeTiles(tiles).accepted,
      total: tiles.length,
      restitch: after.state === 'stitching',
    });
  }
  return restored;
}
