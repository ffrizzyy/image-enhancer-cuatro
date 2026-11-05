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
export type { PageDriver } from './base/PageDriver';
export { createImageSaver } from './base/saveImage';
export type { ImageSaver, SavedImage } from './base/saveImage';
export { WebAdapter } from './base/WebAdapter';
export type { WebAdapterDeps } from './base/WebAdapter';
export { IDLE_SELECTOR_KEYS, ProviderConfigSchema, REQUIRED_SELECTOR_KEYS } from './config/schema';
export type { MarkerKind, ProviderConfig, SelectorKey } from './config/schema';
