import type { ProviderId, SessionStatus } from '@ie/contracts';
import { useState } from 'react';

import { PROVIDER_NAMES, STATUS_LABELS } from '../labels';


interface ProviderStatusProps {
  provider: ProviderId;
  status: SessionStatus;
  onOpenLogin: () => void;
  onCheck: () => void;
  onClear: () => void;
}

const button = 'rounded border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100';

export function ProviderStatus({ provider, status, onOpenLogin, onCheck, onClear }: ProviderStatusProps) {
  const [confirming, setConfirming] = useState(false);
  const name = PROVIDER_NAMES[provider];

  return (
    <li className="rounded-lg border border-slate-200 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">{name}</h2>
        <span role="status" aria-label={`${name} login: ${STATUS_LABELS[status]}`} className="text-sm">
          {STATUS_LABELS[status]}
        </span>
      </div>

      {confirming ? (
        <div className="mt-3 flex items-center gap-2">
          <p className="mr-2 text-sm">Clear the {name} session? You will be logged out.</p>
          <button
            type="button"
            className={button}
            onClick={() => {
              setConfirming(false);
              onClear();
            }}
          >
            Confirm clear
          </button>
          <button type="button" className={button} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="mt-3 flex gap-2">
          <button type="button" className={button} onClick={onOpenLogin}>
            Open login
          </button>
          <button type="button" className={button} onClick={onCheck}>
            Check status
          </button>
          <button type="button" className={button} onClick={() => setConfirming(true)}>
            Clear session
          </button>
        </div>
      )}
    </li>
  );
}
