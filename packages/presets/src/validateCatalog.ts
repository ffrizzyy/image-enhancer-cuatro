import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { CategorySchema, type Category } from '@ie/contracts';

import { validateTemplate } from './buildPrompt';

export interface CatalogReport {
  categories: Category[];
  errors: string[];
}

/** Validates every `*.json` category file in a directory. Never throws on bad content. */
export function validateCatalogDir(dir: string): CatalogReport {
  const errors: string[] = [];
  const categories: Category[] = [];
  const seen = new Map<string, string>();

  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();

  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    } catch (error) {
      errors.push(`${file}: invalid JSON (${error instanceof Error ? error.message : 'unreadable'})`);
      continue;
    }

    const parsed = CategorySchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      errors.push(`${file}: ${issues.join('; ')}`);
      continue;
    }

    const category = parsed.data;
    if (file !== `${category.id}.json`) errors.push(`${file}: file name must match id "${category.id}"`);

    const firstFile = seen.get(category.id);
    if (firstFile) errors.push(`${file}: duplicate id "${category.id}" (also in ${firstFile})`);
    seen.set(category.id, file);

    if (category.kind === 'prompt' && category.template) {
      const problem = validateTemplate(category.template);
      if (problem) errors.push(`${file}: ${problem}`);
    }

    categories.push(category);
  }

  return { categories, errors };
}
