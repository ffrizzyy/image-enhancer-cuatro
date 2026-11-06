import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CategorySchema, type Category } from '@ie/contracts';
import { z } from 'zod';

import { validateTemplate } from './buildPrompt';

/** What a person may change about a category: its prompt template and its default prompt. Nothing else. */
const OverrideSchema = z.object({
  template: z.string().min(1).max(8000).optional(),
  defaultPrompt: z.string().min(1).max(2000).optional(),
});
export type CategoryOverride = z.infer<typeof OverrideSchema>;

export class OverrideError extends Error {
  readonly code = 'invalid-override';
  constructor(message: string) {
    super(message);
    this.name = 'OverrideError';
  }
}

let directory: string | null = null;
let cache: Map<string, CategoryOverride> | null = null;

/** Points the overrides at a folder (`userData/overrides`), or turns them off with `null`. The shipped catalog is never written. */
export function configureOverrides(dir: string | null): void {
  directory = dir;
  cache = null;
}

const idPattern = /^[a-z0-9-]+$/;

function loadAll(): Map<string, CategoryOverride> {
  if (cache) return cache;
  const found = new Map<string, CategoryOverride>();
  if (directory) {
    let files: string[] = [];
    try {
      files = readdirSync(directory).filter((f) => f.endsWith('.json'));
    } catch {
      /* no folder yet: no overrides */
    }
    for (const file of files) {
      const id = file.slice(0, -'.json'.length);
      if (!idPattern.test(id)) continue;
      try {
        const parsed = OverrideSchema.safeParse(JSON.parse(readFileSync(path.join(directory, file), 'utf8')));
        // A damaged or hand-edited file is ignored rather than breaking every job.
        if (parsed.success && (parsed.data.template === undefined || validateTemplate(parsed.data.template) === null)) found.set(id, parsed.data);
      } catch {
        /* unreadable file: ignored */
      }
    }
  }
  cache = found;
  return found;
}

/** The category with its override applied, or unchanged when it has none. */
export function applyOverride(category: Category): Category {
  const override = loadAll().get(category.id);
  if (!override || category.kind !== 'prompt') return category;
  return {
    ...category,
    ...(override.template !== undefined ? { template: override.template } : {}),
    ...(override.defaultPrompt !== undefined ? { defaultPrompt: override.defaultPrompt } : {}),
  };
}

export function listOverriddenIds(): string[] {
  return [...loadAll().keys()].sort();
}

/**
 * Validates and stores an override for a shipped prompt category. Throws `OverrideError` with a plain message when the
 * template is unusable. A value equal to the shipped one is not stored, so "no change" leaves no override behind.
 */
export function saveOverride(shipped: Category, patch: CategoryOverride): Category {
  if (!directory) throw new OverrideError('Overrides are not available here.');
  if (shipped.kind !== 'prompt') throw new OverrideError('This category has no prompt to change.');
  const parsed = OverrideSchema.safeParse(patch);
  if (!parsed.success) throw new OverrideError('The template must be 1-8000 characters and the default prompt 1-2000.');

  if (parsed.data.template !== undefined) {
    const problem = validateTemplate(parsed.data.template);
    if (problem) throw new OverrideError(problem);
  }

  const next: CategoryOverride = {};
  if (parsed.data.template !== undefined && parsed.data.template !== shipped.template) next.template = parsed.data.template;
  if (parsed.data.defaultPrompt !== undefined && parsed.data.defaultPrompt !== shipped.defaultPrompt) next.defaultPrompt = parsed.data.defaultPrompt;

  // The result must still be a valid category.
  const merged = CategorySchema.safeParse({ ...shipped, ...next });
  if (!merged.success) throw new OverrideError('That change would make the category invalid.');

  if (Object.keys(next).length === 0) {
    resetOverride(shipped.id);
    return shipped;
  }
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${shipped.id}.json`);
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(next, null, 2));
  renameSync(temp, file);
  cache = null;
  return merged.data;
}

/** Removes a category's override, so the shipped template is used again. */
export function resetOverride(categoryId: string): void {
  if (!directory || !idPattern.test(categoryId)) return;
  rmSync(path.join(directory, `${categoryId}.json`), { force: true });
  cache = null;
}
