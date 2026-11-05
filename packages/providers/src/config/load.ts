import type { ProviderId } from '@ie/contracts';

import gemini from '../../config/gemini.json';
import { ProviderConfigSchema, type ProviderConfig } from './schema';

/** Shipped provider configs, validated when first imported so a malformed file fails fast. */
const CONFIGS: Partial<Record<ProviderId, ProviderConfig>> = {
  gemini: ProviderConfigSchema.parse(gemini),
};

export const geminiConfig: ProviderConfig = CONFIGS.gemini!;

export function loadProviderConfig(id: ProviderId): ProviderConfig {
  const config = CONFIGS[id];
  if (!config) throw new RangeError(`No shipped config for provider "${id}" yet.`);
  return structuredClone(config);
}
