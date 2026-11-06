import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  configureOverrides,
  getCategory,
  getShippedCategory,
  listCategories,
  listOverriddenIds,
  resetCategoryOverride,
  saveCategoryOverride,
} from '../src';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ie-overrides-'));
  configureOverrides(path.join(dir, 'overrides'));
});
afterEach(() => {
  configureOverrides(null);
  rmSync(dir, { recursive: true, force: true });
});

const shipped = () => getShippedCategory('env-realistic')!;

describe('category overrides', () => {
  it('stores an override in the overrides folder and uses it, leaving the shipped category untouched', () => {
    const template = shipped().template!.replace('MASTER GUIDE', 'MY GUIDE');
    saveCategoryOverride('env-realistic', { template, defaultPrompt: 'My own default.' });

    expect(getCategory('env-realistic')).toMatchObject({ template, defaultPrompt: 'My own default.' });
    expect(listCategories().find((c) => c.id === 'env-realistic')!.defaultPrompt).toBe('My own default.');
    expect(shipped().defaultPrompt).not.toBe('My own default.');
    expect(listOverriddenIds()).toEqual(['env-realistic']);
    expect(existsSync(path.join(dir, 'overrides', 'env-realistic.json'))).toBe(true);
  });

  it('survives a restart (a fresh read of the folder)', () => {
    saveCategoryOverride('env-realistic', { defaultPrompt: 'Persisted.' });
    configureOverrides(path.join(dir, 'overrides'));
    expect(getCategory('env-realistic')!.defaultPrompt).toBe('Persisted.');
  });

  it('resets to the shipped template', () => {
    saveCategoryOverride('env-realistic', { defaultPrompt: 'Temporary.' });
    const back = resetCategoryOverride('env-realistic');
    expect(back).toEqual(shipped());
    expect(getCategory('env-realistic')).toEqual(shipped());
    expect(listOverriddenIds()).toEqual([]);
  });

  it('rejects a template without the required placeholders, or with unknown ones, and stores nothing', () => {
    expect(() => saveCategoryOverride('env-realistic', { template: 'no placeholders' })).toThrow(/userPrompt/);
    expect(() => saveCategoryOverride('env-realistic', { template: '{{userPrompt}} {{fidelityClause}} {{bogus}}' })).toThrow(/unknown placeholders/);
    expect(() => saveCategoryOverride('env-realistic', { defaultPrompt: 'x'.repeat(2001) })).toThrow();
    expect(listOverriddenIds()).toEqual([]);
  });

  it('refuses the auto category and unknown ids', () => {
    expect(() => saveCategoryOverride('auto', { defaultPrompt: 'x' })).toThrow();
    expect(() => saveCategoryOverride('nope', { defaultPrompt: 'x' })).toThrow(/does not exist/);
  });

  it('stores nothing when the values equal the shipped ones', () => {
    saveCategoryOverride('env-realistic', { template: shipped().template!, defaultPrompt: shipped().defaultPrompt! });
    expect(listOverriddenIds()).toEqual([]);
  });

  it('ignores a damaged override file', () => {
    saveCategoryOverride('env-realistic', { defaultPrompt: 'Fine.' });
    writeFileSync(path.join(dir, 'overrides', 'env-realistic.json'), '{ not json');
    configureOverrides(path.join(dir, 'overrides'));
    expect(getCategory('env-realistic')).toEqual(shipped());
  });

  it('writes valid JSON with only the changed fields', () => {
    saveCategoryOverride('env-realistic', { defaultPrompt: 'Only this.' });
    expect(JSON.parse(readFileSync(path.join(dir, 'overrides', 'env-realistic.json'), 'utf8'))).toEqual({ defaultPrompt: 'Only this.' });
  });
});
