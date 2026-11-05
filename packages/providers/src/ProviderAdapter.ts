import type {
  EnhanceRequest,
  EnhanceResult,
  ProviderCapabilities,
  ProviderErrorKind,
  ProviderHealth,
  ProviderId,
} from '@ie/contracts';

export type { EnhanceAttachment, EnhanceRequest, EnhanceResult, ProviderCapabilities, ProviderErrorKind, ProviderHealth } from '@ie/contracts';

export const PROVIDER_ERROR_KINDS: readonly ProviderErrorKind[] = [
  'logged-out',
  'challenge',
  'quota',
  'refusal',
  'timeout',
  'ui-changed',
  'download-failed',
];

/**
 * Every provider failure the orchestrator can react to. Adapters throw this and nothing else
 * for runtime failures. `selector` names the missing selector key for `ui-changed`.
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly selector: string | undefined;

  constructor(kind: ProviderErrorKind, message: string, options: { selector?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.kind = kind;
    this.selector = options.selector;
  }
}

/** One adapter per provider; the orchestrator calls all of them identically. */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  /** Reads the page without generating anything. */
  health(): Promise<ProviderHealth>;
  /**
   * Runs one enhancement in a fresh chat. Throws `RangeError` for a malformed request (a caller bug)
   * and `ProviderError` for every provider-side failure.
   */
  enhance(req: EnhanceRequest): Promise<EnhanceResult>;
}
