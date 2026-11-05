import type { JobSummary } from '@ie/contracts';

export function RecentJobs({ jobs }: { jobs: readonly JobSummary[] }) {
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
            <li key={job.id}>
              {job.id} — {job.state} ({job.completedTiles}/{job.totalTiles} tiles)
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
