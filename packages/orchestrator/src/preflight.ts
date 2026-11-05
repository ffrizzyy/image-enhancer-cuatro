import type { Pacing, ProviderId, SessionStatus, TilePlan } from '@ie/contracts';
import type { ProviderAdapter } from '@ie/providers';

import { DEFAULT_PACING } from './pacing.ts';


/** A rough time for one provider generation, for the cost preview only. */
export const TYPICAL_GENERATION_SECONDS = 60;

export interface CostPreview {
  tiles: number;
  /** Rough total, including the pauses between tiles. */
  estimatedMinutes: number;
  /** What the run will use up on the provider account. */
  quotaNote: string;
}

export interface PreflightResult {
  /** False means the run must not start. */
  ok: boolean;
  /** Everything that blocks the run, in plain words. */
  reasons: string[];
  cost: CostPreview;
}

export interface PreflightInput {
  adapter: Pick<ProviderAdapter, 'health'>;
  providerId: ProviderId;
  /** What the session monitor currently reports for the provider. */
  sessionStatus: SessionStatus;
  plan: TilePlan;
  pacing?: Pacing;
}

const SESSION_REASONS: Partial<Record<SessionStatus, string>> = {
  'logged-out': 'You are logged out of the provider. Log in again in its window.',
  challenge: 'The provider is asking for a human check. Solve it in its window.',
  'quota-limited': 'The provider says you have reached its usage limit. Try again later.',
  unknown: 'The provider has not been checked yet. Open it in Settings and wait for its status.',
};

export function costPreview(plan: TilePlan, providerId: ProviderId, pacing: Pacing = DEFAULT_PACING): CostPreview {
  return costForTiles(plan.tiles.length, providerId, pacing);
}

/** The same preview from a tile count, for showing it before a job exists. */
export function costForTiles(tiles: number, providerId: ProviderId, pacing: Pacing = DEFAULT_PACING): CostPreview {
  const meanDelaySeconds = (pacing.minDelayMs + pacing.maxDelayMs) / 2 / 1000;
  const perTile = TYPICAL_GENERATION_SECONDS + meanDelaySeconds;
  return {
    tiles,
    estimatedMinutes: Math.max(1, Math.round((tiles * perTile) / pacing.concurrency / 60)),
    quotaNote: `This run makes ${tiles} image generation${tiles === 1 ? '' : 's'} on your ${providerId} account, plus any retries. If the provider has a usage limit, the job pauses and can be resumed later.`,
  };
}

/**
 * Checks everything that can be checked without generating anything: the provider session is ready and its page still
 * matches what the adapter expects. A run never starts when this fails.
 */
export async function preflight({ adapter, providerId, sessionStatus, plan, pacing }: PreflightInput): Promise<PreflightResult> {
  const reasons: string[] = [];

  if (sessionStatus !== 'ready') reasons.push(SESSION_REASONS[sessionStatus] ?? `The provider session is ${sessionStatus}, not ready.`);

  // Reading the page is harmless even when the session is not ready, and shows a changed page early.
  try {
    const health = await adapter.health();
    if (!health.ok && health.missingSelectors.length > 0) {
      reasons.push(`The provider page no longer matches what this app expects (missing: ${health.missingSelectors.join(', ')}).`);
    }
  } catch (error) {
    if (sessionStatus === 'ready') reasons.push(`The provider could not be checked: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { ok: reasons.length === 0, reasons, cost: costPreview(plan, providerId, pacing) };
}
