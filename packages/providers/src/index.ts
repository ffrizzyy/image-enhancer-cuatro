// The fake adapter is intentionally not exported here; it lives behind "@ie/providers/fake" so a
// production bundle that imports only this entry cannot include it.
export { PROVIDER_ERROR_KINDS, ProviderError } from './ProviderAdapter';
export type {
  EnhanceAttachment,
  EnhanceRequest,
  EnhanceResult,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderErrorKind,
  ProviderHealth,
} from './ProviderAdapter';
export { PageTimeoutError } from './base/PageDriver';
export type { FetchImageOptions, PageDriver, UrlRewrite } from './base/PageDriver';
export { createImageSaver } from './base/saveImage';
export type { ImageSaver, SavedImage } from './base/saveImage';
export { WebAdapter } from './base/WebAdapter';
export type { WebAdapterDeps } from './base/WebAdapter';
export { IDLE_SELECTOR_KEYS, ProviderConfigSchema, REQUIRED_SELECTOR_KEYS } from './config/schema';
export type { MarkerKind, ProviderConfig, SelectorKey } from './config/schema';
export { createGeminiAdapter } from './adapters/gemini';
export type { GeminiAdapterDeps } from './adapters/gemini';
export { createGptAdapter } from './adapters/gpt';
export type { GptAdapterDeps } from './adapters/gpt';
export { createGrokAdapter } from './adapters/grok';
export type { GrokAdapterDeps } from './adapters/grok';
export { geminiConfig, gptConfig, grokConfig, loadProviderConfig } from './config/load';
export { DISCOVERY_SCRIPT } from './tools/discover';
export type { DiscoveryReport } from './tools/discover';