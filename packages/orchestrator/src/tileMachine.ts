import type { TileState } from '@ie/contracts';

/** The first try plus two retries (the spec's "retry up to 2 times"), after which a tile is set aside for review. */
export const MAX_ATTEMPTS = 3;

export type TileEvent =
  | { type: 'START' }
  /** The output was accepted by the quality gate. */
  | { type: 'ACCEPT' }
  /**
   * The output failed the gate, or the provider refused. Retries while attempts remain, else needs a person.
   * `final` sets it aside for review straight away (a second refusal), whatever tries are left.
   */
  | { type: 'REJECT'; final?: boolean }
  /** The provider failed in a way that cannot be retried (the job fails with the reason). */
  | { type: 'FAIL' }
  /** The run was cut off (app closed, provider paused the job): the tile goes back in the queue without using a retry. */
  | { type: 'INTERRUPT' }
  /** A person re-runs the tile, from any settled state. */
  | { type: 'RERUN' }
  /** A person accepts a tile that needs review as it is. */
  | { type: 'ACCEPT_AS_IS' };

export type TileEventType = TileEvent['type'];

export const TILE_STATES: readonly TileState[] = ['pending', 'running', 'accepted', 'retrying', 'needs-review', 'failed'];
export const TILE_EVENT_TYPES: readonly TileEventType[] = ['START', 'ACCEPT', 'REJECT', 'FAIL', 'INTERRUPT', 'RERUN', 'ACCEPT_AS_IS'];

/** A tile in one of these states has nothing left for the runner to do. */
export const SETTLED_TILE_STATES: readonly TileState[] = ['accepted', 'needs-review', 'failed'];

export type TileTransition = { ok: true; state: TileState } | { ok: false; reason: string };

/**
 * Legal tile transitions. `triesUsed` is how many tries the tile has used since it was last queued by hand (the one
 * in flight counts), so a rejected tile retries only while fewer than `MAX_ATTEMPTS` have been used.
 */
export function tileTransition(state: TileState, triesUsed: number, event: TileEvent): TileTransition {
  const to = (next: TileState): TileTransition => ({ ok: true, state: next });
  switch (state) {
    case 'pending':
    case 'retrying':
      if (event.type === 'START') return to('running');
      break;
    case 'running':
      if (event.type === 'ACCEPT') return to('accepted');
      if (event.type === 'REJECT') return to(!event.final && triesUsed < MAX_ATTEMPTS ? 'retrying' : 'needs-review');
      if (event.type === 'FAIL') return to('failed');
      if (event.type === 'INTERRUPT') return to('pending');
      break;
    case 'accepted':
      if (event.type === 'RERUN') return to('pending');
      break;
    case 'needs-review':
      if (event.type === 'ACCEPT_AS_IS') return to('accepted');
      if (event.type === 'RERUN') return to('pending');
      break;
    case 'failed':
      if (event.type === 'RERUN') return to('pending');
      break;
  }
  return { ok: false, reason: `A tile that is ${state} cannot take "${event.type}".` };
}
