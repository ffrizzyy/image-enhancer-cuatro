import type { JobProgress, SessionStatus } from '@ie/contracts';

import { PAUSE_REASON_LABELS, PROVIDER_NAMES } from '../labels';

interface PauseBannerProps {
  progress: JobProgress;
  /** What the session monitor reports for the job's provider right now. */
  sessionStatus: SessionStatus;
  now?: Date;
  busy: boolean;
  onOpenProvider: () => void;
  onResume: () => void;
}

const minutesUntil = (iso: string, now: Date): number => Math.max(0, Math.ceil((Date.parse(iso) - now.getTime()) / 60_000));

/**
 * Shown the moment a job pauses. It says why, and offers the one thing that fixes it: opening the provider window for a
 * human check or a login, or resuming for a usage limit or a pause the user asked for. Once the provider looks fixed
 * the same button simply resumes.
 */
export function PauseBanner({ progress, sessionStatus, now = new Date(), busy, onOpenProvider, onResume }: PauseBannerProps) {
  if (progress.state !== 'paused' || !progress.pauseReason) return null;
  const reason = progress.pauseReason;
  const provider = progress.providerId ? PROVIDER_NAMES[progress.providerId] : 'the provider';
  const needsPerson = reason === 'challenge' || reason === 'logged-out';
  const fixed = sessionStatus === 'ready';
  const wait = progress.resumeAfter ? minutesUntil(progress.resumeAfter, now) : 0;

  let detail: string;
  switch (reason) {
    case 'challenge':
      detail = fixed ? `${provider} looks fine now.` : `Solve the check in the ${provider} window. The job continues from the next tile.`;
      break;
    case 'logged-out':
      detail = fixed ? `${provider} looks logged in again.` : `Log in to ${provider} in its window. The job continues from the next tile.`;
      break;
    case 'quota':
      detail = wait > 0 ? `It will probably have reset in about ${wait} minute${wait === 1 ? '' : 's'}. You can resume sooner, but it may stop again.` : 'It has probably reset by now.';
      break;
    default:
      detail = 'Nothing is lost: finished tiles stay finished.';
  }

  const primaryIsOpen = needsPerson && !fixed;
  return (
    <div role="alert" data-testid="pause-banner" data-reason={reason} className="rounded border-2 border-amber-500 bg-amber-50 p-3 text-sm text-amber-950">
      <p className="font-medium">Paused: {PAUSE_REASON_LABELS[reason]}.</p>
      <p className="mt-1">{detail}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {primaryIsOpen ? (
          <>
            <button type="button" onClick={onOpenProvider} disabled={busy} className="rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-50">
              Open {provider}
            </button>
            <button type="button" onClick={onResume} disabled={busy} className="rounded border border-slate-500 px-3 py-1 disabled:opacity-50">
              Resume anyway
            </button>
          </>
        ) : (
          <button type="button" onClick={onResume} disabled={busy} className="rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-50">
            {reason === 'quota' && wait > 0 ? 'Resume anyway' : 'Resume'}
          </button>
        )}
      </div>
    </div>
  );
}