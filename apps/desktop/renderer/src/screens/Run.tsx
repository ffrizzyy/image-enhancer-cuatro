import { TileGrid } from '../components/TileGrid';
import { JOB_STATE_LABELS, PAUSE_REASON_LABELS, PROVIDER_NAMES } from '../labels';
import { useShellStore } from '../store';

/** One job: where it is, overall progress, and every tile. Driven by pushed events, never by polling. */
export function Run() {
  const job = useShellStore((s) => s.job);
  const activeJobId = useShellStore((s) => s.activeJobId);
  const progress = useShellStore((s) => (s.activeJobId ? s.progress[s.activeJobId] : undefined));
  const log = useShellStore((s) => (s.activeJobId ? s.jobLog[s.activeJobId] : undefined));
  const runError = useShellStore((s) => s.runError);

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

          {progress.state === 'paused' && progress.pauseReason && (
            <p role="status" className="rounded border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900">
              Paused: {PAUSE_REASON_LABELS[progress.pauseReason]}.
            </p>
          )}
          {progress.error && (progress.state === 'failed' || progress.state === 'idle') && (
            <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
              {progress.error}
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