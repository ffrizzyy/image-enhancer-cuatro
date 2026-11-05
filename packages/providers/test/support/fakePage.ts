import type { PageDriver } from '../../src';

/** A controllable clock; `FakePage` advances it whenever a wait runs out, so no test really waits. */
export class FakeClock {
  t = 0;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export type PageScenario =
  | 'ok'
  /** The image never appears. */
  | 'never'
  | 'quota'
  | 'refusal'
  | 'challenge'
  | 'logged-out'
  | 'download-failed'
  /** The download works but returns a thumbnail-sized image. */
  | 'preview-only';

export interface FakePageOptions {
  scenario: PageScenario;
  clock: FakeClock;
  /** The original-resolution image served by `fetchImage`. */
  image: Uint8Array;
  /** A small image served for `preview-only`. */
  preview?: Uint8Array;
  /** Polls before the result image appears in the `ok` scenario. */
  resultAfterPolls?: number;
  /** Selectors to leave out of the page (to simulate a UI change). */
  missing?: readonly string[];
  /** Number of thumbnails to show after attaching (defaults to the number of files). */
  thumbnails?: number;
  /** Where a blocking state shows up: on opening the chat, or while generating. */
  blockAt?: 'newChat' | 'generating';
  /** Extra elements present on the idle page (e.g. a renamed prompt box). */
  extra?: readonly string[];
  /** The file input only appears after the page's menu button (`button.menu`) is clicked. */
  attachBehindMenu?: boolean;
}

const IDLE = ['#prompt', 'input[type=file]', 'button.send'];

/** In-memory chat page: a bag of selector counts plus visible text, mutated by the actions it receives. */
export class FakePage implements PageDriver {
  readonly log: string[] = [];
  /** Every selector string any method was called with. */
  readonly seen = new Set<string>();
  private dom = new Map<string, number>();
  private text = '';
  private polls = 0;
  private opened = 0;

  constructor(private readonly o: FakePageOptions) {}

  get newChats(): number {
    return this.opened;
  }

  private show(...selectors: string[]): void {
    for (const s of selectors) if (!this.o.missing?.includes(s)) this.dom.set(s, (this.dom.get(s) ?? 0) + 1);
  }

  private applyBlock(): void {
    switch (this.o.scenario) {
      case 'quota':
        this.text = 'You have hit the usage limit for today.';
        break;
      case 'refusal':
        this.text = "Sorry, I can't help with that request.";
        break;
      case 'challenge':
        this.show('iframe.captcha');
        this.text = 'Please verify you are human.';
        break;
      case 'logged-out':
        this.show('.login-btn');
        this.text = 'Log in to continue';
        break;
      default:
    }
  }

  private get blocks(): boolean {
    return ['quota', 'refusal', 'challenge', 'logged-out'].includes(this.o.scenario);
  }

  async goto(url: string): Promise<void> {
    this.log.push(`goto:${url}`);
    this.opened++;
    this.dom = new Map();
    this.text = 'Ask anything';
    this.polls = 0;
    if (this.o.attachBehindMenu) this.show(...IDLE.filter((s) => s !== 'input[type=file]'), 'button.menu', ...(this.o.extra ?? []));
    else this.show(...IDLE, ...(this.o.extra ?? []));
    if (this.blocks && (this.o.blockAt ?? (this.o.scenario === 'logged-out' ? 'newChat' : 'generating')) === 'newChat') {
      this.applyBlock();
    }
  }

  async count(selector: string): Promise<number> {
    this.seen.add(selector);
    return selector.split(',').reduce((sum, part) => sum + (this.dom.get(part.trim()) ?? 0), 0);
  }

  async waitFor(selector: string, timeoutMs: number): Promise<boolean> {
    this.log.push(`waitFor:${selector}`);
    this.seen.add(selector);
    if (selector.includes('img.result')) {
      this.polls++;
      if (this.blocks && this.o.blockAt !== 'newChat' && this.polls >= 1) this.applyBlock();
      if (this.o.scenario === 'never' || this.blocks) {
        this.o.clock.advance(timeoutMs);
        return false;
      }
      if (this.polls >= (this.o.resultAfterPolls ?? 1)) {
        this.dom.delete('.spinner');
        this.show('img.result');
        return true;
      }
      this.o.clock.advance(timeoutMs);
      return false;
    }
    if ((await this.count(selector)) > 0) return true;
    this.o.clock.advance(timeoutMs);
    return false;
  }

  async setInputFiles(selector: string, paths: readonly string[]): Promise<void> {
    this.log.push(`setFiles:${selector}:${paths.join('|')}`);
    this.seen.add(selector);
    this.show('.thumb');
    this.dom.set('.thumb', this.o.thumbnails ?? paths.length);
  }

  async insertText(selector: string, text: string): Promise<void> {
    this.log.push(`insert:${selector}:${text}`);
    this.seen.add(selector);
  }

  async click(selector: string): Promise<void> {
    this.log.push(`click:${selector}`);
    this.seen.add(selector);
    if (selector === 'button.menu') {
      this.show('input[type=file]');
      return;
    }
    this.show('.spinner');
  }

  async pageText(): Promise<string> {
    return this.text;
  }

  async fetchImage(selector: string): Promise<Uint8Array> {
    this.log.push(`fetch:${selector}`);
    this.seen.add(selector);
    if (this.o.scenario === 'download-failed') throw new Error('network error: 403');
    if (this.o.scenario === 'preview-only') return this.o.preview ?? this.o.image;
    return this.o.image;
  }
}
