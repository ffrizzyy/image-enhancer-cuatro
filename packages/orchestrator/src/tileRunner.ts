import { copyFileSync } from 'node:fs';
import path from 'node:path';

import type { Category, PauseReason } from '@ie/contracts';
import { ProviderError, type ProviderAdapter } from '@ie/providers';
import { loadRgba } from '@ie/slicer';

import { buildAttachments, neighbourStrip, type JobFiles } from './attachments.ts';
import { buildTilePrompt } from './prompts.ts';
import { evaluateOutput } from './quality.ts';
import type { Store } from './store.ts';
import { applyTileEvent, beginTile } from './transitions.ts';

/** How long to wait on one provider call before giving up on it. */
export const DEFAULT_TILE_TIMEOUT_MS = 240_000;
/** A quota pause is offered for resuming after this long. */
export const QUOTA_RESUME_AFTER_MS = 60 * 60 * 1000;

export type TileOutcome =
  | { kind: 'accepted'; score: number }
  /**
   * The tile did not pass; it will be retried, or was set aside for review (`needsReview`). `transient` marks a
   * passing provider problem (a timeout, a failed download), after which the runner backs off before retrying.
   */
  | { kind: 'rejected'; needsReview: boolean; reason: string; transient: boolean }
  /** The job must stop for the user: the tile is queued again untouched. */
  | { kind: 'pause'; reason: PauseReason; resumeAfter?: string; message: string }
  /** The job cannot continue (the provider page changed). */
  | { kind: 'job-failed'; error: string };

export interface TileRunDeps {
  store: Store;
  adapter: ProviderAdapter;
  files: JobFiles;
  category: Category;
  /** Chained mode feeds the finished neighbour's strip to the next tile. */
  chained: boolean;
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * One try of one tile, start to finish: records the attempt, builds the prompt and attachments, calls the provider,
 * checks the result, and writes the outcome before returning. Nothing is held only in memory.
 */
export async function runTile(deps: TileRunDeps, jobId: string, index: number): Promise<TileOutcome> {
  const { store, adapter, files, category } = deps;
  const now = deps.now ?? (() => new Date());
  const record = store.getJob(jobId)!;
  const tile = record.plan.tiles[index]!;
  const before = store.getTile(jobId, index)!;
  const earlierRefusals = store.listAttempts(jobId, index).filter((a) => a.errorKind === 'refusal').length;

  const attempt = beginTile(store, jobId, index);
  const tryNumber = before.attempts - before.attemptBase + 1;

  const accepted = new Map(store.listTiles(jobId).filter((t) => t.state === 'accepted' && t.outputPath).map((t) => [t.index, t.outputPath!]));
  const stripPath = deps.chained ? await neighbourStrip(record.plan, files, index, accepted) : null;
  const attachments = buildAttachments({ tilePath: files.tilePath(index), referencePath: files.referencePath, stripPath }, adapter.capabilities.maxAttachments);
  const prompt = buildTilePrompt({
    category,
    userPrompt: before.promptOverride ?? record.job.prompt,
    plan: record.plan,
    tileIndex: index,
    attachments,
    tryNumber,
    softened: earlierRefusals > 0,
  });

  const started = now().getTime();
  let result;
  try {
    result = await adapter.enhance({ attachments, prompt, timeoutMs: deps.timeoutMs ?? DEFAULT_TILE_TIMEOUT_MS });
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error; // a bug in the caller, not a provider problem
    const message = error.message;
    const elapsedMs = now().getTime() - started;
    const failed = { outcome: 'error' as const, errorKind: error.kind, message, elapsedMs };

    switch (error.kind) {
      case 'challenge':
      case 'logged-out':
      case 'quota': {
        // Nothing was wrong with the tile: it goes back in the queue and the job waits for the user.
        store.transaction(() => {
          store.finishAttempt(attempt.id, failed);
          applyTileEvent(store, jobId, index, { type: 'INTERRUPT' });
        });
        const resumeAfter = error.kind === 'quota' ? new Date(now().getTime() + QUOTA_RESUME_AFTER_MS).toISOString() : undefined;
        return { kind: 'pause', reason: error.kind, ...(resumeAfter ? { resumeAfter } : {}), message };
      }
      case 'ui-changed': {
        const detail = error.selector ? ` (selector: ${error.selector})` : '';
        store.transaction(() => {
          store.finishAttempt(attempt.id, failed);
          applyTileEvent(store, jobId, index, { type: 'FAIL' }, { note: message });
        });
        return { kind: 'job-failed', error: `${message}${detail}` };
      }
      case 'refusal': {
        // One retry with softer wording; a second refusal needs a person.
        const final = earlierRefusals > 0;
        const tileState = store.transaction(() => {
          store.finishAttempt(attempt.id, failed);
          return applyTileEvent(store, jobId, index, { type: 'REJECT', final }, { note: message });
        });
        return { kind: 'rejected', needsReview: tileState.state === 'needs-review', reason: message, transient: false };
      }
      default: {
        // timeout, download-failed: the try is used up and the tile is retried (or set aside after the last one).
        const tileState = store.transaction(() => {
          store.finishAttempt(attempt.id, failed);
          return applyTileEvent(store, jobId, index, { type: 'REJECT' }, { note: message });
        });
        return { kind: 'rejected', needsReview: tileState.state === 'needs-review', reason: message, transient: true };
      }
    }
  }

  // Keep our own copy: the provider's temporary file may be cleaned up, and a reviewer needs the output later.
  const kept = path.join(files.outputsDir, `tile-${String(index).padStart(3, '0')}-try${attempt.n}.png`);
  copyFileSync(result.imagePath, kept);

  const verdict = await evaluateOutput({ outputPath: kept, sourceTile: await loadRgba(files.tilePath(index)), send: tile.send, fidelity: category.fidelity });
  const elapsedMs = result.elapsedMs;

  if (verdict.accepted) {
    store.transaction(() => {
      store.finishAttempt(attempt.id, { outcome: 'ok', outputPath: kept, elapsedMs });
      applyTileEvent(store, jobId, index, { type: 'ACCEPT' }, { outputPath: kept, note: null });
    });
    return { kind: 'accepted', score: verdict.score ?? 1 };
  }

  const reason = verdict.reasons.join(' ');
  const rejected = store.transaction(() => {
    store.finishAttempt(attempt.id, { outcome: 'rejected', outputPath: kept, message: reason, elapsedMs });
    // The rejected picture stays on the tile, so a reviewer can look at the best attempt.
    return applyTileEvent(store, jobId, index, { type: 'REJECT' }, { outputPath: kept, note: reason });
  });
  return { kind: 'rejected', needsReview: rejected.state === 'needs-review', reason, transient: false };
}
