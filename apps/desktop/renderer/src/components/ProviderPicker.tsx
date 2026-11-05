import type { ProviderId, SessionStatus } from '@ie/contracts';

import { PROVIDER_NAMES, STATUS_LABELS } from '../labels';
import { PROVIDERS } from '../store';

interface ProviderPickerProps {
  selected: ProviderId | null;
  statuses: Record<ProviderId, SessionStatus>;
  onSelect: (provider: ProviderId) => void;
}

export function ProviderPicker({ selected, statuses, onSelect }: ProviderPickerProps) {
  return (
    <fieldset>
      <legend className="mb-2 text-lg font-medium">Provider</legend>
      <div className="flex flex-wrap gap-4">
        {PROVIDERS.map((provider) => (
          <label key={provider} className="flex items-center gap-2 rounded border border-slate-200 p-2 text-sm">
            <input
              type="radio"
              name="provider"
              checked={selected === provider}
              onChange={() => onSelect(provider)}
            />
            <span>{PROVIDER_NAMES[provider]}</span>
            <span role="status" aria-label={`${PROVIDER_NAMES[provider]} login: ${STATUS_LABELS[statuses[provider]]}`}>
              {STATUS_LABELS[statuses[provider]]}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
