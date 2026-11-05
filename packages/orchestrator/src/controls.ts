import type { JobRecord, Store } from './store.ts';
import { applyJobEvent, IllegalTransitionError } from './transitions.ts';

/**
 * Pauses a running job at the user's request. The tile being generated finishes first (a provider call cannot be taken
 * back); the runner then stops before the next one. Pausing a job that is already paused does nothing.
 */
export function pauseJob(store: Store, jobId: string): JobRecord {
  return store.transaction(() => {
    const record = store.getJob(jobId);
    if (record?.state === 'paused') return record;
    return applyJobEvent(store, jobId, { type: 'PAUSE', reason: 'user' });
  });
}

/**
 * Cancels a job. Cancelling is final: the job is never run or resumed again, and its accepted tiles stay on disk.
 * Works in every state that can still change; a finished, failed or already cancelled job is left as it is and refused.
 */
export function cancelJob(store: Store, jobId: string): JobRecord {
  return applyJobEvent(store, jobId, { type: 'CANCEL' });
}

export interface ResumeInfo {
  /** The job is paused and may be resumed (it always may be, on the user's command). */
  resumable: boolean;
  /** For a usage-limit pause: how long until the provider's limit has probably reset. Zero when it has, or does not apply. */
  waitMs: number;
  /** Plain words for the user. */
  message: string;
}

const PAUSE_MESSAGES = {
  challenge: 'The provider asked for a human check. Solve it in the provider window, then resume.',
  'logged-out': 'You were logged out of the provider. Log in again in its window, then resume.',
  quota: 'The provider reported a usage limit.',
  user: 'You paused this job.',
} as const;

/** What to tell the user about a paused job, and whether waiting would help. */
export function resumeInfo(record: JobRecord, now: Date = new Date()): ResumeInfo {
  if (record.state !== 'paused' || !record.pauseReason) return { resumable: false, waitMs: 0, message: `This job is ${record.state}, not paused.` };

  const waitMs = record.resumeAfter ? Math.max(0, Date.parse(record.resumeAfter) - now.getTime()) : 0;
  let message: string = PAUSE_MESSAGES[record.pauseReason];
  if (record.pauseReason === 'quota') {
    message += waitMs > 0 ? ` It will probably have reset in about ${Math.ceil(waitMs / 60_000)} minutes; you can resume sooner, but it may stop again.` : ' It has probably reset by now.';
  }
  return { resumable: true, waitMs, message };
}

export { IllegalTransitionError };
