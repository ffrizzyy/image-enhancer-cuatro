import { useEffect, useRef, useState } from 'react';

import type { JobState } from '@ie/contracts';

interface RunControlsProps {
  state: JobState;
  hasError: boolean;
  watchMode: boolean;
  onPause: () => Promise<void> | void;
  onCancel: () => Promise<void> | void;
  onStart: () => Promise<void> | void;
  onWatchMode: (on: boolean) => void;
}

/** States in which cancelling still means something. */
const CANCELLABLE: ReadonlySet<JobState> = new Set(['idle', 'preflight', 'running', 'paused', 'needs-review', 'stitching']);

/**
 * Pause, cancel, start-again and Watch mode (Resume lives in the pause banner, which says why the job stopped). Every control is a real button or checkbox, so the keyboard works as it
 * does everywhere; cancelling the job asks first, and Escape (or "Keep it") backs out of that question.
 */
export function RunControls({ state, hasError, watchMode, onPause, onCancel, onStart, onWatchMode }: RunControlsProps) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);

  const act = async (action: () => Promise<void> | void) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (confirming) keepButton.current?.focus();
  }, [confirming]);

  // A job that has ended has nothing to confirm.
  useEffect(() => {
    if (!CANCELLABLE.has(state)) setConfirming(false);
  }, [state]);

  const back = () => {
    setConfirming(false);
    cancelButton.current?.focus();
  };

  const button = 'rounded border border-slate-500 px-3 py-1 text-sm disabled:opacity-50';

  return (
    <div className="space-y-3" data-testid="run-controls">
      <div className="flex flex-wrap items-center gap-2">
        {state === 'running' && (
          <button type="button" className={button} disabled={busy} onClick={() => void act(onPause)}>
            Pause
          </button>
        )}
        {state === 'idle' && hasError && (
          <button type="button" className={`${button} bg-slate-900 text-white`} disabled={busy} onClick={() => void act(onStart)}>
            Check again and start
          </button>
        )}
        {CANCELLABLE.has(state) && (
          <button ref={cancelButton} type="button" className={button} disabled={busy} aria-expanded={confirming} onClick={() => setConfirming(true)}>
            Cancel job
          </button>
        )}
      </div>

      {confirming && (
        <div
          role="alertdialog"
          aria-labelledby="cancel-title"
          aria-describedby="cancel-text"
          className="rounded border-2 border-red-600 bg-red-50 p-3 text-sm"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              back();
            }
          }}
        >
          <p id="cancel-title" className="font-medium">
            Cancel this job?
          </p>
          <p id="cancel-text" className="mt-1">
            It stops for good and cannot be resumed. Tiles that are finished stay on disk.
          </p>
          <div className="mt-2 flex gap-2">
            <button ref={keepButton} type="button" className={button} onClick={back}>
              Keep it
            </button>
            <button
              type="button"
              className="rounded bg-red-700 px-3 py-1 text-sm text-white disabled:opacity-50"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                void act(onCancel);
              }}
            >
              Yes, cancel it
            </button>
          </div>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={watchMode} onChange={(event) => onWatchMode(event.target.checked)} />
        Keep the provider window visible (Watch mode)
      </label>
    </div>
  );
}