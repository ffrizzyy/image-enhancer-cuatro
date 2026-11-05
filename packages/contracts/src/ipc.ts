import { z } from 'zod';

import type { IpcChannel, IpcContract, IpcEventChannel, IpcEvents } from './types.js';

/**
 * Bumped whenever a channel's request or response shape changes.
 * The preload bridge and the main process must agree on this value.
 */
export const IPC_VERSION = 1;

/** Bump when the first-run ToS/account-risk notice changes; users must acknowledge the new text. */
export const CURRENT_RISK_NOTICE_VERSION = 1;

const id = z.string().min(1).max(64);
const path = z.string().min(1).max(4096);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'expected a lowercase hex sha256');
const isoDate = z.string().datetime({ offset: true });
const gridAxis = z.number().int().min(1).max(6);
const overlapPct = z.number().min(0).max(40);

export const ProviderIdSchema = z.enum(['gpt', 'gemini', 'grok']);

export const SessionStatusSchema = z.enum([
  'logged-out',
  'ready',
  'challenge',
  'quota-limited',
  'unknown',
]);

export const SizeSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const RectSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

/**
 * A rect that may extend past the image: negative x/y, or an edge beyond the width/height.
 * Used for a tile's `crop` (overlap that wraps to the opposite edge) and `send` (context padding
 * filled by neighbouring pixels, wrap-around, or edge reflection).
 */
export const SignedRectSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const GridSchema = z.object({
  rows: gridAxis,
  cols: gridAxis,
});

export const ImageAssetSchema = z.object({
  id,
  path,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sha256,
  featuresPath: path.optional(),
});

export const ImageFeaturesSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  aspect: z.number().positive(),
  saturation: z.number().min(0).max(1),
  colorfulness: z.number().min(0),
  edgeDensity: z.number().min(0).max(1),
  highFrequencyEnergy: z.number().min(0),
  paletteSize: z.number().int().min(0),
  blockiness: z.number().min(0).max(1),
  blurVariance: z.number().min(0),
  noiseEstimate: z.number().min(0),
  transparencyRatio: z.number().min(0).max(1),
  luminanceBimodality: z.number().min(0).max(1),
});

export const CategoryKindSchema = z.enum(['prompt', 'auto']);

export const CategoryFamilySchema = z.enum([
  'environment',
  'props',
  'character',
  'texture',
  'restore',
  'stylize',
  'custom',
  'smart',
]);

export const FidelitySchema = z.enum(['strict', 'preserve', 'balanced', 'reimagine']);

export const CategorySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1),
    kind: CategoryKindSchema.default('prompt'),
    family: CategoryFamilySchema,
    fidelity: FidelitySchema,
    template: z.string().min(1).max(8000).optional(),
    defaultPrompt: z.string().min(1).max(2000).optional(),
    negative: z.array(z.string().min(1)),
    defaults: z.object({
      grid: z.tuple([gridAxis, gridAxis]),
      overlapPct,
    }),
    /** Edges must stay tileable; consumed by the slicer and stitcher (texture categories). */
    wrap: z.boolean().default(false),
    warnings: z.array(z.string().min(1)).default([]),
  })
  .superRefine((category, ctx) => {
    if (category.kind !== 'prompt') {
      return;
    }

    if (!category.template) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['template'],
        message: 'prompt categories require a template',
      });
    }

    if (!category.defaultPrompt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultPrompt'],
        message: 'prompt categories require a defaultPrompt',
      });
    }
  });

export const CategorySuggestionSchema = z
  .object({
    categoryId: z.string().min(1),
    confidence: z.number().min(0).max(1),
    alternatives: z
      .array(
        z.object({
          categoryId: z.string().min(1),
          confidence: z.number().min(0).max(1),
        }),
      )
      .max(3),
    signals: z.array(z.string().min(1)),
    lowConfidence: z.boolean(),
  })
  .superRefine((suggestion, ctx) => {
    for (const [index, candidate] of [
      { categoryId: suggestion.categoryId },
      ...suggestion.alternatives,
    ].entries()) {
      if (candidate.categoryId === 'auto' || candidate.categoryId === 'custom') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: index === 0 ? ['categoryId'] : ['alternatives', index - 1, 'categoryId'],
          message: 'auto-detect must resolve to a prompt-kind category',
        });
      }
    }
  });

export const CategorySourceSchema = z.enum(['user', 'auto']);
export const PromptSourceSchema = z.enum(['user', 'category-default']);

export const SourceImageSchema = z.object({
  path,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sha256,
});

export const JobGridSchema = z.object({
  rows: gridAxis,
  cols: gridAxis,
  overlapPct,
  wrap: z.boolean().optional(),
});

export const JobSchema = z.object({
  id,
  createdAt: isoDate,
  source: SourceImageSchema,
  prompt: z.string().min(1).max(2000),
  promptSource: PromptSourceSchema,
  categoryId: z.string().min(1),
  categorySource: CategorySourceSchema,
  categoryConfidence: z.number().min(0).max(1).optional(),
  grid: JobGridSchema,
  providerId: ProviderIdSchema,
});

export const ImagePreviewSchema = z.object({
  dataUrl: z.string().regex(/^data:image\/(jpeg|png);base64,/).max(8_000_000),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const CreateJobRequestSchema = z.object({
  assetId: id,
  // Empty is valid: it resolves to the category default at creation time.
  prompt: z.string().max(2000),
  categoryId: z.string().min(1),
  grid: JobGridSchema,
  providerId: ProviderIdSchema,
  categorySource: CategorySourceSchema.optional(),
  categoryConfidence: z.number().min(0).max(1).optional(),
});

export const TileEdgesSchema = z.object({
  top: z.boolean(),
  right: z.boolean(),
  bottom: z.boolean(),
  left: z.boolean(),
});

export const TileRoleSchema = z.enum(['corner', 'edge', 'center']);

export const TileSchema = z.object({
  index: z.number().int().min(0),
  row: z.number().int().min(0),
  col: z.number().int().min(0),
  core: RectSchema,
  crop: SignedRectSchema,
  send: SignedRectSchema,
  edges: TileEdgesSchema,
  role: TileRoleSchema,
});

export const TilePlanSchema = z.object({
  source: SizeSchema,
  grid: GridSchema,
  overlapPx: z.number().int().min(0),
  wrap: z.boolean(),
  tiles: z.array(TileSchema),
});

export const JobStateSchema = z.enum([
  'idle',
  'preflight',
  'running',
  'paused',
  'needs-review',
  'stitching',
  'done',
  'failed',
  'cancelled',
]);

export const TileStateSchema = z.enum([
  'pending',
  'running',
  'accepted',
  'retrying',
  'needs-review',
  'failed',
]);

export const PauseReasonSchema = z.enum(['challenge', 'logged-out', 'quota', 'user']);

export const JobModeSchema = z.enum(['chained', 'independent']);

export const PacingSchema = z.object({
  concurrency: z.union([z.literal(1), z.literal(2)]),
  minDelayMs: z.number().int().min(0),
  maxDelayMs: z.number().int().min(0),
});

export const ProviderErrorKindSchema = z.enum([
  'logged-out',
  'challenge',
  'quota',
  'refusal',
  'timeout',
  'ui-changed',
  'download-failed',
]);

export const EnhanceAttachmentSchema = z.object({
  role: z.enum(['tile', 'global-reference', 'neighbor']),
  path,
});

export const EnhanceRequestSchema = z.object({
  attachments: z.array(EnhanceAttachmentSchema).min(1),
  prompt: z.string().min(1).max(4000),
  timeoutMs: z.number().int().positive(),
});

export const EnhanceResultSchema = z.object({
  imagePath: path,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  elapsedMs: z.number().int().min(0),
});

export const ProviderCapabilitiesSchema = z.object({
  maxAttachments: z.number().int().min(1),
  outputAspects: z.array(z.string().min(1)),
  approxOutputPx: z.number().int().positive(),
});

export const ProviderHealthSchema = z.object({
  ok: z.boolean(),
  missingSelectors: z.array(z.string().min(1)),
});

export const BlendModeSchema = z.enum(['multiband', 'feather']);

export const StitchOptionsSchema = z.object({
  blend: BlendModeSchema,
  maxShiftPx: z.number().int().min(0),
  harmonize: z.boolean(),
});

export const StitchMetricsSchema = z.object({
  seamScore: z.number().min(0),
  maxDeltaE: z.number().min(0),
});

export const StitchResultSchema = z.object({
  imagePath: path,
  metrics: StitchMetricsSchema,
  flagged: z.array(z.number().int().min(0)),
});

export const StitchInputSchema = z.object({
  plan: TilePlanSchema,
  tiles: z.array(z.object({ index: z.number().int().min(0), path })),
  options: StitchOptionsSchema,
});

export const ExportFormatSchema = z.enum(['png', 'jpeg', 'webp']);

export const ExportRequestSchema = z.object({
  imagePath: path,
  format: ExportFormatSchema,
  quality: z.number().int().min(1).max(100).optional(),
  destination: path.optional(),
});

export const ExportResultSchema = z.object({
  path,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const PacingPresetSchema = z.enum(['safe', 'normal']);

export const AppSettingsSchema = z.object({
  firstRunAcknowledged: z.boolean(),
  pacingPreset: PacingPresetSchema,
  dataFolder: path,
  watchMode: z.boolean(),
  riskNoticeVersion: z.number().int().min(0),
});

export const SessionHandleSchema = z.object({
  providerId: ProviderIdSchema,
  partition: z.string().min(1),
  visible: z.boolean(),
});

export const TileProgressSchema = z.object({
  index: z.number().int().min(0),
  state: TileStateSchema,
  outputPath: path.optional(),
  errorKind: ProviderErrorKindSchema.optional(),
  note: z.string().max(4000).optional(),
  attempts: z.number().int().min(0),
});

export const JobProgressSchema = z.object({
  jobId: id,
  state: JobStateSchema,
  pauseReason: PauseReasonSchema.optional(),
  resumeAfter: isoDate.optional(),
  error: z.string().max(4000).optional(),
  providerId: ProviderIdSchema.optional(),
  grid: GridSchema.optional(),
  completedTiles: z.number().int().min(0),
  totalTiles: z.number().int().min(0),
  tiles: z.array(TileProgressSchema),
});

export const JobSummarySchema = z.object({
  id,
  createdAt: isoDate,
  state: JobStateSchema,
  thumbnailPath: path.optional(),
  completedTiles: z.number().int().min(0),
  totalTiles: z.number().int().min(0),
});

const voidRequest = z.void();

/**
 * Runtime schemas for every IPC channel. The mapped type below ties each entry
 * to `IpcContract` so a missing or misnamed channel fails to compile.
 */
export const ipcSchemas = {
  'app.ping': {
    request: voidRequest,
    response: z.object({ version: z.string().min(1), ipcVersion: z.literal(IPC_VERSION) }),
  },
  'sessions.open': {
    request: z.object({ providerId: ProviderIdSchema, visible: z.boolean().optional() }),
    response: SessionHandleSchema,
  },
  'sessions.status': {
    request: z.object({ providerId: ProviderIdSchema }),
    response: SessionStatusSchema,
  },
  'sessions.clear': {
    request: z.object({ providerId: ProviderIdSchema }),
    response: z.object({ cleared: z.boolean() }),
  },
  'presets.list': {
    request: voidRequest,
    response: z.array(CategorySchema),
  },
  'presets.get': {
    request: z.object({ categoryId: z.string().min(1) }),
    response: CategorySchema,
  },
  'presets.suggestCategory': {
    request: z.object({ assetId: id, prompt: z.string().max(2000) }),
    response: CategorySuggestionSchema,
  },
  'intake.import': {
    request: z.object({ path }),
    response: ImageAssetSchema,
  },
  'intake.createJob': {
    request: CreateJobRequestSchema,
    response: JobSchema,
  },
  'intake.preview': {
    request: z.object({ assetId: id, maxSide: z.number().int().min(64).max(2048).optional() }),
    response: ImagePreviewSchema,
  },
  'slicer.plan': {
    request: z.object({
      assetId: id,
      grid: GridSchema,
      overlapPct,
      wrap: z.boolean().optional(),
    }),
    response: TilePlanSchema,
  },
  'jobs.costPreview': {
    request: z.object({ providerId: ProviderIdSchema, tileCount: z.number().int().min(1).max(36) }),
    response: z.object({ tiles: z.number().int().min(1), estimatedMinutes: z.number().int().min(1), quotaNote: z.string().max(1000) }),
  },
  'jobs.tileThumbnail': {
    request: z.object({ jobId: id, index: z.number().int().min(0), maxSide: z.number().int().min(32).max(1024).optional() }),
    response: ImagePreviewSchema,
  },
  'jobs.start': {
    request: z.object({ jobId: id }),
    response: z.object({ jobId: id, state: JobStateSchema }),
  },
  'jobs.pause': {
    request: z.object({ jobId: id }),
    response: JobProgressSchema,
  },
  'jobs.resume': {
    request: z.object({ jobId: id }),
    response: JobProgressSchema,
  },
  'jobs.cancel': {
    request: z.object({ jobId: id }),
    response: JobProgressSchema,
  },
  'jobs.get': {
    request: z.object({ jobId: id }),
    response: JobProgressSchema,
  },
  'jobs.listRecent': {
    request: z.object({ limit: z.number().int().min(1).max(50).optional() }),
    response: z.array(JobSummarySchema),
  },
  'stitch.run': {
    request: z.object({ jobId: id, options: StitchOptionsSchema }),
    response: StitchResultSchema,
  },
  'export.save': {
    request: ExportRequestSchema,
    response: ExportResultSchema,
  },
  'settings.get': {
    request: voidRequest,
    response: AppSettingsSchema,
  },
  'settings.set': {
    request: AppSettingsSchema.partial(),
    response: AppSettingsSchema,
  },
} satisfies Record<IpcChannel, { request: z.ZodTypeAny; response: z.ZodTypeAny }>;

export const ipcEventSchemas = {
  'jobs.progress': JobProgressSchema,
  'sessions.status': z.object({ providerId: ProviderIdSchema, status: SessionStatusSchema }),
  'jobs.log': z.object({
    jobId: id,
    level: z.enum(['info', 'warn', 'error']),
    message: z.string(),
  }),
} satisfies Record<IpcEventChannel, z.ZodTypeAny>;

/** Channel names as a runtime array, useful for wiring and exhaustive tests. */
export const IPC_CHANNELS = Object.keys(ipcSchemas) as IpcChannel[];
export const IPC_EVENT_CHANNELS = Object.keys(ipcEventSchemas) as IpcEventChannel[];

export type IpcRequest<K extends IpcChannel> = IpcContract[K]['request'];
export type IpcResponse<K extends IpcChannel> = IpcContract[K]['response'];
export type IpcEvent<K extends IpcEventChannel> = IpcEvents[K];

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseIpcRequest<K extends IpcChannel>(
  channel: K,
  payload: unknown,
): ParseResult<IpcRequest<K>> {
  const result = ipcSchemas[channel].request.safeParse(payload);
  if (result.success) {
    return { ok: true, value: result.data as IpcRequest<K> };
  }

  return { ok: false, error: formatIssues(result.error) };
}

export function parseIpcResponse<K extends IpcChannel>(
  channel: K,
  payload: unknown,
): ParseResult<IpcResponse<K>> {
  const result = ipcSchemas[channel].response.safeParse(payload);
  if (result.success) {
    return { ok: true, value: result.data as IpcResponse<K> };
  }

  return { ok: false, error: formatIssues(result.error) };
}

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${at}: ${issue.message}`;
    })
    .join('; ');
}
