import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { EnhanceRequest, EnhanceResult, ProviderCapabilities, ProviderHealth, ProviderId } from '@ie/contracts';
import sharp from 'sharp';

import { ProviderError, type ProviderAdapter } from '../ProviderAdapter';

export type FailureMode = 'ok' | 'timeout' | 'quota' | 'refusal' | 'challenge' | 'logged-out' | 'download-failed';
export type FailingMode = Exclude<FailureMode, 'ok'>;

export const FAILING_MODES: readonly FailingMode[] = ['timeout', 'quota', 'refusal', 'challenge', 'logged-out', 'download-failed'];

/** Thrown when the fake is requested outside development and test. */
export class FakeAdapterUnavailableError extends Error {
  constructor() {
    super('The fake provider adapter is only available in development and test.');
    this.name = 'FakeAdapterUnavailableError';
  }
}

function assertDevOrTest(env: NodeJS.ProcessEnv): void {
  const allowed = env.NODE_ENV === 'test' || env.NODE_ENV === 'development' || env.IE_ALLOW_FAKE === '1';
  if (!allowed) throw new FakeAdapterUnavailableError();
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FakeAdapterOptions {
  /** Where `ok` results are written. */
  outputDir: string;
  id?: ProviderId;
  /** Seeds the random failures; the same seed always gives the same sequence. */
  seed?: number;
  /** A fixed mode, or a list cycled one entry per call. When omitted, `failRate` decides. */
  modes?: FailureMode | readonly FailureMode[];
  /** Chance (0-1) that a call fails when `modes` is not given. */
  failRate?: number;
  /** Which failures `failRate` chooses among (default: all of them). */
  failureModes?: readonly FailingMode[];
  /** `ok` results are the tile resized by this factor (default 2). */
  scale?: number;
  /** Reported `elapsedMs` for `ok` results (nothing actually waits). */
  simulatedMs?: number;
  env?: NodeJS.ProcessEnv;
}

const MESSAGES: Record<FailingMode, string> = {
  timeout: 'Simulated timeout.',
  quota: 'Simulated usage limit.',
  refusal: 'Simulated refusal.',
  challenge: 'Simulated human check.',
  'logged-out': 'Simulated logged-out session.',
  'download-failed': 'Simulated failed download.',
};

/**
 * Deterministic stand-in for a real provider: no browser, no account. For `ok` it returns the tile
 * enlarged, so the pipeline downstream has real pixels to stitch. Development and test only.
 */
export class FakeAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities = {
    maxAttachments: 3,
    outputAspects: ['1:1', '2:3', '3:2'],
    approxOutputPx: 1024,
  };
  /** Number of `enhance` calls so far. */
  calls = 0;

  private readonly options: FakeAdapterOptions;
  private readonly random: () => number;

  constructor(options: FakeAdapterOptions) {
    assertDevOrTest(options.env ?? process.env);
    this.options = options;
    this.id = options.id ?? 'gpt';
    this.random = mulberry32(options.seed ?? 0);
  }

  async health(): Promise<ProviderHealth> {
    return { ok: true, missingSelectors: [] };
  }

  /** The mode the next call will use (advances the random stream when `failRate` is in play). */
  private nextMode(): FailureMode {
    const { modes, failRate = 0, failureModes = FAILING_MODES } = this.options;
    if (Array.isArray(modes)) return modes[this.calls % modes.length]!;
    if (typeof modes === 'string') return modes;
    if (failRate > 0 && this.random() < failRate) return failureModes[Math.floor(this.random() * failureModes.length)]!;
    return 'ok';
  }

  async enhance(req: EnhanceRequest): Promise<EnhanceResult> {
    if (req.attachments.length === 0) throw new RangeError('enhance() needs at least one attachment.');
    if (req.attachments.length > this.capabilities.maxAttachments) {
      throw new RangeError(`${req.attachments.length} attachments requested; at most ${this.capabilities.maxAttachments} are accepted.`);
    }

    const mode = this.nextMode();
    this.calls++;
    if (mode !== 'ok') throw new ProviderError(mode, MESSAGES[mode]);

    const tile = req.attachments.find((a) => a.role === 'tile') ?? req.attachments[0]!;
    const source = readFileSync(tile.path);
    const meta = await sharp(source).metadata();
    const scale = this.options.scale ?? 2;
    const width = Math.max(1, Math.round((meta.width ?? 1) * scale));

    const output = await sharp(source).resize({ width, kernel: 'lanczos3' }).png().toBuffer({ resolveWithObject: true });
    mkdirSync(this.options.outputDir, { recursive: true });
    const imagePath = path.join(this.options.outputDir, `fake-${String(this.calls).padStart(3, '0')}.png`);
    writeFileSync(imagePath, output.data);

    return { imagePath, width: output.info.width, height: output.info.height, elapsedMs: this.options.simulatedMs ?? 0 };
  }
}
