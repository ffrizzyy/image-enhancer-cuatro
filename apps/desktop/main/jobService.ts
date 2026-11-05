import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { CostPreview, Job, JobProgress, JobSummary, Pacing, ProviderId, SessionStatus, ImagePreview } from '@ie/contracts';
import {
  applyJobEvent,
  cancelJob,
  costForTiles,
  IllegalTransitionError,
  jobProgress,
  pauseJob,
  recentJobs,
  restoreJobs,
  runJob,
  type PauseNotice,
  type RestoredJob,
  type RunJobOptions,
  type Store,
  type StoreChange,
} from '@ie/orchestrator';
import type { ProviderAdapter } from '@ie/providers';
import { planTiles } from '@ie/slicer';
import sharp from 'sharp';

export type JobServiceErrorCode = 'not-found' | 'conflict' | 'invalid' | 'illegal';

export class JobServiceError extends Error {
  readonly code: JobServiceErrorCode;

  constructor(code: JobServiceErrorCode, message: string) {
    super(message);
    this.name = 'JobServiceError';
    this.code = code;
  }
}

/** A provider adapter for one run, and how to let go of it afterwards. */
export interface AdapterLease {
  adapter: ProviderAdapter;
  release?: () => void;
}

export interface JobServiceDeps {
  store: Store;
  /** Jobs keep their tiles, outputs and stitched picture in `<dataDir>/jobs/<jobId>`. */
  dataDir: string;
  adapterFor: (providerId: ProviderId) => Promise<AdapterLease>;
  sessionStatus: (providerId: ProviderId) => Promise<SessionStatus>;
  /** Brings the provider window to the front, for a captcha or a login. */
  showProvider?: (providerId: ProviderId) => void | Promise<void>;
  emitProgress: (progress: JobProgress) => void;
  emitLog: (log: { jobId: string; level: 'info' | 'warn' | 'error'; message: string }) => void;
  pacing?: Pacing;
  /** Overrides for tests (no real waiting, a stub stitcher). */
  runOptions?: Partial<RunJobOptions>;
}

export interface JobService {
  /** Saves a newly created job (with its tile plan) so it can be started, survives a restart, and shows in Home. */
  register(job: Job): void;
  /** Starts the pre-run checks and the run in the background; returns at once with where the job is. */
  start(jobId: string): Promise<JobProgress>;
  pause(jobId: string): JobProgress;
  /** Continues a paused job, or one restored after a restart. */
  resume(jobId: string): Promise<JobProgress>;
  cancel(jobId: string): JobProgress;
  get(jobId: string): JobProgress;
  listRecent(limit?: number): JobSummary[];
  /** What a run of this many tiles would cost, before any job exists. */
  costPreview(providerId: ProviderId, tileCount: number): CostPreview;
  tileThumbnail(jobId: string, index: number, maxSide?: number): Promise<ImagePreview>;
  /** Call once on startup: brings jobs that were in flight when the app closed back to a state that can continue. */
  restore(): RestoredJob[];
  /** Wire this to the store's `onCommit`: it turns committed changes into pushed events. */
  notify(change: StoreChange): void;
  /** Resolves when no run is in progress (for tests and for a clean shutdown). */
  whenIdle(): Promise<void>;
  isRunning(jobId: string): boolean;
}

const DEFAULT_THUMBNAIL_PX = 256;

export function createJobService(deps: JobServiceDeps): JobService {
  const { store } = deps;
  const running = new Map<string, { promise: Promise<unknown>; abort: AbortController }>();
  const queued = new Set<string>();

  const progressOf = (jobId: string): JobProgress => {
    const progress = jobProgress(store, jobId);
    if (!progress) throw new JobServiceError('not-found', 'That job no longer exists.');
    return progress;
  };

  /** Runs one illegal-transition-aware action, turning a refused transition into a message. */
  const guard = <T>(action: () => T): T => {
    try {
      return action();
    } catch (error) {
      if (error instanceof IllegalTransitionError) throw new JobServiceError('illegal', error.message);
      throw error;
    }
  };

  function launch(jobId: string): void {
    const record = store.getJob(jobId)!;
    const abort = new AbortController();
    const promise = (async () => {
      let lease: AdapterLease | undefined;
      try {
        lease = await deps.adapterFor(record.job.providerId);
        await runJob({
          store,
          jobId,
          adapter: lease.adapter,
          workDir: path.join(deps.dataDir, 'jobs', jobId),
          getSessionStatus: () => deps.sessionStatus(record.job.providerId),
          signal: abort.signal,
          ...(deps.pacing ? { pacing: deps.pacing } : {}),
          onPause: async (notice: PauseNotice) => {
            // A captcha or a login can only be solved by the person, in the provider's own window.
            if (notice.reason === 'challenge' || notice.reason === 'logged-out') await deps.showProvider?.(notice.providerId);
          },
          ...deps.runOptions,
        });
      } catch (error) {
        // Anything unexpected ends the job with the reason, rather than leaving it looking busy forever.
        const message = error instanceof Error ? error.message : String(error);
        const current = store.getJob(jobId);
        if (current && current.state !== 'failed' && current.state !== 'cancelled' && current.state !== 'done') {
          try {
            if (current.state === 'idle') applyJobEvent(store, jobId, { type: 'START' });
            applyJobEvent(store, jobId, { type: 'FAIL', error: `The run stopped unexpectedly: ${message}` });
          } catch {
            /* the state moved on in the meantime; the event log has the story */
          }
        }
        deps.emitLog({ jobId, level: 'error', message: `The run stopped unexpectedly: ${message}` });
      } finally {
        lease?.release?.();
        running.delete(jobId);
      }
    })();
    running.set(jobId, { promise, abort });
  }

  function assertProviderFree(jobId: string, providerId: ProviderId): void {
    for (const otherId of running.keys()) {
      if (otherId !== jobId && store.getJob(otherId)?.job.providerId === providerId) {
        throw new JobServiceError('conflict', `Another job is already using ${providerId}. Wait for it to finish or pause it first.`);
      }
    }
  }

  function begin(jobId: string, allowed: readonly string[], verb: string): JobProgress {
    const record = store.getJob(jobId);
    if (!record) throw new JobServiceError('not-found', 'That job no longer exists.');
    if (running.has(jobId)) return progressOf(jobId);
    if (!allowed.includes(record.state)) throw new JobServiceError('illegal', `A job that is ${record.state} cannot be ${verb}.`);
    assertProviderFree(jobId, record.job.providerId);
    // Show the pre-run checks at once; the run itself starts as soon as the provider is ready.
    if (record.state === 'idle') applyJobEvent(store, jobId, { type: 'START' });
    launch(jobId);
    return progressOf(jobId);
  }

  /** One progress message per job per burst of writes, sent after the burst. */
  function notify(change: StoreChange): void {
    for (const event of change.events) deps.emitLog({ jobId: event.jobId, level: event.level, message: event.message });
    for (const jobId of change.jobIds) {
      if (queued.has(jobId)) continue;
      queued.add(jobId);
      queueMicrotask(() => {
        queued.delete(jobId);
        try {
          const progress = jobProgress(store, jobId);
          if (progress) deps.emitProgress(progress);
        } catch {
          /* the store was closed (the app is quitting): nobody is listening any more */
        }
      });
    }
  }

  return {
    register(job) {
      const plan = planTiles({ width: job.source.width, height: job.source.height, rows: job.grid.rows, cols: job.grid.cols, overlapPct: job.grid.overlapPct, wrap: job.grid.wrap ?? false });
      mkdirSync(path.join(deps.dataDir, 'jobs', job.id), { recursive: true });
      store.createJob({ job, plan, mode: 'chained' });
    },

    start: async (jobId) => begin(jobId, ['idle'], 'started'),
    resume: async (jobId) => begin(jobId, ['paused', 'running', 'needs-review', 'stitching'], 'resumed'),

    pause: (jobId) => {
      if (!store.getJob(jobId)) throw new JobServiceError('not-found', 'That job no longer exists.');
      guard(() => pauseJob(store, jobId));
      return progressOf(jobId);
    },

    cancel: (jobId) => {
      if (!store.getJob(jobId)) throw new JobServiceError('not-found', 'That job no longer exists.');
      guard(() => cancelJob(store, jobId));
      running.get(jobId)?.abort.abort();
      return progressOf(jobId);
    },

    get: progressOf,
    listRecent: (limit) => recentJobs(store, limit ?? 10),
    costPreview: (providerId, tileCount) => costForTiles(tileCount, providerId, deps.pacing),

    async tileThumbnail(jobId, index, maxSide = DEFAULT_THUMBNAIL_PX) {
      const tile = store.getTile(jobId, index);
      if (!tile) throw new JobServiceError('not-found', 'That tile does not exist.');
      // The tile's output when it has one, otherwise the piece of the picture it will be made from.
      const source = tile.outputPath ?? path.join(deps.dataDir, 'jobs', jobId, 'tiles', `tile-${String(index).padStart(3, '0')}.png`);
      try {
        const { data, info } = await sharp(source).resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer({ resolveWithObject: true });
        return { dataUrl: `data:image/jpeg;base64,${data.toString('base64')}`, width: info.width, height: info.height };
      } catch {
        throw new JobServiceError('not-found', 'The picture for this tile is not available.');
      }
    },

    restore: () => restoreJobs(store),
    notify,
    isRunning: (jobId) => running.has(jobId),
    async whenIdle() {
      while (running.size > 0) await Promise.all([...running.values()].map((r) => r.promise));
    },
  };
}
