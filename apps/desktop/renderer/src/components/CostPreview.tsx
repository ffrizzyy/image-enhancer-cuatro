import type { ProviderId } from '@ie/contracts';

import { PROVIDER_NAMES } from '../labels';
import type { CostState } from '../store';

interface CostPreviewProps {
  cost: CostState;
  providerId: ProviderId | null;
}

/** What the run will use before it starts: generations, a rough time, and what it takes from the account. */
export function CostPreview({ cost, providerId }: CostPreviewProps) {
  return (
    <section aria-labelledby="cost-heading" data-testid="cost-preview" className="rounded border border-slate-300 p-3 text-sm">
      <h3 id="cost-heading" className="mb-1 font-medium">
        What this run will use
      </h3>
      {!providerId && <p className="text-slate-600">Choose a provider to see the cost.</p>}
      {providerId && cost.status === 'idle' && <p className="text-slate-600">Set a valid grid to see the cost.</p>}
      {providerId && cost.status === 'loading' && <p role="status">Working it out…</p>}
      {providerId && cost.status === 'error' && <p className="text-red-800">{cost.message}</p>}
      {providerId && cost.status === 'ok' && (
        <>
          <p>
            <strong>{cost.cost.tiles}</strong> image generation{cost.cost.tiles === 1 ? '' : 's'} on {PROVIDER_NAMES[providerId]}, about <strong>{cost.cost.estimatedMinutes}</strong> minute
            {cost.cost.estimatedMinutes === 1 ? '' : 's'} in total.
          </p>
          <p className="mt-1 text-slate-700">{cost.cost.quotaNote}</p>
        </>
      )}
    </section>
  );
}