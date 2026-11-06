import type { JobProgress, JobSummary, ProviderErrorKind, TileProgress } from '@ie/contracts';

import type { JobRecord, Store, TileRecord } from './store.ts';

/** The ways a provider call can end in an error: the attempt's `errorKind` is one of these when it is one we know. */
const ERROR_KINDS: readonly ProviderErrorKind[] = ['logged-out', 'challenge', 'quota', 'refusal', 'timeout', 'ui-changed', 'download-failed'];

/** Tiles that no longer need anything from the runner: accepted, or set aside for a person. Both count as "completed". */
const isCompleted = (tile: TileRecord): boolean => tile.state === 'accepted';

function tileProgress(store: Store, jobId: string, tile: TileRecord): TileProgress {
  const last = store.listAttempts(jobId, tile.index).at(-1);
  const errorKind = ERROR_KINDS.find((k) => k === last?.errorKind);
  return {
    index: tile.index,
    state: tile.state,
    attempts: tile.attempts,
    ...(tile.outputPath ? { outputPath: tile.outputPath } : {}),
    ...(errorKind && tile.state !== 'accepted' ? { errorKind } : {}),
    ...(tile.note ? { note: tile.note } : {}),
    ...(tile.promptOverride ? { promptOverride: tile.promptOverride } : {}),
    ...(tile.sourceOverride ? { sourceOverride: tile.sourceOverride } : {}),
  };
}

/** A job as the Run screen sees it: its state, why it is paused or failed, and every tile. */
export function jobProgress(store: Store, jobId: string): JobProgress | null {
  const record: JobRecord | null = store.getJob(jobId);
  if (!record) return null;
  const tiles = store.listTiles(jobId);
  return {
    jobId,
    state: record.state,
    providerId: record.job.providerId,
    prompt: record.job.prompt,
    grid: { rows: record.plan.grid.rows, cols: record.plan.grid.cols },
    ...(record.pauseReason ? { pauseReason: record.pauseReason } : {}),
    ...(record.resumeAfter ? { resumeAfter: record.resumeAfter } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(record.result ? { result: record.result } : {}),
    completedTiles: tiles.filter(isCompleted).length,
    totalTiles: tiles.length,
    tiles: tiles.map((t) => tileProgress(store, jobId, t)),
  };
}

/** The newest jobs, for the Home list. */
export function recentJobs(store: Store, limit = 10): JobSummary[] {
  return store.listJobs({ limit }).map((record) => {
    const tiles = store.listTiles(record.job.id);
    return {
      id: record.job.id,
      createdAt: record.job.createdAt,
      state: record.state,
      completedTiles: tiles.filter(isCompleted).length,
      totalTiles: tiles.length,
    };
  });
}
