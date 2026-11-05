import type { CategoryFamily, Fidelity, JobState, PauseReason, ProviderId, SessionStatus, TileState } from '@ie/contracts';

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

export const JOB_STATE_LABELS: Record<JobState, string> = {
  idle: 'Not started',
  preflight: 'Checking the provider',
  running: 'Running',
  paused: 'Paused',
  'needs-review': 'Needs your review',
  stitching: 'Putting the picture together',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const PAUSE_REASON_LABELS: Record<PauseReason, string> = {
  challenge: 'The provider asked for a human check',
  'logged-out': 'You were logged out of the provider',
  quota: 'The provider reported a usage limit',
  user: 'You paused it',
};

/**
 * Every tile state has a word and a symbol as well as a colour, so it can be told apart without seeing colour and is
 * announced by a screen reader.
 */
export const TILE_STATE_LABELS: Record<TileState, { label: string; symbol: string }> = {
  pending: { label: 'Waiting', symbol: '○' },
  running: { label: 'Working', symbol: '◐' },
  accepted: { label: 'Done', symbol: '✓' },
  retrying: { label: 'Retrying', symbol: '↻' },
  'needs-review': { label: 'Needs review', symbol: '⚠' },
  failed: { label: 'Failed', symbol: '✕' },
};
