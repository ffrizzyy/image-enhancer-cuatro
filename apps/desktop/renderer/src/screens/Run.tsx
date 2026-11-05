import { PROVIDER_NAMES } from '../labels';
import { useShellStore } from '../store';

/** Placeholder until Phase 3: shows the Job that Start created. Nothing runs yet. */
export function Run() {
  const job = useShellStore((s) => s.job);

  if (!job) return <p>No job yet. Set one up and press Start.</p>;

  return (
    <div data-testid="job-summary" className="space-y-1 text-sm">
      <p>
        Job <strong>{job.id}</strong> created.
      </p>
      <p>
        Category {job.categoryId} &middot; {job.grid.cols}×{job.grid.rows} tiles, {job.grid.overlapPct}% overlap
        &middot; {PROVIDER_NAMES[job.providerId]}
      </p>
      <p className="text-slate-600">Running jobs arrives in a later task; nothing has been sent to the provider.</p>
    </div>
  );
}
