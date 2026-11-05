import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listCategories, validateCatalogDir, validateTemplate } from '../src';

const catalogDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'catalog');
const valid = JSON.parse(readFileSync(path.join(catalogDir, 'custom.json'), 'utf8')) as Record<string, unknown>;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ie-catalog-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, content: unknown): void {
  writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
}

describe('shipped catalog', () => {
  it('validates with no errors', () => {
    const report = validateCatalogDir(catalogDir);
    expect(report.errors).toEqual([]);
  });

  it('registers every file in the catalog directory', () => {
    const files = readdirSync(catalogDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    expect(
      listCategories()
        .map((c) => c.id)
        .sort(),
    ).toEqual(files);
  });
});

// Frozen contract: shipped ids are never renamed or removed (SPEC-presets.md).
const SHIPPED: Record<string, { family: string; fidelity: string }> = {
  auto: { family: 'smart', fidelity: 'balanced' },
  'env-realistic': { family: 'environment', fidelity: 'preserve' },
  'env-stylized': { family: 'environment', fidelity: 'balanced' },
  'props-realistic': { family: 'props', fidelity: 'preserve' },
  'props-stylized': { family: 'props', fidelity: 'balanced' },
  'char-realistic': { family: 'character', fidelity: 'strict' },
  'char-stylized': { family: 'character', fidelity: 'strict' },
  'creature-realistic': { family: 'character', fidelity: 'preserve' },
  'creature-stylized': { family: 'character', fidelity: 'balanced' },
  'vehicle-hardsurface': { family: 'props', fidelity: 'preserve' },
  'architecture-interior': { family: 'environment', fidelity: 'preserve' },
  'landscape-matte': { family: 'environment', fidelity: 'balanced' },
  'texture-material': { family: 'texture', fidelity: 'strict' },
  'photo-restore': { family: 'restore', fidelity: 'strict' },
  'lineart-to-render': { family: 'stylize', fidelity: 'balanced' },
  'pixel-art': { family: 'stylize', fidelity: 'strict' },
  'product-still': { family: 'props', fidelity: 'preserve' },
  'isometric-asset': { family: 'props', fidelity: 'preserve' },
  'icon-ui': { family: 'stylize', fidelity: 'strict' },
  custom: { family: 'custom', fidelity: 'balanced' },
};

describe('catalog rules', () => {
  const categories = listCategories();

  it('ships exactly the 20 frozen ids, unique, with the spec family and fidelity', () => {
    expect(categories.map((c) => c.id).sort()).toEqual(Object.keys(SHIPPED).sort());
    for (const c of categories) expect(SHIPPED[c.id]).toEqual({ family: c.family, fidelity: c.fidelity });
  });

  it('gives every prompt category a non-empty defaultPrompt of at most 2000 characters', () => {
    for (const c of categories.filter((category) => category.kind === 'prompt')) {
      expect(c.defaultPrompt?.length, c.id).toBeGreaterThan(0);
      expect(c.defaultPrompt!.length, c.id).toBeLessThanOrEqual(2000);
    }
  });

  it('locks identity and warns about face splitting for every character and creature category', () => {
    const locked = categories.filter((c) => c.family === 'character');
    expect(locked.map((c) => c.id).sort()).toEqual([
      'char-realistic',
      'char-stylized',
      'creature-realistic',
      'creature-stylized',
    ]);
    for (const c of locked) {
      expect(c.template, c.id).toMatch(/identity lock/i);
      expect(c.warnings.join(' '), c.id).toMatch(/faces/i);
    }
  });

  it('has auto as the only meta-category: first, kind auto, no template or default prompt', () => {
    expect(categories[0]?.id).toBe('auto');
    expect(categories.filter((c) => c.kind === 'auto').map((c) => c.id)).toEqual(['auto']);
    expect(categories[0]).not.toHaveProperty('template');
    expect(categories[0]).not.toHaveProperty('defaultPrompt');
  });

  it('exposes the wrap flag on texture-material only', () => {
    expect(categories.filter((c) => c.wrap).map((c) => c.id)).toEqual(['texture-material']);
  });

  it('keeps templates and prompts provider-neutral', () => {
    const providerWords = /chatgpt|openai|gpt|gemini|grok|midjourney|dall-?e/i;
    for (const c of categories) {
      expect(`${c.template} ${c.defaultPrompt} ${c.negative.join(' ')}`, c.id).not.toMatch(providerWords);
    }
  });

  it('accepts custom with {{userPrompt}} and rejects it without', () => {
    expect(validateTemplate(categories.find((c) => c.id === 'custom')!.template!)).toBeNull();
    expect(validateTemplate('{{fidelityClause}} no user prompt')).toBe('template must contain {{userPrompt}}');
  });
});

describe('validateCatalogDir', () => {
  it('accepts a valid category', () => {
    write('custom.json', valid);
    expect(validateCatalogDir(dir)).toMatchObject({ errors: [] });
  });

  it('reports invalid JSON without throwing', () => {
    write('custom.json', '{ not json');
    expect(validateCatalogDir(dir).errors[0]).toMatch(/custom\.json: invalid JSON/);
  });

  it('reports schema violations with the failing field', () => {
    write('custom.json', { ...valid, defaultPrompt: 'x'.repeat(2001) });
    expect(validateCatalogDir(dir).errors[0]).toMatch(/custom\.json: defaultPrompt/);
  });

  it('requires a defaultPrompt on prompt categories', () => {
    const withoutDefault = { ...valid };
    delete withoutDefault.defaultPrompt;
    write('custom.json', withoutDefault);
    expect(validateCatalogDir(dir).errors[0]).toMatch(/defaultPrompt/);
  });

  it('rejects a template missing {{userPrompt}} with a specific error', () => {
    write('custom.json', { ...valid, template: '{{fidelityClause}} nothing else' });
    expect(validateCatalogDir(dir).errors).toEqual(['custom.json: template must contain {{userPrompt}}']);
  });

  it('rejects a file name that does not match the id', () => {
    write('other.json', valid);
    expect(validateCatalogDir(dir).errors[0]).toMatch(/file name must match id "custom"/);
  });

  it('rejects duplicate ids', () => {
    write('custom.json', valid);
    write('custom-copy.json', valid);
    const errors = validateCatalogDir(dir).errors.join('\n');
    expect(errors).toMatch(/duplicate id "custom"/);
  });

  it('ignores non-JSON files', () => {
    write('README.md', '# notes');
    expect(validateCatalogDir(dir)).toEqual({ categories: [], errors: [] });
  });
});
