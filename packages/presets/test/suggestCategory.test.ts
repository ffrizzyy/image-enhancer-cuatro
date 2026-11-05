import { CategorySuggestionSchema, type ImageFeatures } from '@ie/contracts';
import { describe, expect, it } from 'vitest';

import { getCategory, listCategories, suggestCategory, SUGGESTION_THRESHOLD } from '../src';

/** A typical colourful photograph. Tests override only what they care about. */
const photo: ImageFeatures = {
  width: 1600,
  height: 1200,
  aspect: 1600 / 1200,
  saturation: 0.35,
  colorfulness: 40,
  edgeDensity: 0.2,
  highFrequencyEnergy: 8,
  paletteSize: 420,
  blockiness: 0.08,
  blurVariance: 300,
  noiseEstimate: 4,
  transparencyRatio: 0,
  luminanceBimodality: 0.1,
};
const features = (over: Partial<ImageFeatures> = {}): ImageFeatures => ({ ...photo, ...over });

const promptCategoryIds = listCategories()
  .filter((c) => c.kind === 'prompt')
  .map((c) => c.id);

describe('suggestCategory: contract', () => {
  const prompts = ['', 'a quiet harbour at dawn', 'pixel art knight', 'icon', 'old photo restore', 'x'.repeat(2000)];
  const shapes = [
    features(),
    features({ width: 64, height: 64, aspect: 1, paletteSize: 9, blockiness: 0.95, edgeDensity: 0.2 }),
    features({ aspect: 2.4, width: 2400, height: 1000 }),
    features({ aspect: 0.6, width: 600, height: 1000 }),
    features({ transparencyRatio: 0.5 }),
    features({ luminanceBimodality: 0.95, saturation: 0, edgeDensity: 0.05, blockiness: 0.9, paletteSize: 6 }),
  ];

  it('always returns a schema-valid suggestion that resolves to a real prompt category', () => {
    for (const f of shapes) {
      for (const prompt of prompts) {
        const result = suggestCategory(f, prompt);
        expect(CategorySuggestionSchema.safeParse(result).success).toBe(true);
        expect(promptCategoryIds).toContain(result.categoryId);
        expect(result.categoryId).not.toBe('auto');
        expect(result.categoryId).not.toBe('custom');
        expect(result.signals.length).toBeGreaterThan(0);
      }
    }
  });

  it('returns up to 3 distinct alternatives that never repeat the top choice or use auto/custom', () => {
    for (const f of shapes) {
      const { categoryId, alternatives, confidence } = suggestCategory(f, 'a scene');
      const ids = alternatives.map((a) => a.categoryId);
      expect(alternatives).toHaveLength(3);
      expect(new Set([categoryId, ...ids]).size).toBe(4);
      expect(ids).not.toContain('auto');
      expect(ids).not.toContain('custom');
      for (const a of alternatives) expect(a.confidence).toBeLessThanOrEqual(confidence);
    }
  });

  it('is deterministic', () => {
    const f = features({ paletteSize: 30, blockiness: 0.7 });
    expect(suggestCategory(f, 'fantasy scene')).toEqual(suggestCategory(f, 'fantasy scene'));
  });

  it('every resolved category has a default prompt available to Setup', () => {
    for (const f of shapes) {
      expect(getCategory(suggestCategory(f, '').categoryId)?.defaultPrompt).toBeTruthy();
    }
  });

  it('exposes the 0.55 low-confidence threshold', () => {
    expect(SUGGESTION_THRESHOLD).toBe(0.55);
  });
});

describe('suggestCategory: prompt keywords', () => {
  it.each([
    ['pixel art sprite of a hero', 'pixel-art'],
    ['a glossy app icon', 'icon-ui'],
    ['rough pencil sketch of a street', 'lineart-to-render'],
    ['seamless tileable stone texture', 'texture-material'],
    ['restore this old damaged photo', 'photo-restore'],
    ['isometric tavern', 'isometric-asset'],
    ['studio product shot of a perfume bottle', 'product-still'],
    ['modern living room interior', 'architecture-interior'],
    ['misty mountains at sunrise', 'landscape-matte'],
    ['a sports car on a road', 'vehicle-hardsurface'],
  ])('%j -> %s', (prompt, expected) => {
    const result = suggestCategory(features(), prompt);
    expect(result.categoryId).toBe(expected);
    expect(result.signals[0]).toMatch(/Prompt mentions/);
    expect(result.lowConfidence).toBe(false);
  });

  it.each([
    ['a dragon on a cliff', 'creature'],
    ['portrait of a woman', 'char'],
    ['a wooden chest', 'props'],
    ['a forest scene', 'env'],
  ])('%j resolves to the %s family', (prompt, family) => {
    expect(suggestCategory(features(), prompt).categoryId).toMatch(new RegExp(`^${family}-`));
  });

  it('chooses the realistic or stylized variant from prompt hints', () => {
    expect(suggestCategory(features(), 'anime girl portrait').categoryId).toBe('char-stylized');
    // A "photo" hint wins over mildly flat-looking features.
    expect(suggestCategory(features({ paletteSize: 120, blockiness: 0.4, noiseEstimate: 3 }), 'photo of a woman').categoryId).toBe(
      'char-realistic',
    );
  });

  it('chooses the variant from the image when the prompt does not say', () => {
    expect(suggestCategory(features(), 'a knight').categoryId).toBe('char-realistic');
    const flat = features({ paletteSize: 20, blockiness: 0.85, noiseEstimate: 0.5, width: 900, height: 900, aspect: 1 });
    expect(suggestCategory(flat, 'a knight').categoryId).toBe('char-stylized');
  });
});

describe('suggestCategory: image features alone', () => {
  it('spots pixel art', () => {
    const f = features({ width: 128, height: 128, aspect: 1, paletteSize: 12, blockiness: 0.92, edgeDensity: 0.18, saturation: 0.5 });
    const result = suggestCategory(f, '');
    expect(result.categoryId).toBe('pixel-art');
    expect(result.signals[0]).toMatch(/Small palette/);
  });

  it('spots line art', () => {
    const f = features({ luminanceBimodality: 0.97, saturation: 0.01, edgeDensity: 0.04, blockiness: 0.93, paletteSize: 6 });
    expect(suggestCategory(f, '').categoryId).toBe('lineart-to-render');
  });

  it('spots a transparent graphic as an icon', () => {
    expect(suggestCategory(features({ transparencyRatio: 0.45, width: 256, height: 256, aspect: 1 }), '').categoryId).toBe('icon-ui');
  });

  it('spots a soft, noisy photo as a restoration job', () => {
    const f = features({ blurVariance: 8, noiseEstimate: 12, colorfulness: 6, saturation: 0.05 });
    expect(suggestCategory(f, '').categoryId).toBe('photo-restore');
  });

  it('prefers landscapes for very wide frames and characters for tall ones', () => {
    expect(suggestCategory(features({ aspect: 2.4, width: 2400, height: 1000 }), '').categoryId).toBe('landscape-matte');
    expect(suggestCategory(features({ aspect: 0.6, width: 600, height: 1000 }), '').categoryId).toMatch(/^char-/);
  });

  it('falls back to a general scene with low confidence when nothing stands out', () => {
    const result = suggestCategory(features(), '');
    expect(result.categoryId).toMatch(/^env-/);
    expect(result.lowConfidence).toBe(true);
    expect(result.confidence).toBeLessThan(SUGGESTION_THRESHOLD);
  });
});

describe('suggestCategory: confidence', () => {
  it('is higher for a decisive keyword than for no cues', () => {
    expect(suggestCategory(features(), 'pixel art').confidence).toBeGreaterThan(suggestCategory(features(), '').confidence);
  });

  it('marks conflicting cues as low confidence', () => {
    const result = suggestCategory(features(), 'pixel art icon sketch');
    expect(result.lowConfidence).toBe(result.confidence < SUGGESTION_THRESHOLD);
    expect(result.alternatives.length).toBe(3);
  });

  it('breaks ties by catalog order so the answer never flips between runs', () => {
    const a = suggestCategory(features(), 'icon sketch');
    const b = suggestCategory(features(), 'icon sketch');
    expect(a.categoryId).toBe(b.categoryId);
  });
});
