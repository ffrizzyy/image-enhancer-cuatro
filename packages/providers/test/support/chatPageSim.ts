import { JsdomContents } from './jsdomContents';

export type ChatScenario = 'ok' | 'timeout' | 'quota' | 'refusal' | 'challenge' | 'logged-out' | 'download-failed';

/** The page structure a provider config's selectors point at, one HTML snippet per state. */
export interface ChatPageSpec {
  idle: string;
  loggedOut: string;
  attached: string;
  send: string;
  /** Tells the page the submit button's selector, so a click on it sends. */
  sendSelector: string;
  generating: string;
  stopSelector: string;
  done: string;
  quota: string;
  refusal: string;
  challenge: string;
}

const GENERATION_MS = 30;

/**
 * A stand-in for a chat page whose structure is derived from a provider config (not captured from the live page).
 * It proves the adapter and driver follow the config end to end; it does not prove the live site looks like this.
 */
export class ChatPageSim extends JsdomContents {
  private attachedCount = 0;
  private sent = false;

  constructor(
    private readonly spec: ChatPageSpec,
    private readonly scenario: ChatScenario,
    private readonly png: Uint8Array,
  ) {
    super(scenario === 'logged-out' ? spec.loggedOut : spec.idle);
    const { window } = this.dom;
    (window as unknown as { fetch: unknown }).fetch = async () =>
      scenario === 'download-failed'
        ? { ok: false, status: 404, blob: async () => new window.Blob([]) }
        : { ok: true, status: 200, blob: async () => new window.Blob([this.png as unknown as BlobPart]) };
    window.document.addEventListener('click', (event) => {
      if ((event.target as Element | null)?.closest(spec.sendSelector)) this.send();
    });
  }

  private append(html: string): void {
    this.dom.window.document.body.insertAdjacentHTML('beforeend', html);
  }

  protected override didSetFiles(files: string[]): void {
    // The live ChatGPT and Grok composers use a single-file input: setting several files at once registers only
    // the first. Model that, so a batch attach fails here exactly as it does on the real page.
    const input = this.dom.window.document.querySelector('input[type=file]');
    const accepted = input?.hasAttribute('multiple') ? files : files.slice(0, 1);
    for (let i = 0; i < accepted.length; i++) {
      this.attachedCount++;
      this.append(this.spec.attached);
    }
  }

  protected override didInsertText(text: string): void {
    if (text.trim() && !this.dom.window.document.querySelector(this.spec.sendSelector)) this.append(this.spec.send);
  }

  private send(): void {
    if (this.sent || this.attachedCount === 0) return;
    this.sent = true;
    // Sending takes the draft out of the composer, which the adapter watches to confirm the message left.
    const composer = this.dom.window.document.querySelector('[contenteditable="true"]');
    if (composer) composer.textContent = '';
    this.append(this.spec.generating);
    if (this.scenario === 'timeout') return;
    setTimeout(() => {
      this.dom.window.document.querySelector(this.spec.stopSelector)?.remove();
      const outcome: Record<ChatScenario, string> = {
        ok: this.spec.done,
        'download-failed': this.spec.done,
        quota: this.spec.quota,
        refusal: this.spec.refusal,
        challenge: this.spec.challenge,
        'logged-out': this.spec.loggedOut,
        timeout: this.spec.generating,
      };
      this.append(outcome[this.scenario]);
    }, GENERATION_MS);
  }
}

const page = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;

/** GPT: structure from config/gpt.json (the first four selectors were verified live; the outcome states were not). */
export const GPT_SPEC: ChatPageSpec = {
  idle: page(`<form><div class="ProseMirror" contenteditable="true" id="prompt-textarea"><p><br></p></div><input type="file" accept="image/*"></form>`),
  loggedOut: page(`<a href="/auth/login" data-testid="login-button">Log in</a><p>Log in or sign up</p>`),
  attached: `<div class="composer-attachment-surface"><img src="blob:https://chatgpt.example/a"></div>`,
  send: `<button type="submit" aria-label="Send" data-testid="send-button"></button>`,
  sendSelector: "button[aria-label='Send']",
  generating: `<button aria-label="Stop streaming" data-testid="stop-button"></button>`,
  stopSelector: "button[data-testid='stop-button']",
  done: `<article><img alt="Generated image: enhanced tile" src="https://chatgpt.example/backend-api/estuary/content?id=1"></article>`,
  quota: `<article><p>You've reached your limit. Come back later.</p></article>`,
  refusal: `<article><p>I can't help with that request.</p></article>`,
  challenge: `<div><iframe src="https://challenges.cloudflare.com/x"></iframe><p>Verify you are human</p></div>`,
};

/** Grok: structure from config/grok.json (input, attach, submit and the quota text were verified live; the rest was not). */
export const GROK_SPEC: ChatPageSpec = {
  idle: page(`<form><div class="tiptap ProseMirror" contenteditable="true"><p><br></p></div><input type="file" name="files"></form>`),
  loggedOut: page(`<a href="/sign-in">Sign in</a>`),
  attached: `<div role="list" aria-label="Conversation attachments"><div role="listitem"></div></div>`,
  send: `<button type="submit" data-testid="chat-submit" aria-label="Submit"></button>`,
  sendSelector: "button[data-testid='chat-submit']",
  generating: `<button aria-label="Stop model response" data-testid="stop-button"></button>`,
  stopSelector: "button[data-testid='stop-button']",
  done: `<div class="message-bubble"><img alt="Generated image" src="https://assets.grok.com/users/out.png"></div>`,
  quota: `<div class="message-bubble"><p>You've used your image generations. Please try again later.</p></div>`,
  refusal: `<div class="message-bubble"><p>I can't help with that.</p></div>`,
  challenge: `<div id="cf-challenge"><p>Just a moment</p></div>`,
};
