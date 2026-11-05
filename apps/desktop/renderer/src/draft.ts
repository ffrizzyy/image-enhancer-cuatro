import type {
  Category,
  CategorySuggestion,
  CreateJobRequest,
  ImageAsset,
  ProviderId,
  SessionStatus,
} from '@ie/contracts';

import { PROVIDER_NAMES, STATUS_LABELS } from './labels';

export const MAX_PROMPT = 2000;
export const MAX_GRID_AXIS = 6;
export const MAX_OVERLAP = 40;

export type GridMode = 'preset-6' | 'preset-8' | 'custom';

/** 6 = 3×2 and 8 = 4×2 (columns × rows), i.e. two rows of three or four tiles. */
export const PRESET_GRIDS: Record<Exclude<GridMode, 'custom'>, { rows: number; cols: number }> = {
  'preset-6': { rows: 2, cols: 3 },
  'preset-8': { rows: 2, cols: 4 },
};

export interface JobDraft {
  /** The resolved prompt category. With Auto selected this is the detected (or overridden) category. */
  categoryId: string | null;
  /** The Auto card is selected; the category above came from detection. */
  autoSelected: boolean;
  /** May be empty: an empty prompt resolves to the category default at Start. */
  prompt: string;
  gridMode: GridMode;
  rows: number;
  cols: number;
  overlapPct: number;
  providerId: ProviderId | null;
}

export const emptyDraft = (): JobDraft => ({
  categoryId: null,
  autoSelected: false,
  prompt: '',
  gridMode: 'preset-6',
  rows: PRESET_GRIDS['preset-6'].rows,
  cols: PRESET_GRIDS['preset-6'].cols,
  overlapPct: 15,
  providerId: null,
});

export function modeForGrid(rows: number, cols: number): GridMode {
  for (const mode of ['preset-6', 'preset-8'] as const) {
    if (PRESET_GRIDS[mode].rows === rows && PRESET_GRIDS[mode].cols === cols) return mode;
  }
  return 'custom';
}

/**
 * Applies a category's defaults (grid and overlap). The prompt is replaced only when it is empty
 * or still equals the previous category's default, so a user's edit survives switching categories.
 */
export function applyCategory(draft: JobDraft, next: Category, previous: Category | undefined): JobDraft {
  const [rows, cols] = next.defaults.grid;
  const untouched = draft.prompt === '' || draft.prompt === previous?.defaultPrompt;
  return {
    ...draft,
    categoryId: next.id,
    prompt: untouched ? (next.defaultPrompt ?? '') : draft.prompt,
    rows,
    cols,
    gridMode: modeForGrid(rows, cols),
    overlapPct: next.defaults.overlapPct,
  };
}

export function applyGridMode(draft: JobDraft, mode: GridMode): JobDraft {
  return mode === 'custom' ? { ...draft, gridMode: mode } : { ...draft, gridMode: mode, ...PRESET_GRIDS[mode] };
}

export function promptError(prompt: string): string | null {
  return prompt.length > MAX_PROMPT
    ? `The prompt is ${prompt.length} characters; the limit is ${MAX_PROMPT}. Shorten it to continue.`
    : null;
}

export interface GridErrors {
  rows?: string;
  cols?: string;
  overlap?: string;
}

const isWholeInRange = (value: number, min: number, max: number): boolean =>
  Number.isInteger(value) && value >= min && value <= max;

export function gridErrors(draft: Pick<JobDraft, 'rows' | 'cols' | 'overlapPct'>): GridErrors {
  const errors: GridErrors = {};
  if (!isWholeInRange(draft.rows, 1, MAX_GRID_AXIS)) errors.rows = `Rows must be a whole number from 1 to ${MAX_GRID_AXIS}.`;
  if (!isWholeInRange(draft.cols, 1, MAX_GRID_AXIS)) errors.cols = `Columns must be a whole number from 1 to ${MAX_GRID_AXIS}.`;
  if (!Number.isFinite(draft.overlapPct) || draft.overlapPct < 0 || draft.overlapPct > MAX_OVERLAP) {
    errors.overlap = `Overlap must be from 0 to ${MAX_OVERLAP} percent.`;
  }
  return errors;
}

export interface StartContext {
  asset: ImageAsset | null;
  providers: Record<ProviderId, SessionStatus>;
  /** Auto-detect is running. */
  detecting?: boolean;
}

/** Why Start is unavailable, or null when the draft is complete. The first problem found wins. */
export function startBlockReason(draft: JobDraft, { asset, providers, detecting = false }: StartContext): string | null {
  if (!asset) return 'Import an image on Home first.';
  if (draft.autoSelected && detecting) return 'Detecting the category from your image…';
  if (!draft.categoryId) return 'Choose a category.';
  const promptProblem = promptError(draft.prompt);
  if (promptProblem) return promptProblem;
  const gridProblem = Object.values(gridErrors(draft))[0];
  if (gridProblem) return gridProblem;
  if (!draft.providerId) return 'Choose a provider.';

  const status = providers[draft.providerId];
  if (status !== 'ready') {
    const name = PROVIDER_NAMES[draft.providerId];
    return status === 'unknown'
      ? `${name} has not been checked yet. Waiting for its status, or open Settings to log in.`
      : `${name} is not ready (${STATUS_LABELS[status]}). Fix it in Settings to continue.`;
  }
  return null;
}

/** The detected category and confidence, when the user is keeping the suggestion unchanged. */
export function keptSuggestion(draft: JobDraft, suggestion: CategorySuggestion | null): { confidence: number } | null {
  return suggestion && draft.autoSelected && draft.categoryId === suggestion.categoryId
    ? { confidence: suggestion.confidence }
    : null;
}

/** Prompt to analyse: the user's own text, never a category default (which would bias detection toward itself). */
export function detectionPrompt(draft: JobDraft, current: Category | undefined): string {
  return current?.defaultPrompt !== undefined && draft.prompt === current.defaultPrompt ? '' : draft.prompt;
}

/**
 * Call only after `startBlockReason` returned null. Pass `auto` when the detected category is being kept, and `wrap`
 * for a seamless-texture category: the job then carries what it needs to reproduce the previewed tile plan exactly.
 */
export function toCreateJobRequest(
  draft: JobDraft,
  assetId: string,
  auto: { confidence: number } | null = null,
  wrap = false,
): CreateJobRequest {
  if (!draft.categoryId || !draft.providerId) throw new Error('draft is incomplete');
  return {
    assetId,
    prompt: draft.prompt,
    categoryId: draft.categoryId,
    grid: { rows: draft.rows, cols: draft.cols, overlapPct: draft.overlapPct, ...(wrap ? { wrap: true } : {}) },
    providerId: draft.providerId,
    ...(auto ? { categorySource: 'auto' as const, categoryConfidence: auto.confidence } : {}),
  };
}
