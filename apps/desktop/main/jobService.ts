import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import type { CostPreview, ExportRequest, ExportResult, Job, JobProgress, JobResultView, JobSummary, Pacing, ProviderId, SessionStatus, ImagePreview, TileOverridePatch } from '@ie/contracts';
import {
  applyJobEvent,
  applyTileEvent,
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
import { exportImage } from '@ie/stitcher';
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
  /** Puts the provider window back the way the user wants it (hidden unless Watch mode is on), when a job resumes. */
  restoreWindow?: (providerId: ProviderId) => void | Promise<void>;
  /** A job paused by the provider, not by the user, resumes by itself once the cause is gone. */
  autoResume?: { settleMs?: number; maxInARow?: number };
  emitProgress: (progress: JobProgress) => void;
  emitLog: (log: { jobId: string; level: 'info' | 'warn' | 'error'; message: string }) => void;
  /** Fixed pacing, or a function read at the start of every run so a Settings change applies to the next job. */
  pacing?: Pacing | (() => Pacing);
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
  /** Review: keeps a tile that was set aside exactly as its best attempt came back. */
  acceptTile(jobId: string, index: number): JobProgress;
  /** Review: queues a tile to be generated again (with a fresh set of retries) and carries on with the job. */
  rerunTile(jobId: string, index: number): Promise<JobProgress>;
  /** Changes one tile's own prompt or source picture, ready for the next run of that tile. */
  setTileOverride(jobId: string, index: number, patch: TileOverridePatch): Promise<JobProgress>;
  /** The stitched picture and its metrics, as pictures the renderer can draw. */
  result(jobId: string, maxSide?: number): Promise<JobResultView>;
  /** Writes the finished picture in the chosen format; the caller resolves the destination (the save dialog). */
  save(request: ExportRequest): Promise<ExportResult>;
  /** Review: every tile is settled, so the picture is put together. */
  finishReview(jobId: string): Promise<JobProgress>;
  /** Tell the service a provider's session status changed: a job paused for a check or login resumes once it is `ready`. */
  onSessionStatus(providerId: ProviderId, status: SessionStatus): void;
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
/**
 * The largest preview `jobs.result` accepts. The Result screen compares at up to 400%, so a small preview would be
 * visibly blurry there; the contract's upper bound is the right default.
 */
const DEFAULT_RESULT_PREVIEW_PX = 4096;

/** A downscaled JPEG of a file on disk, as a data URL the renderer can draw. */
async function previewImage(file: string, maxSide: number): Promise<ImagePreview> {
  const { data, info } = await sharp(file)
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    // 4:4:4 keeps the colour detail (thin lines and edges) that a before/after comparison needs to be readable.
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer({ resolveWithObject: true });
  return { dataUrl: `data:image/jpeg;base64,${data.toString('base64')}`, width: info.width, height: info.height };
}

export function createJobService(deps: JobServiceDeps): JobService {
  const { store } = deps;
  const running = new Map<string, { promise: Promise<unknown>; abort: AbortController }>();
  const queued = new Set<string>();

  // Auto-resume: at most `maxInARow` times without a tile finishing in between, so a problem the provider keeps
  // reporting cannot make a job pause and resume forever.
  const settleMs = deps.autoResume?.settleMs ?? 3000;
  const maxInARow = deps.autoResume?.maxInARow ?? 3;
  const autoCount = new Map<string, { count: number; completedAtLast: number }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const clearTimer = (jobId: string): void => {
    const timer = timers.get(jobId);
    if (timer) clearTimeout(timer);
    timers.delete(jobId);
  };

  function scheduleAutoResume(jobId: string, delayMs: number): void {
    clearTimer(jobId);
    const timer = setTimeout(() => {
      timers.delete(jobId);
      try {
        tryAutoResume(jobId);
      } catch {
        /* the database was closed (the app is quitting): there is nothing left to resume */
      }
    }, Math.min(Math.max(0, delayMs), 24 * 60 * 60 * 1000));
    timer.unref?.();
    timers.set(jobId, timer);
  }

  function tryAutoResume(jobId: string): void {
    const record = store.getJob(jobId);
    if (!record || record.state !== 'paused' || running.has(jobId)) return;
    if (record.pauseReason === 'user' || record.pauseReason === null) return; // only what the provider caused
    const completed = store.listTiles(jobId).filter((t) => t.state === 'accepted').length;
    const seen = autoCount.get(jobId) ?? { count: 0, completedAtLast: completed };
    const count = completed > seen.completedAtLast ? 0 : seen.count;
    if (count >= maxInARow) {
      deps.emitLog({ jobId, level: 'warn', message: 'The job keeps pausing for the same reason, so it will not resume by itself again. Resume it when you have looked at the provider.' });
      return;
    }
    autoCount.set(jobId, { count: count + 1, completedAtLast: completed });
    deps.emitLog({ jobId, level: 'info', message: 'Resuming by itself: the provider looks fine again.' });
    try {
      begin(jobId, ['paused'], 'resumed');
    } catch (error) {
      deps.emitLog({ jobId, level: 'warn', message: `It could not resume by itself: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

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

  const currentPacing = (): Pacing => (typeof deps.pacing === 'function' ? deps.pacing() : deps.pacing!);

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
          ...(deps.pacing ? { pacing: currentPacing() } : {}),
          onPause: async (notice: PauseNotice) => {
            // A captcha or a login can only be solved by the person, in the provider's own window.
            if (notice.reason === 'challenge' || notice.reason === 'logged-out') await deps.showProvider?.(notice.providerId);

            // Then wait for the cause to go away. A usage limit waits for its time; a check or login resumes when the
            // session monitor reports the provider ready (below), or soon if it already does.
            if (notice.reason === 'quota') {
              scheduleAutoResume(jobId, notice.resumeAfter ? Date.parse(notice.resumeAfter) - Date.now() : settleMs);
            } else if ((await deps.sessionStatus(notice.providerId)) === 'ready') {
              scheduleAutoResume(jobId, settleMs);
            }
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
    clearTimer(jobId);
    // Show the pre-run checks at once; the run itself starts as soon as the provider is ready.
    if (record.state === 'idle') applyJobEvent(store, jobId, { type: 'START' });
    // Coming back from a pause (a check, a login), the window the person used goes back to how they want it.
    if (record.state === 'paused') void Promise.resolve(deps.restoreWindow?.(record.job.providerId)).catch(() => {});
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
      clearTimer(jobId);
      running.get(jobId)?.abort.abort();
      return progressOf(jobId);
    },

    acceptTile(jobId, index) {
      if (!store.getJob(jobId)) throw new JobServiceError('not-found', 'That job no longer exists.');
      const tile = store.getTile(jobId, index);
      if (!tile) throw new JobServiceError('not-found', 'That tile does not exist.');
      if (tile.state !== 'needs-review') throw new JobServiceError('illegal', `Only a tile that needs review can be accepted as it is; this one is ${tile.state}.`);
      if (!tile.outputPath) throw new JobServiceError('illegal', 'This tile has no picture to keep. Try it again instead.');
      guard(() => applyTileEvent(store, jobId, index, { type: 'ACCEPT_AS_IS' }));
      store.addEvent(jobId, 'warn', `Tile ${index + 1}: accepted as it is, without passing the quality check.`);
      return progressOf(jobId);
    },

    async rerunTile(jobId, index) {
      const record = store.getJob(jobId);
      if (!record) throw new JobServiceError('not-found', 'That job no longer exists.');
      if (!store.getTile(jobId, index)) throw new JobServiceError('not-found', 'That tile does not exist.');
      if (!['needs-review', 'done', 'paused', 'running'].includes(record.state)) throw new JobServiceError('illegal', `A tile cannot be re-run while the job is ${record.state}.`);
      guard(() => applyTileEvent(store, jobId, index, { type: 'RERUN' }));
      // A running job picks the tile up by itself; a finished or reviewing one is started again; a paused one waits for Resume.
      if (!running.has(jobId) && (record.state === 'needs-review' || record.state === 'done')) return begin(jobId, ['needs-review', 'done'], 're-run');
      return progressOf(jobId);
    },

    async setTileOverride(jobId, index, patch) {
      const record = store.getJob(jobId);
      if (!record) throw new JobServiceError('not-found', 'That job no longer exists.');
      const tile = store.getTile(jobId, index);
      if (!tile) throw new JobServiceError('not-found', 'That tile does not exist.');
      if (record.state === 'failed' || record.state === 'cancelled') throw new JobServiceError('illegal', `A job that is ${record.state} cannot change a tile.`);
      if (tile.state === 'running') throw new JobServiceError('illegal', 'This tile is being generated right now. Wait for it to finish, then change it.');

      const planTile = record.plan.tiles[index];
      if (!planTile) throw new JobServiceError('not-found', 'That tile does not exist.');

      let prompt = tile.promptOverride;
      if (patch.prompt !== undefined) {
        const trimmed = patch.prompt?.trim() ?? '';
        if (trimmed.length > 2000) throw new JobServiceError('invalid', 'A tile prompt can be at most 2000 characters.');
        prompt = trimmed.length > 0 ? trimmed : null;
      }

      let sourceOverride = tile.sourceOverride;
      if (patch.sourcePath !== undefined) {
        if (patch.sourcePath) {
          const dir = path.join(deps.dataDir, 'jobs', jobId, 'tiles');
          mkdirSync(dir, { recursive: true });
          const target = path.join(dir, `tile-${String(index).padStart(3, '0')}-source.png`);
          try {
            await sharp(patch.sourcePath)
              .rotate()
              .resize({ width: planTile.send.width, height: planTile.send.height, fit: 'fill' })
              .png()
              .toFile(target);
          } catch (error) {
            throw new JobServiceError('invalid', `That picture could not be used for tile ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
          }
          sourceOverride = target;
        } else {
          if (sourceOverride) rmSync(sourceOverride, { force: true });
          sourceOverride = null;
        }
      }

      store.transaction(() => {
        store.updateTile(jobId, index, { promptOverride: prompt, sourceOverride });
        const changed = [
          patch.prompt !== undefined ? 'prompt' : null,
          patch.sourcePath !== undefined ? 'source picture' : null,
        ].filter((part): part is string => part !== null);
        store.addEvent(jobId, 'info', `Tile ${index + 1}: its ${changed.join(' and ')} changed for the next run.`);
      });
      return progressOf(jobId);
    },

    async result(jobId, maxSide = DEFAULT_RESULT_PREVIEW_PX) {
      const record = store.getJob(jobId);
      if (!record) throw new JobServiceError('not-found', 'That job no longer exists.');
      if (!record.result) throw new JobServiceError('illegal', 'The picture has not been put together yet.');
      try {
        const [sourcePreview, preview, finished] = await Promise.all([
          previewImage(record.job.source.path, maxSide),
          previewImage(record.result.imagePath, maxSide),
          sharp(record.result.imagePath).metadata(),
        ]);
        return {
          jobId,
          ...record.result,
          // The finished picture can be larger than the original when the provider returned extra detail.
          width: finished.width ?? record.plan.source.width,
          height: finished.height ?? record.plan.source.height,
          plan: record.plan,
          sourcePreview,
          preview,
        };
      } catch (error) {
        throw new JobServiceError('not-found', `The picture is no longer available on disk: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    async save(request) {
      if (!request.destination) throw new JobServiceError('invalid', 'A place to save the picture is required.');
      // Only a picture the app itself produced can be exported, so this channel cannot be used to read arbitrary files.
      const record = store.listJobs().find((candidate) => candidate.result?.imagePath === request.imagePath);
      if (!record) throw new JobServiceError('not-found', 'That picture is not a saved job result.');
      try {
        return await exportImage({
          imagePath: request.imagePath,
          destination: request.destination,
          format: request.format,
          ...(request.quality !== undefined ? { quality: request.quality } : {}),
        });
      } catch (error) {
        throw new JobServiceError('invalid', `The picture could not be saved: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    async finishReview(jobId) {
      const record = store.getJob(jobId);
      if (!record) throw new JobServiceError('not-found', 'That job no longer exists.');
      if (record.state !== 'needs-review') throw new JobServiceError('illegal', `A job that is ${record.state} is not waiting for a review.`);
      const waiting = store.listTiles(jobId).find((t) => t.state === 'needs-review' || t.state === 'failed' || t.state === 'pending' || t.state === 'retrying' || t.state === 'running');
      if (waiting) throw new JobServiceError('illegal', `Tile ${waiting.index + 1} still needs a decision: accept it as it is, or try it again.`);
      guard(() => applyJobEvent(store, jobId, { type: 'REVIEW_DONE' }));
      return begin(jobId, ['stitching'], 'stitched');
    },

    onSessionStatus(providerId, status) {
      if (status !== 'ready') return;
      for (const record of store.listJobs({ states: ['paused'] })) {
        if (record.job.providerId !== providerId || running.has(record.job.id)) continue;
        if (record.pauseReason === 'challenge' || record.pauseReason === 'logged-out') scheduleAutoResume(record.job.id, 500);
      }
    },

    get: progressOf,
    listRecent: (limit) => recentJobs(store, limit ?? 10),
    costPreview: (providerId, tileCount) => costForTiles(tileCount, providerId, deps.pacing ? currentPacing() : undefined),

    async tileThumbnail(jobId, index, maxSide = DEFAULT_THUMBNAIL_PX) {
      const tile = store.getTile(jobId, index);
      if (!tile) throw new JobServiceError('not-found', 'That tile does not exist.');
      // The tile's output when it has one, otherwise the piece of the picture it will be made from (or its own source).
      const source = tile.outputPath ?? tile.sourceOverride ?? path.join(deps.dataDir, 'jobs', jobId, 'tiles', `tile-${String(index).padStart(3, '0')}.png`);
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
