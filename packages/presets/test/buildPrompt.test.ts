import type { Category } from '@ie/contracts';
import { describe, expect, it } from 'vitest';

import {
  AutoCategoryError,
  buildPrompt,
  describeTile,
  FIDELITY_CLAUSES,
  getCategory,
  listCategories,
  validateTemplate,
  type TileInfo,
} from '../src';

const grid = { rows: 3, cols: 3 };
const TILES: Record<string, TileInfo> = {
  corner: { role: 'corner', row: 0, col: 2, grid },
  edge: { role: 'edge', row: 1, col: 0, grid },
  center: { role: 'center', row: 1, col: 1, grid },
};

const USER_PROMPT = 'a rain-soaked alley at dusk, neon signs';

function category(id: string): Category {
  const found = getCategory(id);
  if (!found) throw new Error(`missing category ${id}`);
  return found;
}

describe('catalog access', () => {
  it('lists auto first, then all 19 prompt categories', () => {
    const categories = listCategories();
    expect(categories).toHaveLength(20);
    expect(categories[0]).toMatchObject({ id: 'auto', kind: 'auto', family: 'smart' });
    expect(categories.filter((c) => c.kind === 'prompt')).toHaveLength(19);
  });

  it('returns copies so callers cannot mutate the catalog', () => {
    const first = category('custom');
    first.name = 'mutated';
    expect(category('custom').name).toBe('Custom');
    expect(getCategory('does-not-exist')).toBeUndefined();
  });
});

describe('buildPrompt', () => {
  it('includes the user prompt verbatim and the fidelity clause, for every category and role', () => {
    for (const c of listCategories().filter((category) => category.kind === 'prompt')) {
      for (const tile of Object.values(TILES)) {
        const { text } = buildPrompt(c, USER_PROMPT, tile);
        expect(text).toContain(USER_PROMPT);
        expect(text).toContain(FIDELITY_CLAUSES[c.fidelity]);
        expect(text).not.toMatch(/\{\{/);
      }
    }
  });

  it('is deterministic', () => {
    const c = category('env-realistic');
    expect(buildPrompt(c, USER_PROMPT, TILES.corner!)).toEqual(buildPrompt(c, USER_PROMPT, TILES.corner!));
  });

  it('produces different text for corner vs center', () => {
    const c = category('env-realistic');
    expect(buildPrompt(c, USER_PROMPT, TILES.corner!).text).not.toBe(buildPrompt(c, USER_PROMPT, TILES.center!).text);
  });

  it('does not re-scan the user prompt for placeholders', () => {
    const { text } = buildPrompt(category('custom'), 'use {{tileRole}} and {{fidelityClause}} literally', TILES.center!);
    expect(text).toContain('use {{tileRole}} and {{fidelityClause}} literally');
  });

  it('leaves unknown placeholders untouched, including prototype names', () => {
    const c = { ...category('custom'), template: '{{userPrompt}} {{fidelityClause}} {{toString}} {{nope}}' };
    const { text } = buildPrompt(c, 'x', TILES.center!);
    expect(text).toContain('{{toString}} {{nope}}');
  });

  it('adds the identity-lock clause for char-realistic only', () => {
    expect(buildPrompt(category('char-realistic'), USER_PROMPT, TILES.center!).text).toMatch(/identity lock/i);
    expect(buildPrompt(category('env-realistic'), USER_PROMPT, TILES.center!).text).not.toMatch(/identity lock/i);
  });

  it('sets wrap only for texture-material', () => {
    expect(buildPrompt(category('texture-material'), USER_PROMPT, TILES.edge!).wrap).toBe(true);
    expect(buildPrompt(category('env-realistic'), USER_PROMPT, TILES.edge!).wrap).toBe(false);
  });

  it('lists negatives only when the category has them', () => {
    expect(buildPrompt(category('env-realistic'), 'x', TILES.center!).text).toContain('Avoid: cartoon look');
    expect(buildPrompt(category('custom'), 'x', TILES.center!).text).not.toContain('Avoid:');
  });

  it('rejects the auto category with a typed error', () => {
    expect(() => buildPrompt(category('auto'), 'x', TILES.center!)).toThrow(AutoCategoryError);
    expect(() => buildPrompt(category('auto'), 'x', TILES.center!)).toThrow(/resolve it to a prompt category/);
  });

  it('rejects a prompt category that has no template', () => {
    const broken: Category = { ...category('custom') };
    delete broken.template;
    expect(() => buildPrompt(broken, 'x', TILES.center!)).toThrow(/no prompt template/);
  });
  describe('golden prompts', () => {
    for (const id of ['env-realistic', 'char-realistic', 'texture-material', 'custom']) {
      for (const [role, tile] of Object.entries(TILES)) {
        it(`${id} / ${role}`, () => {
          expect(buildPrompt(category(id), USER_PROMPT, tile).text).toMatchSnapshot();
        });
      }
    }
  });
});

describe('describeTile', () => {
  it('names the corner and edge positions', () => {
    expect(describeTile({ role: 'corner', row: 0, col: 0, grid })).toBe('the top-left corner of the full image');
    expect(describeTile({ role: 'corner', row: 2, col: 2, grid })).toBe('the bottom-right corner of the full image');
    expect(describeTile({ role: 'edge', row: 0, col: 1, grid })).toBe('the top edge of the full image');
    expect(describeTile({ role: 'edge', row: 1, col: 2, grid })).toBe('the right edge of the full image');
    expect(describeTile({ role: 'center', row: 1, col: 1, grid })).toBe('a central area of the full image');
  });

  it('falls back to generic wording when position and role disagree', () => {
    expect(describeTile({ role: 'corner', row: 1, col: 1, grid })).toBe('the corner of the full image');
    expect(describeTile({ role: 'edge', row: 1, col: 1, grid })).toBe('the edge of the full image');
  });
});

describe('validateTemplate', () => {
  it('accepts a template with both required placeholders', () => {
    expect(validateTemplate('{{fidelityClause}} {{ userPrompt }} {{tileRole}}')).toBeNull();
  });

  it('gives specific errors', () => {
    expect(validateTemplate('{{fidelityClause}} only')).toBe('template must contain {{userPrompt}}');
    expect(validateTemplate('{{userPrompt}} only')).toBe('template must contain {{fidelityClause}}');
    expect(validateTemplate('{{userPrompt}} {{fidelityClause}} {{bogus}}')).toBe(
      'template has unknown placeholders: bogus',
    );
  });
});
