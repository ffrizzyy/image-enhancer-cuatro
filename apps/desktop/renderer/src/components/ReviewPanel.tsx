import type { JobProgress } from '@ie/contracts';

interface ReviewPanelProps {
  progress: JobProgress;
  onAcceptAll: () => void;
  onFinish: () => void;
}

/**
 * Shown when every tile has finished but some were set aside. Says what to do about each, and offers the next step as
 * soon as none is left undecided. Nothing is accepted without the person choosing it.
 */
export function ReviewPanel({ progress, onAcceptAll, onFinish }: ReviewPanelProps) {
  const waiting = progress.tiles.filter((t) => t.state === 'needs-review' || t.state === 'failed');
  const keepable = waiting.filter((t) => t.state === 'needs-review' && t.outputPath);
  const undecided = progress.tiles.some((t) => t.state !== 'accepted');

  return (
    <section aria-labelledby="review-title" data-testid="review-panel" className="rounded border-2 border-orange-500 bg-orange-50 p-3 text-sm">
      <h3 id="review-title" className="font-medium">
        {undecided ? `${waiting.length} tile${waiting.length === 1 ? ' needs' : 's need'} your decision` : 'All tiles are settled'}
      </h3>
      {undecided ? (
        <>
          <p className="mt-1">
            Look at each marked tile below. <strong>Accept as is</strong> keeps the best picture the provider gave for it; <strong>Try again</strong> asks the provider again with a fresh set of retries.
          </p>
          {keepable.length > 1 && (
            <button type="button" className="mt-2 rounded border border-slate-500 bg-white px-3 py-1" onClick={onAcceptAll}>
              Accept all {keepable.length} as they are
            </button>
          )}
        </>
      ) : (
        <p className="mt-1">Every tile has a picture you are happy with.</p>
      )}
      <div className="mt-2">
        <button type="button" disabled={undecided} onClick={onFinish} className="rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-50">
          Put the picture together
        </button>
        {undecided && <span className="ml-2 text-slate-700">Decide on every marked tile first.</span>}
      </div>
    </section>
  );
}