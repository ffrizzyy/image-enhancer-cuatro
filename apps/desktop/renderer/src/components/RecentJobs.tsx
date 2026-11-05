import type { JobSummary } from '@ie/contracts';

interface RecentJobsProps {
  jobs: readonly JobSummary[];
  onOpen?: (jobId: string) => void;
  onResume?: (jobId: string) => void;
}

/** A job that stopped before it finished can be continued from here. */
const RESUMABLE: ReadonlySet<string> = new Set(['paused', 'running']);

export function RecentJobs({ jobs, onOpen, onResume }: RecentJobsProps) {
  return (
    <section aria-labelledby="recent-jobs-heading" className="mt-8">
      <h2 id="recent-jobs-heading" className="mb-2 text-lg font-medium">
        Recent jobs
      </h2>
      {jobs.length === 0 ? (
        <p className="text-sm text-slate-600">No recent jobs yet.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {jobs.map((job) => (
            <li key={job.id} className="flex items-center gap-3">
              <span>
                {job.id} — {job.state} ({job.completedTiles}/{job.totalTiles} tiles)
              </span>
              {onOpen && (
                <button type="button" onClick={() => onOpen(job.id)} className="rounded border border-slate-400 px-2 py-0.5 text-xs" aria-label={`Open job ${job.id}`}>
                  Open
                </button>
              )}
              {onResume && RESUMABLE.has(job.state) && (
                <button type="button" onClick={() => onResume(job.id)} className="rounded bg-slate-900 px-2 py-0.5 text-xs text-white" aria-label={`Resume job ${job.id}`}>
                  Resume
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}