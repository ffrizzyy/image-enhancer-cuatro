import type { EnhanceRequest, EnhanceResult, ProviderCapabilities, ProviderErrorKind, ProviderHealth, ProviderId } from '@ie/contracts';

import { ProviderError, type ProviderAdapter } from '../ProviderAdapter';
import { IDLE_SELECTOR_KEYS, type MarkerKind, type ProviderConfig, type SelectorKey } from '../config/schema';
import { PageTimeoutError, type PageDriver } from './PageDriver';
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
  /**
   * Keep using one provider chat for every call instead of opening a new chat each time. The app turns this on so a
   * whole picture is enhanced in one conversation; direct adapter use and the contract tests keep the fresh-chat
   * behaviour by default. Calls on a reused chat are run one at a time.
   */
  reuseChat?: boolean;
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
 * The shared chat-UI flow: open a chat (or reuse one), attach, paste the prompt, submit, wait for the image,
 * download it. Everything provider-specific lives in `config`; nothing here hard-codes a selector. Each
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
  private readonly reuseChat: boolean;
  /** Whether the shared chat is already open. Only meaningful with `reuseChat`. */
  private chatOpen = false;
  /** Serializes calls on a reused chat: a conversation can only take one request at a time. */
  private queue: Promise<void> = Promise.resolve();

  constructor(deps: WebAdapterDeps) {
    this.driver = deps.driver;
    this.config = deps.config;
    this.saveImage = deps.saveImage;
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.pollMs = deps.pollMs ?? 1000;
    this.reuseChat = deps.reuseChat ?? false;
    this.id = deps.config.id;
    this.capabilities = structuredClone(deps.config.capabilities);
  }

  async health(): Promise<ProviderHealth> {
    try {
      await this.driver.goto(this.config.urls.newChat, this.config.timeouts.navigationMs);
      // A single-page app renders its composer after the load event; without this wait a healthy page is reported as
      // changed (GPT and Grok both render late, especially behind a login redirect).
      await this.waitForComposer(this.now() + this.config.timeouts.navigationMs);
      const blocked = await this.classifyPage();
      const missingSelectors: string[] = [];
      for (const key of this.config.healthKeys ?? IDLE_SELECTOR_KEYS) {
        if ((await this.firstMatch(key)) === null) missingSelectors.push(key);
      }
      return { ok: blocked === null && missingSelectors.length === 0, missingSelectors };
    } catch (error) {
      throw this.toProviderError(error);
    }
  }

  async enhance(req: EnhanceRequest): Promise<EnhanceResult> {
    this.checkRequest(req);
    if (!this.reuseChat) return this.enhanceOnce(req);

    // One chat, one request at a time. The runner may ask for several tiles at once; without this queue their
    // messages would interleave in the same conversation.
    const run = this.queue.then(() => this.enhanceOnce(req));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async enhanceOnce(req: EnhanceRequest): Promise<EnhanceResult> {
    const started = this.now();
    const deadline = started + req.timeoutMs;

    try {
      if (this.reuseChat && this.chatOpen) {
        // The chat is already open from the previous tile: wait for its composer and use it as it is.
        await this.waitForComposer(deadline);
        await this.throwIfBlocked();
      } else {
        await this.openNewChat(deadline);
        this.chatOpen = true;
      }

      // A reused chat already shows the earlier results and may still show the earlier attachments. Count them first,
      // so the waits below look for something new instead of accepting the previous tile's picture.
      const baseline = {
        images: await this.driver.count(this.config.selectors.resultImage.join(', ')),
        thumbnails: await this.driver.count(this.config.selectors.attachmentThumb.join(', ')),
      };

      await this.attach(req, deadline, baseline.thumbnails);
      await this.enterPrompt(req.prompt);
      await this.submit();
      await this.waitForImage(deadline, baseline.images);
      const image = await this.download(deadline);
      return { ...image, elapsedMs: this.now() - started };
    } catch (error) {
      // Leave the conversation in a clean state for the next try: a failed generation may still be running or the
      // page may have moved on, so the next call starts a fresh chat rather than risking the wrong picture.
      this.chatOpen = false;
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
    await this.waitForComposer(deadline);
    await this.throwIfBlocked();
  }

  /**
   * A single-page app renders its composer after the load event. Wait for it (or for a blocking state such
   * as a login page) before looking up selectors, so a slow render is not mistaken for a changed UI.
   */
  private async waitForComposer(deadline: number): Promise<void> {
    const composer = this.config.selectors.promptInput.join(', ');
    const stop = Math.min(deadline, this.now() + this.config.timeouts.navigationMs);
    while (this.now() < stop) {
      if ((await this.driver.count(composer)) > 0 || (await this.classifyPage()) !== null) return;
      await this.driver.waitFor(composer, Math.min(this.pollMs, Math.max(1, stop - this.now())));
      if ((await this.driver.count(composer)) === 0) await this.sleep(POLL_PAUSE_MS);
    }
  }

  private async attach(req: EnhanceRequest, deadline: number, baselineThumbnails: number): Promise<void> {
    // Some chat UIs only create the file input after a menu is opened.
    for (const [index, step] of (this.config.beforeAttach ?? []).entries()) {
      const union = step.join(', ');
      const wait = Math.min(this.config.timeouts.attachMs, this.remaining(deadline, 'opening the attach menu'));
      await this.driver.waitFor(union, wait);
      const target = await this.firstMatchOf(step);
      if (target === null) {
        throw new ProviderError('ui-changed', `${MESSAGES['ui-changed']} Missing selector: beforeAttach[${index}] (tried ${step.join(' | ')}).`, {
          selector: `beforeAttach[${index}]`,
        });
      }
      await this.driver.click(target);
      await this.pause();
    }
    await this.driver.waitFor(
      this.config.selectors.attachInput.join(', '),
      Math.min(this.config.timeouts.attachMs, this.remaining(deadline, 'waiting for the attach control')),
    );
    const input = await this.requireMatch('attachInput');

    // Verify every thumbnail appeared before going on; a silent attach failure would send an empty prompt. A reused
    // chat may still show the previous message's attachments, so only the ones beyond that baseline count.
    const thumbs = this.config.selectors.attachmentThumb.join(', ');
    const paths = req.attachments.map((a) => a.path);
    if (this.config.attachMode === 'one-by-one') {
      // A single-file input drops every file after the first from one batch, so add them one at a time and let the
      // page register each preview before the next. This is also how a person attaches several pictures.
      for (const [index, filePath] of paths.entries()) {
        await this.driver.setInputFiles(input, [filePath]);
        await this.waitForAttachments(thumbs, baselineThumbnails, index + 1, paths.length, deadline);
        if (index < paths.length - 1) await this.pause();
      }
    } else {
      await this.driver.setInputFiles(input, paths);
      await this.waitForAttachments(thumbs, baselineThumbnails, paths.length, paths.length, deadline);
    }
  }

  /** Waits until `added` new attachment previews exist beyond `baseline`, or fails naming the missing selector. */
  private async waitForAttachments(
    thumbs: string,
    baseline: number,
    added: number,
    total: number,
    deadline: number,
  ): Promise<void> {
    const expected = baseline + added;
    const waitMs = Math.min(this.config.timeouts.attachMs, this.remaining(deadline, 'attaching files'));
    const stop = this.now() + waitMs;
    while ((await this.driver.count(thumbs)) < expected) {
      if (this.now() >= stop) {
        const shown = Math.max(0, (await this.driver.count(thumbs)) - baseline);
        throw new ProviderError(
          'ui-changed',
          `Only ${shown} of ${total} attachments appeared.`,
          { selector: 'attachmentThumb' },
        );
      }
      await this.throwIfBlocked();
      await this.driver.waitFor(thumbs, Math.min(this.pollMs, Math.max(1, stop - this.now())));
      // waitFor returns as soon as one thumbnail exists; give the rest a moment instead of spinning.
      if ((await this.driver.count(thumbs)) < expected) await this.sleep(POLL_PAUSE_MS);
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

  private async waitForImage(deadline: number, baselineImages: number): Promise<void> {
    const result = this.config.selectors.resultImage.join(', ');
    const spinner = this.config.selectors.generatingIndicator.join(', ');
    const stop = Math.min(deadline, this.now() + this.config.timeouts.generationMs);

    for (;;) {
      await this.throwIfBlocked();
      const left = stop - this.now();
      if (left <= 0) throw new ProviderError('timeout', `${MESSAGES.timeout} (waiting for the image)`);

      const appeared = await this.driver.waitFor(result, Math.min(this.pollMs, left));
      // The image can show up before generation finishes (progressive previews); wait for the spinner to go. On a
      // reused chat an earlier picture is always present, so only a count beyond the baseline is the new one. With no
      // earlier picture (a new chat), the image merely being present is enough.
      if (appeared) {
        const images = await this.driver.count(result);
        const isNew = baselineImages === 0 || images > baselineImages;
        if (isNew && (await this.driver.count(spinner)) === 0) return;
        await this.sleep(Math.min(this.pollMs, Math.max(1, stop - this.now())));
      }
    }
  }

  private async download(deadline: number) {
    const selector = await this.requireMatch('resultImage');
    const timeout = Math.min(this.config.timeouts.downloadMs, this.remaining(deadline, 'downloading'));

    let bytes: Uint8Array;
    try {
      bytes = await this.driver.fetchImage(selector, timeout, {
        urlRewrites: this.config.download?.urlRewrites ?? [],
      });
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

  /** The first of these fallbacks that currently matches, or null. */
  private async firstMatchOf(selectors: readonly string[]): Promise<string | null> {
    for (const selector of selectors) {
      if ((await this.driver.count(selector)) > 0) return selector;
    }
    return null;
  }

  /** The first configured fallback for `key` that currently matches, or null. */
  private firstMatch(key: SelectorKey): Promise<string | null> {
    return this.firstMatchOf(this.config.selectors[key]);
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
    if (error instanceof PageTimeoutError) return new ProviderError('timeout', `${MESSAGES.timeout} (${error.message})`, { cause: error });
    const detail = error instanceof Error ? error.message : String(error);
    return new ProviderError('ui-changed', `Unexpected error while driving the page: ${detail}`, { cause: error });
  }
}
