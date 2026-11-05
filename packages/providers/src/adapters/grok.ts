import { WebAdapter, type WebAdapterDeps } from '../base/WebAdapter';
import { loadProviderConfig } from '../config/load';
import type { ProviderConfig } from '../config/schema';

export type GrokAdapterDeps = Omit<WebAdapterDeps, 'config'> & {
  /** Defaults to the shipped `config/grok.json`; override to test a changed UI. */
  config?: ProviderConfig;
};

/** Grok through the shared chat-UI flow: everything provider-specific is in `config/grok.json`. */
export function createGrokAdapter({ config, ...deps }: GrokAdapterDeps): WebAdapter {
  return new WebAdapter({ ...deps, config: config ?? loadProviderConfig('grok') });
}