import type { ProviderId } from '@ie/contracts';

export const PROVIDER_IDS: readonly ProviderId[] = ['gpt', 'gemini', 'grok'];

/** One persistent Electron partition per provider; cookies and storage never cross them. */
export function partitionFor(provider: ProviderId): string {
  return `persist:${provider}`;
}
