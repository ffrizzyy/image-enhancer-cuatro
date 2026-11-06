import type { Pacing } from '@ie/contracts';

/** One tile at a time, a random 8-25 s pause between them (the spec's defaults). */
export const DEFAULT_PACING: Pacing = { concurrency: 1, minDelayMs: 8000, maxDelayMs: 25_000 };

/**
 * The two Settings presets. Safe is the default: one tile at a time with long pauses. Normal is quicker but still
 * leaves a human-looking gap between requests.
 */
export const PACING_PRESETS: Record<'safe' | 'normal', Pacing> = {
  safe: DEFAULT_PACING,
  normal: { concurrency: 2, minDelayMs: 3000, maxDelayMs: 10_000 },
};

/** Waits before retrying a tile that failed for a passing reason (a timeout, a failed download). */
export interface Backoff {
  /** The wait before the first retry; each further one doubles it. */
  baseMs: number;
  /** The longest wait. */
  maxMs: number;
}

export const DEFAULT_BACKOFF: Backoff = { baseMs: 15_000, maxMs: 5 * 60_000 };

/** Throws a RangeError naming the problem, so a bad setting is caught before a run starts rather than mid-job. */
export function validatePacing(pacing: Pacing): Pacing {
  if (pacing.concurrency !== 1 && pacing.concurrency !== 2) throw new RangeError('Concurrency must be 1 or 2.');
  if (!Number.isFinite(pacing.minDelayMs) || pacing.minDelayMs < 0) throw new RangeError('The minimum delay must be 0 or more.');
  if (!Number.isFinite(pacing.maxDelayMs) || pacing.maxDelayMs < pacing.minDelayMs) throw new RangeError('The maximum delay must not be less than the minimum.');
  return pacing;
}

/** A random pause between two tiles, from `minDelayMs` to `maxDelayMs`. `random` returns 0 up to (not including) 1. */
export function pacingDelayMs(pacing: Pacing, random: () => number): number {
  return Math.round(pacing.minDelayMs + random() * (pacing.maxDelayMs - pacing.minDelayMs));
}

/**
 * The wait before retry number `retry` (1 for the first): `baseMs`, doubling each time, never more than `maxMs`, and
 * spread by up to 25% either way so that several jobs do not retry in step.
 */
export function backoffDelayMs(retry: number, backoff: Backoff, random: () => number): number {
  const exponential = Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.max(0, retry - 1));
  const spread = 1 + (random() * 2 - 1) * 0.25;
  return Math.min(backoff.maxMs, Math.round(exponential * spread));
}
