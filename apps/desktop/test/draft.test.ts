import type { Category, ImageAsset, ProviderId, SessionStatus } from '@ie/contracts';
import { listCategories } from '@ie/presets';
import { describe, expect, it } from 'vitest';

import {
  applyCategory,
  applyGridMode,
  detectionPrompt,
  emptyDraft,
  gridErrors,
  keptSuggestion,
  MAX_PROMPT,
  modeForGrid,
  promptError,
  startBlockReason,
  toCreateJobRequest,
  type JobDraft,
} from '../renderer/src/draft';

const categories = listCategories();
const cat = (id: string): Category => categories.find((c) => c.id === id)!;
const asset: ImageAsset = { id: 'A1', path: 'C:/a.png', width: 10, height: 10, sha256: 'a'.repeat(64) };
const providers = (over: Partial<Record<ProviderId, SessionStatus>> = {}) => ({
  gpt: 'unknown' as SessionStatus,
  gemini: 'ready' as SessionStatus,
  grok: 'unknown' as SessionStatus,
  ...over,
});
const complete = (over: Partial<JobDraft> = {}): JobDraft => ({
  ...applyCategory(emptyDraft(), cat('env-realistic'), undefined),
  providerId: 'gemini',
  ...over,
});

describe('applyCategory', () => {
  it('applies the category grid, overlap and default prompt to an empty draft', () => {
    const draft = applyCategory(emptyDraft(), cat('landscape-matte'), undefined);
    expect(draft).toMatchObject({
      categoryId: 'landscape-matte',
      rows: 2,
      cols: 4,
      gridMode: 'preset-8',
      overlapPct: 15,
      prompt: cat('landscape-matte').defaultPrompt,
    });
  });

  it('switches the prompt to the new default while the prompt is still the old default', () => {
    const first = applyCategory(emptyDraft(), cat('env-realistic'), undefined);
    const second = applyCategory(first, cat('photo-restore'), cat('env-realistic'));
    expect(second.prompt).toBe(cat('photo-restore').defaultPrompt);
  });

  it('keeps an edited prompt when switching categories', () => {
    const first = applyCategory(emptyDraft(), cat('env-realistic'), undefined);
    const edited = { ...first, prompt: 'my own words' };
    const second = applyCategory(edited, cat('photo-restore'), cat('env-realistic'));
    expect(second.prompt).toBe('my own words');
    expect(second.categoryId).toBe('photo-restore');
  });

  it('refills an emptied prompt', () => {
    const emptied = { ...applyCategory(emptyDraft(), cat('env-realistic'), undefined), prompt: '' };
    expect(applyCategory(emptied, cat('icon-ui'), cat('env-realistic')).prompt).toBe(cat('icon-ui').defaultPrompt);
  });

  it('uses custom grid mode for a category grid that is not a preset', () => {
    expect(applyCategory(emptyDraft(), cat('icon-ui'), undefined)).toMatchObject({ rows: 2, cols: 2, gridMode: 'custom' });
  });

  it('keeps the chosen provider', () => {
    const draft = applyCategory({ ...emptyDraft(), providerId: 'grok' }, cat('custom'), undefined);
    expect(draft.providerId).toBe('grok');
  });
});

describe('grid', () => {
  it('detects presets: 6 = 3×2 and 8 = 4×2 (columns × rows)', () => {
    expect(modeForGrid(2, 3)).toBe('preset-6');
    expect(modeForGrid(2, 4)).toBe('preset-8');
    expect(modeForGrid(3, 3)).toBe('custom');
    expect(modeForGrid(3, 2)).toBe('custom');
  });

  it('presets set rows and columns; custom keeps them', () => {
    const custom = applyGridMode({ ...emptyDraft(), rows: 5, cols: 4 }, 'custom');
    expect(custom).toMatchObject({ gridMode: 'custom', rows: 5, cols: 4 });
    expect(applyGridMode(custom, 'preset-8')).toMatchObject({ gridMode: 'preset-8', rows: 2, cols: 4 });
  });

  it('accepts 1–6 rows and columns and 0–40 overlap, up to 6×6', () => {
    expect(gridErrors({ rows: 6, cols: 6, overlapPct: 40 })).toEqual({});
    expect(gridErrors({ rows: 1, cols: 1, overlapPct: 0 })).toEqual({});
  });

  it.each([
    [{ rows: 7, cols: 2, overlapPct: 10 }, 'rows'],
    [{ rows: 0, cols: 2, overlapPct: 10 }, 'rows'],
    [{ rows: 2.5, cols: 2, overlapPct: 10 }, 'rows'],
    [{ rows: NaN, cols: 2, overlapPct: 10 }, 'rows'],
    [{ rows: 2, cols: 7, overlapPct: 10 }, 'cols'],
    [{ rows: 2, cols: 2, overlapPct: 41 }, 'overlap'],
    [{ rows: 2, cols: 2, overlapPct: -1 }, 'overlap'],
    [{ rows: 2, cols: 2, overlapPct: NaN }, 'overlap'],
  ] as const)('rejects %j (%s)', (grid, key) => {
    expect(gridErrors(grid)[key]).toBeTruthy();
  });
});

describe('promptError', () => {
  it('accepts 0 to 2000 characters and rejects more, with a clear message', () => {
    expect(promptError('')).toBeNull();
    expect(promptError('x'.repeat(MAX_PROMPT))).toBeNull();
    expect(promptError('x'.repeat(MAX_PROMPT + 1))).toMatch(/2001 characters; the limit is 2000/);
  });
});

describe('startBlockReason', () => {
  const ctx = { asset, providers: providers() };

  it('is null for a complete draft with a ready provider', () => {
    expect(startBlockReason(complete(), ctx)).toBeNull();
  });

  it('reports the first problem, in order', () => {
    expect(startBlockReason(complete(), { asset: null, providers: providers() })).toMatch(/Import an image/);
    expect(startBlockReason(emptyDraft(), ctx)).toBe('Choose a category.');
    expect(startBlockReason(complete({ prompt: 'x'.repeat(2001) }), ctx)).toMatch(/limit is 2000/);
    expect(startBlockReason(complete({ rows: 9 }), ctx)).toMatch(/Rows must be/);
    expect(startBlockReason(complete({ providerId: null }), ctx)).toBe('Choose a provider.');
  });

  it('allows an empty prompt (resolves to the default at Start)', () => {
    expect(startBlockReason(complete({ prompt: '' }), ctx)).toBeNull();
  });

  it.each([
    ['unknown', /ChatGPT has not been checked/],
    ['logged-out', /ChatGPT is not ready \(Logged out\)/],
    ['challenge', /not ready \(Needs verification\)/],
    ['quota-limited', /not ready \(Limit reached\)/],
  ] as const)('blocks a provider that is %s with a visible reason', (status, pattern) => {
    expect(startBlockReason(complete({ providerId: 'gpt' }), { asset, providers: providers({ gpt: status }) })).toMatch(pattern);
  });
});

describe('toCreateJobRequest', () => {
  it('builds the IPC request, keeping an empty prompt empty', () => {
    expect(toCreateJobRequest(complete({ prompt: '' }), 'A1')).toEqual({
      assetId: 'A1',
      prompt: '',
      categoryId: 'env-realistic',
      grid: { rows: 2, cols: 3, overlapPct: 15 },
      providerId: 'gemini',
    });
  });

  it('refuses an incomplete draft', () => {
    expect(() => toCreateJobRequest(emptyDraft(), 'A1')).toThrow(/incomplete/);
  });
});

describe('auto-detect helpers', () => {
  const suggestion = { categoryId: 'env-realistic', confidence: 0.72, alternatives: [], signals: ['x'], lowConfidence: false };
  const autoDraft = (over: Partial<JobDraft> = {}) => complete({ autoSelected: true, ...over });

  it('detectionPrompt sends the user text, but never a category default', () => {
    const env = cat('env-realistic');
    expect(detectionPrompt(complete({ prompt: 'a pixel sprite' }), env)).toBe('a pixel sprite');
    expect(detectionPrompt(complete({ prompt: env.defaultPrompt! }), env)).toBe('');
    expect(detectionPrompt(complete({ prompt: '' }), env)).toBe('');
    expect(detectionPrompt(complete({ prompt: 'x' }), undefined)).toBe('x');
  });

  it('keptSuggestion applies only while Auto is selected and the detected category is unchanged', () => {
    expect(keptSuggestion(autoDraft(), suggestion)).toEqual({ confidence: 0.72 });
    expect(keptSuggestion(autoDraft({ categoryId: 'photo-restore' }), suggestion)).toBeNull();
    expect(keptSuggestion(complete(), suggestion)).toBeNull();
    expect(keptSuggestion(autoDraft(), null)).toBeNull();
  });

  it('toCreateJobRequest records the auto source and confidence only when asked to', () => {
    expect(toCreateJobRequest(autoDraft(), 'A1', { confidence: 0.72 })).toMatchObject({
      categorySource: 'auto',
      categoryConfidence: 0.72,
    });
    expect(toCreateJobRequest(autoDraft(), 'A1')).not.toHaveProperty('categorySource');
  });

  it('blocks Start while detecting, but only when Auto is selected', () => {
    const ctx = { asset, providers: providers(), detecting: true };
    expect(startBlockReason(autoDraft(), ctx)).toMatch(/Detecting the category/);
    expect(startBlockReason(complete(), ctx)).toBeNull();
  });

  it('a fresh draft has Auto off', () => {
    expect(emptyDraft().autoSelected).toBe(false);
  });
});
