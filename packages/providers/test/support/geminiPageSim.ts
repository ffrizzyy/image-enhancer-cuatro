import { readFileSync } from 'node:fs';
import path from 'node:path';

import { JsdomContents } from './jsdomContents';

export type GeminiScenario = 'ok' | 'timeout' | 'quota' | 'refusal' | 'challenge' | 'logged-out' | 'download-failed';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'gemini');
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');

/** How long the simulated generation runs before it shows its outcome. */
const GENERATION_MS = 30;

/**
 * A stand-in for the Gemini page, built from the fixtures in `test/fixtures/gemini`. The composer, the upload
 * menu, the file input, the attachment chip and the Send button follow the structure captured from the live
 * page. What happens after Send (generating indicator, result image, quota/refusal/challenge text) is an
 * UNVERIFIED guess until the live smoke has run.
 */
export class GeminiPageSim extends JsdomContents {
  private attachedCount = 0;
  private sent = false;

  constructor(
    private readonly scenario: GeminiScenario,
    private readonly png: Uint8Array,
  ) {
    super(fixture(scenario === 'logged-out' ? 'logged-out.html' : 'idle.html'));
    const { window } = this.dom;
    const document = window.document;

    (window as unknown as { fetch: unknown }).fetch = async () =>
      scenario === 'download-failed'
        ? { ok: false, status: 404, blob: async () => new window.Blob([]) }
        : { ok: true, status: 200, blob: async () => new window.Blob([this.png as unknown as BlobPart]) };

    document.addEventListener('click', (event) => {
      const target = event.target as Element | null;
      if (target?.closest("button[aria-label='Upload & tools']") && !document.querySelector('.cdk-overlay-pane')) {
        this.append(fixture('menu.html'));
      } else if (target?.closest("button[aria-label='Send message']")) {
        this.send();
      }
    });
  }

  private append(html: string): void {
    this.dom.window.document.body.insertAdjacentHTML('beforeend', html);
  }

  protected override didSetFiles(files: string[]): void {
    for (let i = 0; i < files.length; i++) {
      this.attachedCount++;
      this.append(fixture('attached.html'));
    }
  }

  protected override didInsertText(text: string): void {
    const document = this.dom.window.document;
    if (text.trim() && !document.querySelector('.send-button')) this.append(fixture('send.html'));
  }

  private send(): void {
    if (this.sent || this.attachedCount === 0) return;
    this.sent = true;
    this.append(fixture('generating.html'));
    if (this.scenario === 'timeout') return;

    setTimeout(() => {
      const document = this.dom.window.document;
      document.querySelector('button.stop')?.remove();
      const outcome: Record<GeminiScenario, string> = {
        ok: 'done.html',
        'download-failed': 'done.html',
        quota: 'quota.html',
        refusal: 'refusal.html',
        challenge: 'challenge.html',
        'logged-out': 'logged-out.html',
        timeout: 'generating.html',
      };
      this.append(fixture(outcome[this.scenario]));
    }, GENERATION_MS);
  }
}
