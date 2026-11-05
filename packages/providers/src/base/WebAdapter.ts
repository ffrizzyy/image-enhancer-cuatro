import type { EnhanceRequest, EnhanceResult, ProviderCapabilities, ProviderErrorKind, ProviderHealth, ProviderId } from '@ie/contracts';

import { ProviderError, type ProviderAdapter } from '../ProviderAdapter';
import { IDLE_SELECTOR_KEYS, type MarkerKind, type ProviderConfig, type SelectorKey } from '../config/schema';
import type { PageDriver } from './PageDriver';
import type { ImageSaver } from './saveImage';

export interface WebAdapterDeps {
  driver: PageDriver;
  config: ProviderConfig;
  saveImage: ImageSaver;
  /** Injectable so tests need no real waiting and pauses are deterministic. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** Length of one generation-wait slice between state checks. */
  pollMs?: number;
}

/**
 * Failure markers in priority order. A page that matches several (a captcha on a logged-out page)
 * still maps to exactly one kind: the one the user has to deal with first.
 */
const MARKER_PRIORITY: ReadonlyArray<readonly [MarkerKind, ProviderErrorKind]> = [
  ['challenge', 'challenge'],
  ['loggedOut', 'logged-out'],
  ['quota', 'quota'],
  ['refusal', 'refusal'],
];

const MESSAGES: Record<ProviderErrorKind, string> = {
  challenge: 'The provider is asking for a human check. Solve it in the provider window.',
  'logged-out': 'The provider session is logged out. Log in again in the provider window.',
  quota: 'The provider reports a usage limit.',
  refusal: 'The provider refused this request.',
  timeout: 'Timed out waiting for the provider.',
  'ui-changed': 'The provider page no longer matches the configured selectors.',
  'download-failed': 'The enhanced image could not be downloaded.',
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Pause between re-checks when a wait returned but its condition is not met yet. */
const POLL_PAUSE_MS = 250;

/**
 * The shared chat-UI flow: new chat, attach, paste the prompt, submit, wait for the image, download
 * it. Everything provider-specific lives in `config`; nothing here hard-codes a selector. Each
 * adapter adds only its id, capabilities and (later) any page quirks.
 */
export class WebAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;

  private readonly driver: PageDriver;
  private readonly config: ProviderConfig;
  private readonly saveImage: ImageSaver;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly pollMs: number;

  constructor(deps: WebAdapterDeps) {
    this.driver = deps.driver;
    this.config = deps.config;
    this.saveImage = deps.saveImage;
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.pollMs = deps.pollMs ?? 1000;
    this.id = deps.config.id;
    this.capabilities = structuredClone(deps.config.capabilities);
  }

  async health(): Promise<ProviderHealth> {
    try {
      await this.driver.goto(this.config.urls.newChat, this.config.timeouts.navigationMs);
      const blocked = await this.classifyPage();
      const missingSelectors: string[] = [];
      for (const key of IDLE_SELECTOR_KEYS) {
        if ((await this.firstMatch(key)) === null) missingSelectors.push(key);
      }
      return { ok: blocked === null && missingSelectors.length === 0, missingSelectors };
    } catch (error) {
      throw this.toProviderError(error);
    }
  }

  async enhance(req: EnhanceRequest): Promise<EnhanceResult> {
    this.checkRequest(req);
    const started = this.now();
    const deadline = started + req.timeoutMs;

    try {
      await this.openNewChat(deadline);
      await this.attach(req, deadline);
      await this.enterPrompt(req.prompt);
      await this.submit();
      await this.waitForImage(deadline);
      const image = await this.download(deadline);
      return { ...image, elapsedMs: this.now() - started };
    } catch (error) {
      throw this.toProviderError(error);
    }
  }

  private checkRequest(req: EnhanceRequest): void {
    if (req.attachments.length === 0) throw new RangeError('enhance() needs at least one attachment.');
    if (req.attachments.length > this.capabilities.maxAttachments) {
      throw new RangeError(
        `${req.attachments.length} attachments requested; ${this.id} accepts at most ${this.capabilities.maxAttachments}.`,
      );
    }
    if (!Number.isFinite(req.timeoutMs) || req.timeoutMs <= 0) throw new RangeError('timeoutMs must be positive.');
  }

  /** Time left in the request budget, or a timeout error when it is spent. */
  private remaining(deadline: number, what: string): number {
    const left = deadline - this.now();
    if (left <= 0) throw new ProviderError('timeout', `${MESSAGES.timeout} (${what})`);
    return left;
  }

  /** A short, randomised human-like pause. */
  private pause(): Promise<void> {
    return this.sleep(150 + Math.floor(this.random() * 450));
  }

  private async openNewChat(deadline: number): Promise<void> {
    const timeout = Math.min(this.config.timeouts.navigationMs, this.remaining(deadline, 'opening a new chat'));
    await this.driver.goto(this.config.urls.newChat, timeout);
    await this.throwIfBlocked();
  }

  private async attach(req: EnhanceRequest, deadline: number): Promise<void> {
    const input = await this.requireMatch('attachInput');
    await this.driver.setInputFiles(
      input,
      req.attachments.map((a) => a.path),
    );

    // Verify every thumbnail appeared before going on; a silent attach failure would send an empty prompt.
    const thumbs = this.config.selectors.attachmentThumb.join(', ');
    const waitMs = Math.min(this.config.timeouts.attachMs, this.remaining(deadline, 'attaching files'));
    const stop = this.now() + waitMs;
    while ((await this.driver.count(thumbs)) < req.attachments.length) {
      if (this.now() >= stop) {
        throw new ProviderError(
          'ui-changed',
          `Only ${await this.driver.count(thumbs)} of ${req.attachments.length} attachments appeared.`,
          { selector: 'attachmentThumb' },
        );
      }
      await this.throwIfBlocked();
      await this.driver.waitFor(thumbs, Math.min(this.pollMs, Math.max(1, stop - this.now())));
      // waitFor returns as soon as one thumbnail exists; give the rest a moment instead of spinning.
      if ((await this.driver.count(thumbs)) < req.attachments.length) await this.sleep(POLL_PAUSE_MS);
    }
  }

  private async enterPrompt(prompt: string): Promise<void> {
    const input = await this.requireMatch('promptInput');
    await this.pause();
    await this.driver.insertText(input, prompt);
    await this.pause();
  }

  private async submit(): Promise<void> {
    await this.driver.click(await this.requireMatch('submitButton'));
  }

  private async waitForImage(deadline: number): Promise<void> {
    const result = this.config.selectors.resultImage.join(', ');
    const spinner = this.config.selectors.generatingIndicator.join(', ');
    const stop = Math.min(deadline, this.now() + this.config.timeouts.generationMs);

    for (;;) {
      await this.throwIfBlocked();
      const left = stop - this.now();
      if (left <= 0) throw new ProviderError('timeout', `${MESSAGES.timeout} (waiting for the image)`);

      const appeared = await this.driver.waitFor(result, Math.min(this.pollMs, left));
      // The image can show up before generation finishes (progressive previews); wait for the spinner to go.
      if (appeared) {
        if ((await this.driver.count(spinner)) === 0) return;
        await this.sleep(Math.min(POLL_PAUSE_MS, Math.max(1, stop - this.now())));
      }
    }
  }

  private async download(deadline: number) {
    const selector = await this.requireMatch('resultImage');
    const timeout = Math.min(this.config.timeouts.downloadMs, this.remaining(deadline, 'downloading'));

    let bytes: Uint8Array;
    try {
      bytes = await this.driver.fetchImage(selector, timeout);
    } catch (error) {
      throw new ProviderError('download-failed', MESSAGES['download-failed'], { cause: error });
    }

    let saved;
    try {
      saved = await this.saveImage(bytes);
    } catch (error) {
      throw new ProviderError('download-failed', 'The downloaded file was not a usable image.', { cause: error });
    }

    if (Math.max(saved.width, saved.height) < this.config.minOutputPx) {
      throw new ProviderError(
        'download-failed',
        `Only a ${saved.width}x${saved.height} preview was available (at least ${this.config.minOutputPx}px is required).`,
      );
    }
    return saved;
  }

  /** The first configured fallback for `key` that currently matches, or null. */
  private async firstMatch(key: SelectorKey): Promise<string | null> {
    for (const selector of this.config.selectors[key]) {
      if ((await this.driver.count(selector)) > 0) return selector;
    }
    return null;
  }

  private async requireMatch(key: SelectorKey): Promise<string> {
    const found = await this.firstMatch(key);
    if (found === null) {
      throw new ProviderError('ui-changed', `${MESSAGES['ui-changed']} Missing selector: ${key} (tried ${this.config.selectors[key].join(' | ')}).`, {
        selector: key,
      });
    }
    return found;
  }

  /** The one failure kind the page currently shows, or null. */
  private async classifyPage(): Promise<ProviderErrorKind | null> {
    const text = (await this.driver.pageText()).toLowerCase();
    for (const [markerKind, errorKind] of MARKER_PRIORITY) {
      const marker = this.config.markers[markerKind];
      if (marker.text.some((phrase) => text.includes(phrase.toLowerCase()))) return errorKind;
      for (const selector of marker.selectors) {
        if ((await this.driver.count(selector)) > 0) return errorKind;
      }
    }
    return null;
  }

  private async throwIfBlocked(): Promise<void> {
    const kind = await this.classifyPage();
    if (kind !== null) throw new ProviderError(kind, MESSAGES[kind]);
  }

  /** Adapters never leak a plain Error: anything unexpected is reported as a page problem. */
  private toProviderError(error: unknown): Error {
    if (error instanceof ProviderError || error instanceof RangeError) return error;
    const detail = error instanceof Error ? error.message : String(error);
    return new ProviderError('ui-changed', `Unexpected error while driving the page: ${detail}`, { cause: error });
  }
}
