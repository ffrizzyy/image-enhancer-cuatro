import type { Category, CategorySuggestion } from '@ie/contracts';
import { useState } from 'react';

import type { DetectionState } from '../store';

interface AutoDetectCardProps {
  detection: DetectionState;
  categories: readonly Category[];
  /** The category currently in use (the detected one, or an override). */
  currentId: string | null;
  onRedetect: () => void;
  onUse: (categoryId: string) => void;
  onUseDetected: () => void;
}

const button = 'rounded border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 disabled:opacity-50';
const percent = (confidence: number): number => Math.round(confidence * 100);

interface ResultProps extends Omit<AutoDetectCardProps, 'detection'> {
  suggestion: CategorySuggestion;
}

function Result({ suggestion, categories, currentId, onRedetect, onUse, onUseDetected }: ResultProps) {
  const [confirmed, setConfirmed] = useState(false);
  const name = (id: string): string => categories.find((c) => c.id === id)?.name ?? id;
  const overridden = currentId !== null && currentId !== suggestion.categoryId;

  return (
    <>
      <h3 className="text-base font-semibold">
        Detected: {name(suggestion.categoryId)} ({percent(suggestion.confidence)}%)
      </h3>

      {suggestion.lowConfidence && !confirmed && (
        <div role="alert" className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
          <p>Low confidence: please check this suggestion, or pick one of the alternatives below.</p>
          <button type="button" className={`${button} mt-2`} onClick={() => setConfirmed(true)}>
            Keep this suggestion
          </button>
        </div>
      )}
      {suggestion.lowConfidence && confirmed && <p className="mt-2 text-sm text-slate-700">Suggestion confirmed.</p>}

      <ul aria-label="Why" className="mt-2 list-disc pl-5 text-sm text-slate-700">
        {suggestion.signals.map((signal) => (
          <li key={signal}>{signal}</li>
        ))}
      </ul>

      <div className="mt-3">
        <p className="mb-1 text-sm font-medium">Other possibilities</p>
        <ul className="flex flex-wrap gap-2">
          {suggestion.alternatives.map((alternative) => (
            <li key={alternative.categoryId}>
              <button type="button" className={button} onClick={() => onUse(alternative.categoryId)}>
                Use {name(alternative.categoryId)} ({percent(alternative.confidence)}%)
              </button>
            </li>
          ))}
        </ul>
      </div>

      {overridden && (
        <p className="mt-3 text-sm">
          Using <strong>{name(currentId)}</strong> instead of the detected category.{' '}
          <button type="button" className="underline" onClick={onUseDetected}>
            Use detected category
          </button>
        </p>
      )}

      <button type="button" className={`${button} mt-3`} onClick={onRedetect}>
        Re-detect
      </button>
    </>
  );
}

/** Shows what Auto found and lets the user override it. Detection is local and starts no job. */
export function AutoDetectCard({ detection, ...rest }: AutoDetectCardProps) {
  if (detection.status === 'idle') return null;

  return (
    <section aria-label="Auto-detect" className="rounded-lg border border-slate-200 p-4">
      {detection.status === 'loading' && <p role="status">Analysing your image…</p>}
      {detection.status === 'error' && (
        <>
          <p role="alert" className="text-sm text-red-800">
            {detection.message}
          </p>
          <button type="button" className={`${button} mt-2`} onClick={rest.onRedetect}>
            Try again
          </button>
        </>
      )}
      {/* Keyed so the "keep this suggestion" confirmation resets with each new detection. */}
      {detection.status === 'ok' && (
        <Result
          key={`${detection.suggestion.categoryId}:${detection.suggestion.confidence}`}
          suggestion={detection.suggestion}
          {...rest}
        />
      )}
    </section>
  );
}
