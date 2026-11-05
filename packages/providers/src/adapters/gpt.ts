import { WebAdapter, type WebAdapterDeps } from '../base/WebAdapter';
import { loadProviderConfig } from '../config/load';
import type { ProviderConfig } from '../config/schema';

export type GptAdapterDeps = Omit<WebAdapterDeps, 'config'> & {
  /** Defaults to the shipped `config/gpt.json`; override to test a changed UI. */
  config?: ProviderConfig;
};

/** GPT through the shared chat-UI flow: everything provider-specific is in `config/gpt.json`. */
export function createGptAdapter({ config, ...deps }: GptAdapterDeps): WebAdapter {
  return new WebAdapter({ ...deps, config: config ?? loadProviderConfig('gpt') });
}