import path from 'node:path';

import type { JobState, Pacing, PauseReason, ProviderId, SessionStatus, StitchInput, StitchOptions } from '@ie/contracts';
import { getCategory } from '@ie/presets';
import type { ProviderAdapter } from '@ie/providers';
import { stitch, type StitchIo, type StitchReport } from '@ie/stitcher';

import { prepareJobFiles } from './attachments.ts';
import { isTerminal } from './jobMachine.ts';
import { backoffDelayMs, DEFAULT_BACKOFF, DEFAULT_PACING, pacingDelayMs, validatePacing, type Backoff } from './pacing.ts';
import { preflight, type PreflightResult } from './preflight.ts';
import { isRunnable, settledOutcome } from './resume.ts';
import type { Store, TileRecord } from './store.ts';
import { runTile, type TileOutcome } from './tileRunner.ts';
import { applyJobEvent } from './transitions.ts';

export const DEFAULT_STITCH_OPTIONS: StitchOptions = { blend: 'multiband', maxShiftPx: 8, harmonize: true };

export type StitchFn = (input: StitchInput, io: StitchIo) => Promise<StitchReport>;

export interface RunJobOptions {
  store: Store;
  jobId: string;
  adapter: ProviderAdapter;
  /** Folder for this job's tiles, outputs and stitched result. */
  workDir: string;
  /** The session monitor's current status for the job's provider. */
  getSessionStatus: () => Promise<SessionStatus>;
  pacing?: Pacing;
  /** Waits before retrying a tile after a passing provider problem (a timeout, a failed download). */
  backoff?: Backoff;
  /**
   * Called once the job has been paused and the pause is saved: the place to bring the provider's window to the
   * front for a captcha or a login, or to tell the user about a usage limit. The job is not running while it waits.
   */
  onPause?: (pause: PauseNotice) => void | Promise<void>;
  /** Waits between tiles. Defaults to a real timer; tests and the simulation pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
  /** Aborting cancels the job between tiles. */
  signal?: AbortSignal;
  stitchFn?: StitchFn;
  stitchOptions?: StitchOptions;
  timeoutMs?: number;
  /** Told about each tile outcome (for progress displays). */
  onTile?: (index: number, outcome: TileOutcome) => void;
}

export interface PauseNotice {
  jobId: string;
  providerId: ProviderId;
  reason: PauseReason;
  /** For a usage limit: when it may have reset. */
  resumeAfter: string | null;
  message: string;
}

export interface RunJobResult {
  /** Where the job is when this returns: done, paused, needs-review, failed, cancelled, or idle (preflight blocked). */
  state: JobState;
  preflight?: PreflightResult;
  stitched?: StitchReport;
  /** Why it stopped, when it stopped early. */
  message?: string;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs a job as far as it can go: preflight, every tile in turn (retrying and setting aside as the rules say), then
 * stitching. It returns when the job is done, needs the user (paused, needs-review), or can go no further (failed,
 * cancelled). Safe to call again on a paused job, after a restart, or after a tile was queued for a re-run.
 *
 * `chained` jobs run one tile at a time in raster order, each given the strip of its finished neighbour.
 * `independent` jobs may run `pacing.concurrency` tiles at once and in any order.
 */
export async function runJob(options: RunJobOptions): Promise<RunJobResult> {
  const { store, jobId, adapter } = options;
  const pacing = validatePacing(options.pacing ?? DEFAULT_PACING);
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;

  const initial = store.getJob(jobId);
  if (!initial) throw new Error(`No job "${jobId}".`);
  const category = getCategory(initial.job.categoryId);
  if (!category || category.kind !== 'prompt') {
    const error = `The category "${initial.job.categoryId}" is not available.`;
    if (initial.state === 'idle') applyJobEvent(store, jobId, { type: 'START' }); // a job fails from preflight on, not from idle
    if (!isTerminal(initial.state)) applyJobEvent(store, jobId, { type: 'FAIL', error });
    return { state: store.getJob(jobId)!.state, message: error };
  }

  let result: RunJobResult = { state: initial.state };
  const finish = (extra: Omit<RunJobResult, 'state'> = {}): RunJobResult => ({ ...result, ...extra, state: store.getJob(jobId)!.state });

  // 1. Bring the job to `running` (or straight to stitching).
  const state = initial.state;
  if (state === 'failed' || state === 'cancelled') return { state, message: `This job is ${state} and cannot be run again.` };
  if (state === 'idle') {
    applyJobEvent(store, jobId, { type: 'START' });
    const check = await preflight({ adapter, providerId: initial.job.providerId, sessionStatus: await options.getSessionStatus(), plan: initial.plan, pacing });
    result = { ...result, preflight: check };
    if (!check.ok) {
      applyJobEvent(store, jobId, { type: 'PREFLIGHT_BLOCKED', reason: check.reasons.join(' ') });
      return finish({ message: check.reasons.join(' ') });
    }
    applyJobEvent(store, jobId, { type: 'PREFLIGHT_PASSED' });
  } else if (state === 'paused') {
    applyJobEvent(store, jobId, { type: 'RESUME' });
  } else if ((state === 'needs-review' || state === 'done') && store.listTiles(jobId).some(isRunnable)) {
    applyJobEvent(store, jobId, { type: 'RERUN_TILE' });
  } else if (state === 'preflight') {
    return { state, message: 'The job is still in its pre-run checks.' };
  }

  const files = await prepareJobFiles(store.getJob(jobId)!, options.workDir);
  const chained = initial.mode === 'chained';
  const concurrency = chained ? 1 : pacing.concurrency;
  const deps = { store, adapter, files, category, chained, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}), ...(options.now ? { now: options.now } : {}) };

  // 2. Tiles.
  while (store.getJob(jobId)!.state === 'running') {
    if (options.signal?.aborted) {
      applyJobEvent(store, jobId, { type: 'CANCEL' });
      return finish({ message: 'Cancelled.' });
    }

    const tiles = store.listTiles(jobId);
    if (settledOutcome(tiles) !== 'in-progress') break;

    const batch = pickBatch(tiles, concurrency);
    if (batch.length === 0) break;
    const outcomes = await Promise.all(batch.map(async (tile) => ({ tile, outcome: await runTile(deps, jobId, tile.index) })));

    for (const { tile, outcome } of outcomes) options.onTile?.(tile.index, outcome);
    const stop = outcomes.find(({ outcome }) => outcome.kind === 'pause' || outcome.kind === 'job-failed');
    if (stop) {
      const { outcome } = stop;
      if (outcome.kind === 'pause') {
        applyJobEvent(store, jobId, { type: 'PAUSE', reason: outcome.reason, ...(outcome.resumeAfter ? { resumeAfter: outcome.resumeAfter } : {}) });
        // The pause is saved first; only then is the user told, so a crash in the callback loses nothing.
        await options.onPause?.({ jobId, providerId: initial.job.providerId, reason: outcome.reason, resumeAfter: outcome.resumeAfter ?? null, message: outcome.message });
        return finish({ message: outcome.message });
      }
      if (outcome.kind === 'job-failed') {
        applyJobEvent(store, jobId, { type: 'FAIL', error: outcome.error });
        return finish({ message: outcome.error });
      }
    }

    // Wait before the next call, unless nothing is left: a longer, growing wait after a passing provider problem,
    // otherwise the usual random pause. (Neither is a busy loop: the job simply sleeps.)
    const remaining = store.listTiles(jobId);
    if (settledOutcome(remaining) === 'in-progress' && store.getJob(jobId)!.state === 'running') {
      const transient = outcomes.filter(({ outcome }) => outcome.kind === 'rejected' && outcome.transient && !outcome.needsReview);
      if (transient.length > 0) {
        const worst = Math.max(...transient.map(({ tile }) => store.getTile(jobId, tile.index)!.attempts - store.getTile(jobId, tile.index)!.attemptBase));
        await sleep(backoffDelayMs(worst, backoff, random));
      } else {
        await sleep(pacingDelayMs(pacing, random));
      }
    }
  }

  // 3. What next?
  if (store.getJob(jobId)!.state === 'running') {
    const outcome = settledOutcome(store.listTiles(jobId));
    if (outcome === 'needs-review') {
      applyJobEvent(store, jobId, { type: 'NEEDS_REVIEW' });
      return finish({ message: 'Some tiles need a look before the picture can be stitched.' });
    }
    applyJobEvent(store, jobId, { type: 'TILES_DONE' });
  }

  // 4. Stitch.
  if (store.getJob(jobId)!.state === 'stitching') {
    const stitched = await stitchJob(options, files.dir);
    if (stitched.ok) {
      applyJobEvent(store, jobId, { type: 'STITCHED' });
      return finish({ stitched: stitched.report });
    }
    applyJobEvent(store, jobId, { type: 'FAIL', error: stitched.error });
    return finish({ message: stitched.error });
  }
  return finish();
}

/** Tiles to run next: the first in raster order when chained, otherwise up to `concurrency` of them. */
function pickBatch(tiles: readonly TileRecord[], concurrency: number): TileRecord[] {
  return tiles.filter(isRunnable).slice(0, concurrency);
}

async function stitchJob(options: RunJobOptions, workDir: string): Promise<{ ok: true; report: StitchReport } | { ok: false; error: string }> {
  const record = options.store.getJob(options.jobId)!;
  const tiles = options.store.listTiles(options.jobId);
  const missing = tiles.filter((t) => !t.outputPath);
  if (missing.length > 0) return { ok: false, error: `Tile ${missing[0]!.index + 1} has no usable output, so the picture cannot be stitched.` };

  try {
    const report = await (options.stitchFn ?? stitch)(
      { plan: record.plan, tiles: tiles.map((t) => ({ index: t.index, path: t.outputPath! })), options: options.stitchOptions ?? DEFAULT_STITCH_OPTIONS },
      { sourcePath: record.job.source.path, outDir: path.join(workDir, 'stitched') },
    );
    return { ok: true, report };
  } catch (error) {
    return { ok: false, error: `Stitching failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
