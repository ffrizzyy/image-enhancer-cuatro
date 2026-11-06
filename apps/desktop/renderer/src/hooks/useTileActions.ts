import type { TileOverridePatch } from '@ie/contracts';
import { useState } from 'react';

import { useShellStore } from '../store';

export type TileActionKind = 'accept' | 'rerun' | 'override';

export type TileActionState =
  | { status: 'idle' }
  | { status: 'pending'; action: TileActionKind }
  | { status: 'success'; action: TileActionKind; message: string }
  | { status: 'error'; action: TileActionKind; message: string };

export interface TileActions {
  stateFor: (index: number) => TileActionState;
  accept: (index: number) => Promise<boolean>;
  rerun: (index: number) => Promise<boolean>;
  saveAndRerun: (index: number, patch: TileOverridePatch) => Promise<boolean>;
}

const idle: TileActionState = { status: 'idle' };

/**
 * The Result screen's per-tile actions, each with its own pending, done or failed message. The store owns the IPC call
 * and refreshes the job's progress; this hook only keeps what the person should see about the action they just asked
 * for, so one tile's state never hides another's.
 */
export function useTileActions(jobId: string): TileActions {
  const [states, setStates] = useState<Record<number, TileActionState>>({});
  const acceptTile = useShellStore((s) => s.acceptTile);
  const rerunTile = useShellStore((s) => s.rerunTile);
  const setTileOverride = useShellStore((s) => s.setTileOverride);

  const fail = (index: number, action: TileActionKind, fallback: string): false => {
    setStates((current) => ({
      ...current,
      [index]: { status: 'error', action, message: useShellStore.getState().runError ?? fallback },
    }));
    return false;
  };

  const run = async (index: number, action: TileActionKind, work: () => Promise<boolean>, message: string): Promise<boolean> => {
    setStates((current) => ({ ...current, [index]: { status: 'pending', action } }));
    let ok = false;
    try {
      ok = await work();
    } catch (error) {
      setStates((current) => ({ ...current, [index]: { status: 'error', action, message: `That did not work: ${String(error)}` } }));
      return false;
    }
    if (!ok) return fail(index, action, 'That did not work. Try again.');
    setStates((current) => ({ ...current, [index]: { status: 'success', action, message } }));
    return true;
  };

  return {
    stateFor: (index) => states[index] ?? idle,
    accept: (index) =>
      run(index, 'accept', () => acceptTile(jobId, index), `Tile ${index + 1} kept as it is.`),
    rerun: (index) =>
      run(index, 'rerun', () => rerunTile(jobId, index), `Tile ${index + 1} is being tried again.`),
    saveAndRerun: (index, patch) =>
      run(
        index,
        'override',
        async () => {
          const saved = await setTileOverride(jobId, index, patch);
          if (!saved) return false;
          return rerunTile(jobId, index);
        },
        `Tile ${index + 1} will use the new settings. It is being tried again.`,
      ),
  };
}
