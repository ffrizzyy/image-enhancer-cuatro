// Labeled-set check for auto-detect. The fixtures are synthetic (see autoFixtures.ts) and the
// heuristics were calibrated against them, so a pass shows the pieces fit together, not that
// real-world accuracy is the same. The plan keeps a manual run on real images for that.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CategorySuggestionSchema, type CategorySuggestion } from '@ie/contracts';
import { getCategory, SUGGESTION_THRESHOLD, suggestCategory } from '@ie/presets';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { extractFeatures } from '../src';
import { AUTO_FIXTURES, type AutoFixture } from './autoFixtures';

interface Result {
  fixture: AutoFixture;
  suggestion: CategorySuggestion;
  family: string | undefined;
}

let dir: string;
let results: Result[];

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ie-auto-'));
  results = [];
  for (const [i, fixture] of AUTO_FIXTURES.entries()) {
    const bytes = await fixture.build();
    const file = path.join(dir, `${i}.png`);
    writeFileSync(file, bytes);
    const meta = await sharp(bytes).metadata();
    const features = await extractFeatures({ path: file, width: meta.width!, height: meta.height! });
    const suggestion = suggestCategory(features, fixture.prompt);
    results.push({ fixture, suggestion, family: getCategory(suggestion.categoryId)?.family });
  }
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('auto-detect on the labeled fixture set', () => {
  it('has at least 20 labeled images covering every expected family', () => {
    expect(AUTO_FIXTURES.length).toBeGreaterThanOrEqual(20);
    expect(new Set(AUTO_FIXTURES.map((f) => f.expectedFamily))).toEqual(
      new Set(['stylize', 'texture', 'restore', 'environment', 'character', 'props']),
    );
  });

  it('never returns an invalid category, auto or custom, and always has a default prompt', () => {
    for (const { fixture, suggestion } of results) {
      expect(CategorySuggestionSchema.safeParse(suggestion).success, fixture.name).toBe(true);
      const category = getCategory(suggestion.categoryId);
      expect(category?.kind, fixture.name).toBe('prompt');
      expect(['auto', 'custom']).not.toContain(suggestion.categoryId);
      expect(category?.defaultPrompt, fixture.name).toBeTruthy();
    }
  });

  it('matches the labeled family for at least 70% of images', () => {
    const misses = results.filter((r) => r.family !== r.fixture.expectedFamily);
    const accuracy = 1 - misses.length / results.length;
    const detail = misses.map((r) => `${r.fixture.name}: expected ${r.fixture.expectedFamily}, got ${r.suggestion.categoryId}`);
    expect(accuracy, detail.join('\n')).toBeGreaterThanOrEqual(0.7);
  });

  it('passes every must-pass case: pixel art, line art, texture and low-contrast/restore', () => {
    const mustPass = results.filter((r) => r.fixture.mustPass);
    expect(mustPass.length).toBeGreaterThanOrEqual(8);
    for (const r of mustPass) {
      expect(r.family, `${r.fixture.name} -> ${r.suggestion.categoryId}`).toBe(r.fixture.expectedFamily);
    }
  });

  it('finds the specific category for the medium-defined cases', () => {
    const byName = (name: string) => results.find((r) => r.fixture.name === name)!.suggestion.categoryId;
    expect(byName('pixel sprite 32px upscaled')).toBe('pixel-art');
    expect(byName('line art on white')).toBe('lineart-to-render');
    expect(byName('transparent icon')).toBe('icon-ui');
    expect(byName('seamless texture prompt')).toBe('texture-material');
    expect(byName('low-contrast faded sepia')).toBe('photo-restore');
  });

  it('flags low confidence exactly when it is under the threshold, with top-3 alternatives', () => {
    for (const { fixture, suggestion } of results) {
      expect(suggestion.lowConfidence, fixture.name).toBe(suggestion.confidence < SUGGESTION_THRESHOLD);
      expect(suggestion.alternatives, fixture.name).toHaveLength(3);
      expect(suggestion.signals.length, fixture.name).toBeGreaterThan(0);
    }
  });

  it('is deterministic end to end (extraction and suggestion)', async () => {
    const i = AUTO_FIXTURES.findIndex((f) => f.name === 'pixel sprite 64px upscaled, game prompt');
    const file = path.join(dir, `${i}.png`);
    const meta = await sharp(file).metadata();
    const asset = { path: file, width: meta.width!, height: meta.height! };
    const [a, b] = [await extractFeatures(asset), await extractFeatures(asset)];
    expect(a).toEqual(b);
    expect(suggestCategory(a, 'x')).toEqual(suggestCategory(b, 'x'));
  });
});
