import type { JobState, TileState } from '@ie/contracts';
import { describe, expect, it } from 'vitest';

import {
  emptyJobContext,
  isTerminal,
  JOB_EVENT_TYPES,
  JOB_STATES,
  jobTransition,
  MAX_ATTEMPTS,
  TILE_EVENT_TYPES,
  TILE_STATES,
  tileTransition,
  type JobEvent,
  type JobEventType,
  type TileEvent,
  type TileEventType,
} from '../src';

const eventOf = (type: JobEventType): JobEvent => {
  switch (type) {
    case 'PREFLIGHT_BLOCKED':
      return { type, reason: 'Gemini is not ready' };
    case 'PAUSE':
      return { type, reason: 'quota', resumeAfter: '2026-11-05T18:00:00.000Z' };
    case 'FAIL':
      return { type, error: 'Missing selector: submitButton' };
    default:
      return { type } as JobEvent;
  }
};

/** The whole job state machine, written out by hand from the spec: every other pair must be refused. */
const JOB_TABLE: Record<JobState, Partial<Record<JobEventType, JobState>>> = {
  idle: { START: 'preflight', CANCEL: 'cancelled' },
  preflight: { PREFLIGHT_PASSED: 'running', PREFLIGHT_BLOCKED: 'idle', FAIL: 'failed', CANCEL: 'cancelled' },
  running: { PAUSE: 'paused', TILES_DONE: 'stitching', NEEDS_REVIEW: 'needs-review', FAIL: 'failed', CANCEL: 'cancelled' },
  paused: { RESUME: 'running', FAIL: 'failed', CANCEL: 'cancelled' },
  'needs-review': { REVIEW_DONE: 'stitching', RERUN_TILE: 'running', FAIL: 'failed', CANCEL: 'cancelled' },
  stitching: { STITCHED: 'done', FAIL: 'failed', CANCEL: 'cancelled' },
  done: { RERUN_TILE: 'running', RESTITCH: 'stitching' },
  failed: {},
  cancelled: {},
};

describe('job state machine', () => {
  it('covers every state and event', () => {
    expect(Object.keys(JOB_TABLE).sort()).toEqual([...JOB_STATES].sort());
  });

  for (const state of JOB_STATES) {
    for (const type of JOB_EVENT_TYPES) {
      const expected = JOB_TABLE[state][type];
      it(`${state} + ${type} ${expected ? `-> ${expected}` : 'is refused'}`, () => {
        const result = jobTransition(state, emptyJobContext(), eventOf(type));
        if (expected) expect(result).toMatchObject({ ok: true, state: expected });
        else expect(result).toMatchObject({ ok: false, reason: expect.stringContaining(`${state} cannot take "${type}"`) });
      });
    }
  }

  it('failed and cancelled are terminal: nothing moves them', () => {
    for (const state of ['failed', 'cancelled'] as const) {
      expect(isTerminal(state)).toBe(true);
      for (const type of JOB_EVENT_TYPES) expect(jobTransition(state, emptyJobContext(), eventOf(type)).ok).toBe(false);
    }
    for (const state of JOB_STATES.filter((s) => s !== 'failed' && s !== 'cancelled')) expect(isTerminal(state)).toBe(false);
  });

  it('a pause carries its reason and resume time, which resuming clears', () => {
    const paused = jobTransition('running', emptyJobContext(), { type: 'PAUSE', reason: 'quota', resumeAfter: '2026-11-05T18:00:00.000Z' });
    expect(paused).toMatchObject({ ok: true, state: 'paused', context: { pauseReason: 'quota', resumeAfter: '2026-11-05T18:00:00.000Z', error: null } });

    const noTime = jobTransition('running', emptyJobContext(), { type: 'PAUSE', reason: 'challenge' });
    expect(noTime).toMatchObject({ context: { pauseReason: 'challenge', resumeAfter: null } });

    if (!paused.ok) throw new Error('unreachable');
    expect(jobTransition('paused', paused.context, { type: 'RESUME' })).toMatchObject({ ok: true, state: 'running', context: { pauseReason: null, resumeAfter: null } });
  });

  it('a failure keeps its reason; a blocked preflight returns to idle with the reason', () => {
    expect(jobTransition('running', emptyJobContext(), { type: 'FAIL', error: 'Missing selector: submitButton' })).toMatchObject({
      state: 'failed',
      context: { error: 'Missing selector: submitButton', pauseReason: null },
    });
    expect(jobTransition('preflight', emptyJobContext(), { type: 'PREFLIGHT_BLOCKED', reason: 'Gemini is logged out' })).toMatchObject({
      ok: true,
      state: 'idle',
      context: { error: 'Gemini is logged out' },
    });
  });

  it('starting again after a blocked preflight clears the old reason', () => {
    expect(jobTransition('idle', { pauseReason: null, resumeAfter: null, error: 'Gemini is logged out' }, { type: 'START' })).toMatchObject({ context: { error: null } });
  });

  it('a finished job can have a tile re-run or be restitched, as the Result screen allows', () => {
    expect(jobTransition('done', emptyJobContext(), { type: 'RERUN_TILE' })).toMatchObject({ state: 'running' });
    expect(jobTransition('done', emptyJobContext(), { type: 'RESTITCH' })).toMatchObject({ state: 'stitching' });
  });
});

const tileEventOf = (type: TileEventType): TileEvent => ({ type }) as TileEvent;

const TILE_TABLE: Record<TileState, Partial<Record<TileEventType, TileState>>> = {
  pending: { START: 'running' },
  retrying: { START: 'running' },
  running: { ACCEPT: 'accepted', REJECT: 'retrying', FAIL: 'failed', INTERRUPT: 'pending' },
  accepted: { RERUN: 'pending' },
  'needs-review': { ACCEPT_AS_IS: 'accepted', RERUN: 'pending' },
  failed: { RERUN: 'pending' },
};

describe('tile state machine', () => {
  it('covers every state and event', () => {
    expect(Object.keys(TILE_TABLE).sort()).toEqual([...TILE_STATES].sort());
  });

  for (const state of TILE_STATES) {
    for (const type of TILE_EVENT_TYPES) {
      const expected = TILE_TABLE[state][type];
      it(`${state} + ${type} ${expected ? `-> ${expected}` : 'is refused'}`, () => {
        const result = tileTransition(state, 1, tileEventOf(type));
        if (expected) expect(result).toEqual({ ok: true, state: expected });
        else expect(result).toMatchObject({ ok: false });
      });
    }
  }

  it(`retries a rejected tile until ${MAX_ATTEMPTS} tries are used, then sets it aside for review`, () => {
    for (let tries = 1; tries < MAX_ATTEMPTS; tries++) expect(tileTransition('running', tries, { type: 'REJECT' })).toEqual({ ok: true, state: 'retrying' });
    expect(tileTransition('running', MAX_ATTEMPTS, { type: 'REJECT' })).toEqual({ ok: true, state: 'needs-review' });
    expect(tileTransition('running', MAX_ATTEMPTS + 5, { type: 'REJECT' })).toEqual({ ok: true, state: 'needs-review' });
  });

  it('an accepted tile is never silently moved: only a person re-running it changes it', () => {
    const moves = TILE_EVENT_TYPES.filter((type) => tileTransition('accepted', 1, tileEventOf(type)).ok);
    expect(moves).toEqual(['RERUN']);
  });
});
