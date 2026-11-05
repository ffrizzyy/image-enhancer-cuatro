import { JobGridSchema, JobSchema, type ImageAsset, type Job } from '@ie/contracts';
import { getCategory } from '@ie/presets';
import { ulid } from 'ulid';

import { IntakeError, type JobConfig } from './types';

export interface CreateJobOptions {
  newId?: () => string;
  now?: () => Date;
}

const MAX_PROMPT = 2000;

function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') deepFreeze(child);
  }
  return Object.freeze(value);
}

/**
 * Builds the immutable Job. Call it at Start, never at import. Does not check provider
 * health; that happens at run time.
 */
export function createJob(asset: ImageAsset, config: JobConfig, options: CreateJobOptions = {}): Job {
  const category = getCategory(config.categoryId);
  if (!category) throw new IntakeError('unknown-category', `Unknown category "${config.categoryId}".`);
  if (category.kind !== 'prompt' || !category.defaultPrompt) {
    throw new IntakeError('unknown-category', `Category "${config.categoryId}" cannot be used directly.`);
  }

  const grid = JobGridSchema.safeParse(config.grid);
  if (!grid.success) {
    throw new IntakeError('invalid-grid', 'Grid must be 1–6 rows and columns with 0–40% overlap.');
  }

  const useDefault = config.prompt.trim().length === 0;
  const prompt = useDefault ? category.defaultPrompt : config.prompt;
  if (prompt.length > MAX_PROMPT) {
    throw new IntakeError('invalid-prompt', `The prompt is ${prompt.length} characters; the limit is ${MAX_PROMPT}.`);
  }

  const categorySource = config.categorySource ?? 'user';
  const parsed = JobSchema.safeParse({
    id: (options.newId ?? ulid)(),
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    source: { path: asset.path, width: asset.width, height: asset.height, sha256: asset.sha256 },
    prompt,
    promptSource: useDefault ? 'category-default' : 'user',
    categoryId: category.id,
    categorySource,
    ...(categorySource === 'auto' && config.categoryConfidence !== undefined
      ? { categoryConfidence: config.categoryConfidence }
      : {}),
    grid: grid.data,
    providerId: config.providerId,
  });
  if (!parsed.success) {
    throw new IntakeError('invalid-config', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return deepFreeze(parsed.data);
}
