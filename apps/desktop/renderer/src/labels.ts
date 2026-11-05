import type { CategoryFamily, Fidelity, ProviderId, SessionStatus } from '@ie/contracts';

export const PROVIDER_NAMES: Record<ProviderId, string> = { gpt: 'ChatGPT', gemini: 'Gemini', grok: 'Grok' };

export const STATUS_LABELS: Record<SessionStatus, string> = {
  ready: 'Ready',
  'logged-out': 'Logged out',
  challenge: 'Needs verification',
  'quota-limited': 'Limit reached',
  unknown: 'Not checked',
};

/** Display order and names for category groups. */
export const FAMILY_LABELS: Record<CategoryFamily, string> = {
  smart: 'Automatic',
  environment: 'Environments',
  props: 'Props & objects',
  character: 'Characters & creatures',
  texture: 'Textures',
  restore: 'Restoration',
  stylize: 'Stylize & cleanup',
  custom: 'Custom',
};

export const FAMILY_ORDER = Object.keys(FAMILY_LABELS) as CategoryFamily[];

export const FIDELITY_LABELS: Record<Fidelity, string> = {
  strict: 'Strict: change almost nothing but quality',
  preserve: 'Preserve: same content, richer detail',
  balanced: 'Balanced: surfaces may be restyled',
  reimagine: 'Reimagine: free reinterpretation',
};
