import type { JobState, TileState } from '@ie/contracts';

import { jobTransition, type JobEvent } from './jobMachine.ts';
import type { AttemptRecord, JobRecord, Store, TilePatch, TileRecord } from './store.ts';
import { tileTransition, type TileEvent } from './tileMachine.ts';

export class IllegalTransitionError extends Error {
  readonly from: JobState | TileState;
  readonly event: string;

  constructor(from: JobState | TileState, event: string, reason: string) {
    super(reason);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.event = event;
  }
}

/**
 * Applies a job event: checks the machine, then writes the new state in one transaction. An event the machine does
 * not allow throws and changes nothing, so a stray or repeated call can never put a job in an impossible state.
 */
export function applyJobEvent(store: Store, jobId: string, event: JobEvent): JobRecord {
  return store.transaction(() => {
    const record = store.getJob(jobId);
    if (!record) throw new IllegalTransitionError('idle', event.type, `No job "${jobId}".`);
    const next = jobTransition(record.state, { pauseReason: record.pauseReason, resumeAfter: record.resumeAfter, error: record.error }, event);
    if (!next.ok) throw new IllegalTransitionError(record.state, event.type, next.reason);
    return store.setJobState(jobId, next.state, next.context);
  });
}

/** Tries a tile has used since it was last queued by hand. */
export const triesUsed = (tile: Pick<TileRecord, 'attempts' | 'attemptBase'>): number => tile.attempts - tile.attemptBase;

/** Applies a tile event other than START (use `beginTile`). `patch` is saved in the same step, for example the output path. */
export function applyTileEvent(store: Store, jobId: string, index: number, event: Exclude<TileEvent, { type: 'START' }>, patch: Omit<TilePatch, 'state' | 'attemptBase'> = {}): TileRecord {
  return store.transaction(() => {
    const tile = store.getTile(jobId, index);
    if (!tile) throw new IllegalTransitionError('pending', event.type, `No tile ${index} in job "${jobId}".`);
    const next = tileTransition(tile.state, triesUsed(tile), event);
    if (!next.ok) throw new IllegalTransitionError(tile.state, event.type, next.reason);
    // A manual re-run starts a fresh set of automatic retries.
    const base = event.type === 'RERUN' ? { attemptBase: tile.attempts } : {};
    return store.updateTile(jobId, index, { ...patch, ...base, state: next.state });
  });
}

/** Starts the next try of a tile: checks the machine, then records the attempt and marks the tile running together. */
export function beginTile(store: Store, jobId: string, index: number): AttemptRecord {
  return store.transaction(() => {
    const tile = store.getTile(jobId, index);
    if (!tile) throw new IllegalTransitionError('pending', 'START', `No tile ${index} in job "${jobId}".`);
    const next = tileTransition(tile.state, triesUsed(tile), { type: 'START' });
    if (!next.ok) throw new IllegalTransitionError(tile.state, 'START', next.reason);
    return store.startAttempt(jobId, index);
  });
}
