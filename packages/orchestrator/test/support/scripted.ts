import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { EnhanceAttachment, EnhanceRequest, EnhanceResult, Job, ProviderCapabilities, ProviderErrorKind, ProviderHealth, TilePlan } from '@ie/contracts';
import { ProviderError, type ProviderAdapter } from '@ie/providers';
import { planTiles } from '@ie/slicer';
import sharp from 'sharp';

import { openStore, type Store } from '../../src/store.ts';
import { picture, writePng } from './images.ts';

export type Step =
  | { do: 'ok' }
  /** A picture unrelated to the tile: the quality gate must reject it. */
  | { do: 'bad' }
  | { do: 'error'; kind: ProviderErrorKind; message?: string; selector?: string }
  /** An unexpected failure, as if the process died in the middle of the call. */
  | { do: 'crash' };

export interface Call {
  attachments: EnhanceAttachment[];
  prompt: string;
  /** Which tile the call was for, found from the tile file name. */
  tile: number;
  at: number;
}

export interface ScriptedOptions {
  outputDir: string;
  /** What each call does, by call number from 0; calls past the end succeed. */
  script?: readonly Step[] | ((call: number, req: EnhanceRequest, tile: number) => Step);
  maxAttachments?: number;
  health?: ProviderHealth | Error;
  /** How long each call takes, to make concurrent calls overlap. */
  delayMs?: number;
}

/** A provider whose every answer is decided by the test. */
export class ScriptedAdapter implements ProviderAdapter {
  readonly id = 'gemini' as const;
  readonly capabilities: ProviderCapabilities;
  readonly calls: Call[] = [];
  inFlight = 0;
  maxInFlight = 0;
  private count = 0;

  constructor(private readonly options: ScriptedOptions) {
    this.capabilities = { maxAttachments: options.maxAttachments ?? 3, outputAspects: ['1:1', '2:3', '3:2'], approxOutputPx: 1024 };
  }

  async health(): Promise<ProviderHealth> {
    const health = this.options.health ?? { ok: true, missingSelectors: [] };
    if (health instanceof Error) throw health;
    return health;
  }

  async enhance(req: EnhanceRequest): Promise<EnhanceResult> {
    const tilePath = req.attachments.find((a) => a.role === 'tile')!.path;
    const tile = Number(/tile-(\d+)\.png$/.exec(tilePath)![1]);
    const number = this.count++;
    this.calls.push({ attachments: req.attachments, prompt: req.prompt, tile, at: number });

    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.options.delayMs) await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
      const { script } = this.options;
      const step: Step = typeof script === 'function' ? script(number, req, tile) : (script?.[number] ?? { do: 'ok' });

      if (step.do === 'error') throw new ProviderError(step.kind, step.message ?? `Scripted ${step.kind}.`, step.selector ? { selector: step.selector } : {});
      if (step.do === 'crash') throw new Error('The process died.');

      mkdirSync(this.options.outputDir, { recursive: true });
      const out = path.join(this.options.outputDir, `provider-${String(number).padStart(3, '0')}.png`);
      const meta = await sharp(readFileSync(tilePath)).metadata();
      const width = (meta.width ?? 1) * 2;
      const height = (meta.height ?? 1) * 2;
      if (step.do === 'bad') await writePng(picture(12345, width, height), out);
      else writeFileSync(out, await sharp(readFileSync(tilePath)).resize(width, height, { kernel: 'lanczos3' }).png().toBuffer());
      return { imagePath: out, width, height, elapsedMs: 100 };
    } finally {
      this.inFlight--;
    }
  }
}

export interface JobSetup {
  store: Store;
  job: Job;
  plan: TilePlan;
  dir: string;
  workDir: string;
}

/** A job over a 1-row picture `cols` tiles wide, stored in a database file in `dir`. */
export async function setupJob(dir: string, options: { cols?: number; rows?: number; mode?: 'chained' | 'independent'; id?: string; categoryId?: string; wrap?: boolean } = {}): Promise<JobSetup> {
  const cols = options.cols ?? 4;
  const rows = options.rows ?? 1;
  const id = options.id ?? 'J1';
  mkdirSync(dir, { recursive: true });
  const width = cols * 200;
  const height = rows * 300;
  const sourcePath = path.join(dir, `${id}-source.png`);
  await writePng(picture(7, width, height), sourcePath);

  const plan = planTiles({ width, height, rows, cols, overlapPct: 15, ...(options.wrap ? { wrap: true } : {}) });
  const job: Job = {
    id,
    createdAt: '2026-11-05T10:00:00.000Z',
    source: { path: sourcePath, width, height, sha256: 'a'.repeat(64) },
    prompt: 'Enhance this tile.',
    promptSource: 'user',
    categoryId: options.categoryId ?? 'env-realistic',
    categorySource: 'user',
    grid: { rows, cols, overlapPct: 15 },
    providerId: 'gemini',
  };
  const store = openStore(path.join(dir, 'jobs.sqlite'));
  store.createJob({ job, plan, mode: options.mode ?? 'chained' });
  return { store, job, plan, dir, workDir: path.join(dir, `${id}-work`) };
}
