import { WebAdapter, type WebAdapterDeps } from '../base/WebAdapter';
import { loadProviderConfig } from '../config/load';
import type { ProviderConfig } from '../config/schema';

export type GeminiAdapterDeps = Omit<WebAdapterDeps, 'config'> & {
  /** Defaults to the shipped `config/gemini.json`; override to test a changed UI. */
  config?: ProviderConfig;
};

/** Gemini through the shared chat-UI flow: everything provider-specific is in `config/gemini.json`. */
export function createGeminiAdapter({ config, ...deps }: GeminiAdapterDeps): WebAdapter {
  return new WebAdapter({ ...deps, config: config ?? loadProviderConfig('gemini') });
}
