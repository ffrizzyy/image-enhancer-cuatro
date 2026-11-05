import type { CategorySource, ProviderId } from '@ie/contracts';

export type IntakeErrorCode =
  | 'file-not-found'
  | 'not-a-file'
  | 'file-too-large'
  | 'unsupported-gif'
  | 'unsupported-svg'
  | 'unsupported-format'
  | 'corrupt-image'
  | 'dimensions-exceeded'
  | 'unknown-category'
  | 'invalid-prompt'
  | 'invalid-grid'
  | 'invalid-config';

/** Every intake failure carries a stable code the UI can switch on. */
export class IntakeError extends Error {
  readonly code: IntakeErrorCode;

  constructor(code: IntakeErrorCode, message: string) {
    super(message);
    this.name = 'IntakeError';
    this.code = code;
  }
}

export interface ImportLimits {
  maxBytes: number;
  maxDimension: number;
}

export interface JobConfig {
  /** Empty or whitespace resolves to the category's `defaultPrompt`. */
  prompt: string;
  categoryId: string;
  grid: { rows: number; cols: number; overlapPct: number };
  providerId: ProviderId;
  /** `auto` when the user kept an auto-detect suggestion. Defaults to `user`. */
  categorySource?: CategorySource;
  /** Only recorded when `categorySource` is `auto`. */
  categoryConfidence?: number;
}
