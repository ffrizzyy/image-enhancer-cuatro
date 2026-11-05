import type { JobState, PauseReason } from '@ie/contracts';
import { assign, getNextSnapshot, setup } from 'xstate';

export interface JobContext {
  pauseReason: PauseReason | null;
  /** ISO time after which a quota pause may be resumed. */
  resumeAfter: string | null;
  /** Why the job is failed, or why a preflight was blocked. */
  error: string | null;
}

export type JobEvent =
  | { type: 'START' }
  | { type: 'PREFLIGHT_PASSED' }
  /** The session is not ready, the provider health check failed, and so on. The job goes back to idle with the reason. */
  | { type: 'PREFLIGHT_BLOCKED'; reason: string }
  | { type: 'PAUSE'; reason: PauseReason; resumeAfter?: string }
  | { type: 'RESUME' }
  /** Every tile is accepted. */
  | { type: 'TILES_DONE' }
  /** Every tile has finished, but some need a person to look at them. */
  | { type: 'NEEDS_REVIEW' }
  /** The reviewer settled every tile. */
  | { type: 'REVIEW_DONE' }
  /** One tile is run again (by hand, or after being set aside for review). */
  | { type: 'RERUN_TILE' }
  | { type: 'STITCHED' }
  | { type: 'RESTITCH' }
  | { type: 'FAIL'; error: string }
  | { type: 'CANCEL' };

export type JobEventType = JobEvent['type'];

export const JOB_STATES: readonly JobState[] = ['idle', 'preflight', 'running', 'paused', 'needs-review', 'stitching', 'done', 'failed', 'cancelled'];
export const JOB_EVENT_TYPES: readonly JobEventType[] = [
  'START', 'PREFLIGHT_PASSED', 'PREFLIGHT_BLOCKED', 'PAUSE', 'RESUME', 'TILES_DONE', 'NEEDS_REVIEW', 'REVIEW_DONE', 'RERUN_TILE', 'STITCHED', 'RESTITCH', 'FAIL', 'CANCEL',
];

/** A job in one of these states never runs again. */
export const TERMINAL_JOB_STATES: readonly JobState[] = ['failed', 'cancelled'];

/**
 * The job's legal states and transitions. `failed` and `cancelled` are final. `done` can go back to `running`
 * (one tile re-run) or to `stitching` (restitch after a per-tile action), as the Result screen allows.
 */
export const jobMachine = setup({
  types: { context: {} as JobContext, events: {} as JobEvent },
  actions: {
    clear: assign({ pauseReason: () => null, resumeAfter: () => null, error: () => null }),
    fail: assign({ pauseReason: () => null, resumeAfter: () => null, error: ({ event }) => (event.type === 'FAIL' ? event.error : null) }),
    blocked: assign({ error: ({ event }) => (event.type === 'PREFLIGHT_BLOCKED' ? event.reason : null) }),
    pause: assign({
      pauseReason: ({ event }) => (event.type === 'PAUSE' ? event.reason : null),
      resumeAfter: ({ event }) => (event.type === 'PAUSE' ? (event.resumeAfter ?? null) : null),
      error: () => null,
    }),
  },
}).createMachine({
  id: 'job',
  initial: 'idle',
  context: { pauseReason: null, resumeAfter: null, error: null },
  states: {
    idle: { on: { START: { target: 'preflight', actions: 'clear' }, CANCEL: { target: 'cancelled', actions: 'clear' } } },
    preflight: {
      on: {
        PREFLIGHT_PASSED: { target: 'running', actions: 'clear' },
        PREFLIGHT_BLOCKED: { target: 'idle', actions: 'blocked' },
        FAIL: { target: 'failed', actions: 'fail' },
        CANCEL: { target: 'cancelled', actions: 'clear' },
      },
    },
    running: {
      on: {
        PAUSE: { target: 'paused', actions: 'pause' },
        TILES_DONE: { target: 'stitching', actions: 'clear' },
        NEEDS_REVIEW: { target: 'needs-review', actions: 'clear' },
        FAIL: { target: 'failed', actions: 'fail' },
        CANCEL: { target: 'cancelled', actions: 'clear' },
      },
    },
    paused: {
      on: {
        RESUME: { target: 'running', actions: 'clear' },
        FAIL: { target: 'failed', actions: 'fail' },
        CANCEL: { target: 'cancelled', actions: 'clear' },
      },
    },
    'needs-review': {
      on: {
        REVIEW_DONE: { target: 'stitching', actions: 'clear' },
        RERUN_TILE: { target: 'running', actions: 'clear' },
        FAIL: { target: 'failed', actions: 'fail' },
        CANCEL: { target: 'cancelled', actions: 'clear' },
      },
    },
    stitching: {
      on: {
        STITCHED: { target: 'done', actions: 'clear' },
        FAIL: { target: 'failed', actions: 'fail' },
        CANCEL: { target: 'cancelled', actions: 'clear' },
      },
    },
    done: { on: { RERUN_TILE: { target: 'running', actions: 'clear' }, RESTITCH: { target: 'stitching', actions: 'clear' } } },
    failed: { type: 'final' },
    cancelled: { type: 'final' },
  },
});

export type JobTransition =
  | { ok: true; state: JobState; context: JobContext }
  | { ok: false; reason: string };

/** What happens when `event` arrives in `state`: the next state and context, or why it is not allowed. */
export function jobTransition(state: JobState, context: JobContext, event: JobEvent): JobTransition {
  const snapshot = jobMachine.resolveState({ value: state, context });
  if (!snapshot.can(event)) return { ok: false, reason: `A job that is ${state} cannot take "${event.type}".` };
  const next = getNextSnapshot(jobMachine, snapshot, event);
  return { ok: true, state: next.value as JobState, context: next.context };
}

export const emptyJobContext = (): JobContext => ({ pauseReason: null, resumeAfter: null, error: null });

/** Whether any event can still move a job out of `state`. */
export const isTerminal = (state: JobState): boolean => TERMINAL_JOB_STATES.includes(state);
