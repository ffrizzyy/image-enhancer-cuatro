import { useState } from 'react';

import { PauseBanner } from '../components/PauseBanner';
import { RunControls } from '../components/RunControls';
import { TileGrid } from '../components/TileGrid';
import { JOB_STATE_LABELS, PROVIDER_NAMES } from '../labels';
import { useShellStore } from '../store';

/** One job: where it is, overall progress, and every tile. Driven by pushed events, never by polling. */
export function Run() {
  const job = useShellStore((s) => s.job);
  const activeJobId = useShellStore((s) => s.activeJobId);
  const progress = useShellStore((s) => (s.activeJobId ? s.progress[s.activeJobId] : undefined));
  const log = useShellStore((s) => (s.activeJobId ? s.jobLog[s.activeJobId] : undefined));
  const runError = useShellStore((s) => s.runError);
  const providers = useShellStore((s) => s.providers);
  const watchMode = useShellStore((s) => s.settings?.watchMode ?? false);
  const store = useShellStore.getState;
  const [opening, setOpening] = useState(false);

  if (!activeJobId) return <p>No job yet. Set one up and press Start.</p>;

  const created = job && job.id === activeJobId ? job : null;

  return (
    <div className="space-y-4">
      <div data-testid="job-summary" className="space-y-1 text-sm">
        <p>
          Job <strong>{activeJobId}</strong>
          {progress && <> &middot; {JOB_STATE_LABELS[progress.state]}</>}
        </p>
        {created && (
          <p>
            Category {created.categoryId} &middot; {created.grid.cols}×{created.grid.rows} tiles, {created.grid.overlapPct}% overlap &middot; {PROVIDER_NAMES[created.providerId]}
          </p>
        )}
        {progress?.providerId && !created && <p>{PROVIDER_NAMES[progress.providerId]}</p>}
      </div>

      {runError && (
        <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {runError}
        </p>
      )}

      {!progress && <p role="status">Loading the job…</p>}

      {progress && (
        <>
          <div>
            <label htmlFor="run-progress" className="mb-1 block text-sm">
              {progress.completedTiles} of {progress.totalTiles} tiles done
            </label>
            <progress id="run-progress" className="h-3 w-full" value={progress.completedTiles} max={Math.max(1, progress.totalTiles)} />
          </div>

          <PauseBanner
            progress={progress}
            sessionStatus={progress.providerId ? providers[progress.providerId] : 'unknown'}
            busy={opening}
            onOpenProvider={() => {
              if (!progress.providerId) return;
              setOpening(true);
              void store().openProvider(progress.providerId, true).finally(() => setOpening(false));
            }}
            onResume={() => void store().resumeJob(progress.jobId)}
          />
          {progress.error && (progress.state === 'failed' || progress.state === 'idle') && (
            <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
              {progress.error}
            </p>
          )}

          <RunControls
            state={progress.state}
            hasError={Boolean(progress.error)}
            watchMode={watchMode}
            onPause={() => store().pauseJob(progress.jobId)}
            onCancel={() => store().cancelJob(progress.jobId)}
            onStart={() => store().startRun(progress.jobId)}
            onWatchMode={(on) => void store().setWatchMode(on, progress.providerId)}
          />

          {progress.state === 'needs-review' && (
            <p role="status" className="rounded border border-orange-400 bg-orange-50 p-3 text-sm">
              Some tiles need a look before the picture can be put together. They are marked in the grid.
            </p>
          )}

          {progress.grid && <TileGrid jobId={progress.jobId} grid={progress.grid} tiles={progress.tiles} />}

          {log && log.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer">Activity ({log.length})</summary>
              <ol className="mt-1 list-decimal pl-5">
                {log.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ol>
            </details>
          )}
        </>
      )}
    </div>
  );
}