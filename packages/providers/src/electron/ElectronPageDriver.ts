import { PageTimeoutError, type FetchImageOptions, type PageDriver } from '../base/PageDriver';

/** The slice of Electron's `Debugger` the driver uses. */
export interface DriverDebugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): unknown;
  removeListener(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): unknown;
}

/** The slice of Electron's `WebContents` the driver uses. Electron's own type satisfies it. */
export interface DriverContents {
  loadURL(url: string): Promise<void>;
  isLoading(): boolean;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  insertText(text: string): Promise<void>;
  focus(): void;
  debugger: DriverDebugger;
}

export interface ElectronPageDriverOptions {
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the file chooser after clicking an upload control. */
  chooserTimeoutMs?: number;
  /** Upper bound for any single page script or DevTools command that has no timeout of its own. */
  operationTimeoutMs?: number;
}

const json = JSON.stringify;
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Rejects with a PageTimeoutError if `promise` has not settled within `ms`. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PageTimeoutError(what, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const asRecord = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

/**
 * Drives a provider chat page through an Electron `WebContents`: reads and waits with in-page scripts,
 * and uses the DevTools protocol for the things scripts cannot do (attaching files, trusted clicks).
 */
export class ElectronPageDriver implements PageDriver {
  private readonly contents: DriverContents;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly chooserTimeoutMs: number;
  private readonly operationTimeoutMs: number;

  /** `native` is the `WebContents` of the provider view. */
  constructor(native: unknown, options: ElectronPageDriverOptions = {}) {
    this.contents = native as DriverContents;
    this.sleep = options.sleep ?? defaultSleep;
    this.chooserTimeoutMs = options.chooserTimeoutMs ?? 5000;
    this.operationTimeoutMs = options.operationTimeoutMs ?? 15_000;
  }

  /** Releases the DevTools protocol session. Safe to call more than once. */
  dispose(): void {
    if (this.contents.debugger.isAttached()) this.contents.debugger.detach();
  }

  /** Runs a script in the page. Bounded, so a page that never answers cannot hang the caller. */
  private evaluate<T>(code: string): Promise<T> {
    return within(this.contents.executeJavaScript(code, false) as Promise<T>, this.operationTimeoutMs, 'a page script');
  }

  private cdp(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.contents.debugger.isAttached()) this.contents.debugger.attach('1.3');
    return within(this.contents.debugger.sendCommand(method, params).then(asRecord), this.operationTimeoutMs, method);
  }

  async goto(url: string, timeoutMs: number): Promise<void> {
    // A redirect aborts the first navigation (ERR_ABORTED) even though the page loads fine.
    await within(this.contents.loadURL(url).catch(() => undefined), timeoutMs, `loading ${url}`);
    const stop = Date.now() + timeoutMs;
    while (this.contents.isLoading()) {
      if (Date.now() > stop) throw new PageTimeoutError(`finishing the load of ${url}`, timeoutMs);
      await this.sleep(100);
    }
  }

  async count(selector: string): Promise<number> {
    return this.evaluate<number>(
      `(() => { try { return document.querySelectorAll(${json(selector)}).length; } catch { return 0; } })()`,
    );
  }

  async waitFor(selector: string, timeoutMs: number): Promise<boolean> {
    const script = `new Promise((resolve) => {
      const sel = ${json(selector)};
      const present = () => { try { return document.querySelector(sel) !== null; } catch { return false; } };
      if (present()) { resolve(true); return; }
      const done = (value) => { observer.disconnect(); clearTimeout(timer); resolve(value); };
      const observer = new MutationObserver(() => { if (present()) done(true); });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      const timer = setTimeout(() => done(false), ${Math.max(1, Math.floor(timeoutMs))});
    })`;
    return within(this.evaluate<boolean>(script), timeoutMs + 2000, `waiting for ${selector}`);
  }

  async setInputFiles(selector: string, paths: readonly string[]): Promise<void> {
    const files = [...paths];
    const root = asRecord((await this.cdp('DOM.getDocument', { depth: 0 })).root);
    const found = await this.cdp('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!found.nodeId) throw new Error(`No element matches ${selector}`);

    const node = asRecord((await this.cdp('DOM.describeNode', { nodeId: found.nodeId })).node);
    const attributes = Array.isArray(node.attributes) ? (node.attributes as string[]) : [];
    const typeIndex = attributes.indexOf('type');
    const isFileInput = node.nodeName === 'INPUT' && typeIndex >= 0 && attributes[typeIndex + 1] === 'file';

    if (isFileInput) {
      await this.cdp('DOM.setFileInputFiles', { files, nodeId: found.nodeId });
      return;
    }

    // A control that opens the file chooser: intercept the chooser instead of letting a native dialog open.
    await this.cdp('Page.enable');
    await this.cdp('Page.setInterceptFileChooserDialog', { enabled: true });
    let listener: ((event: unknown, method: string, params: unknown) => void) | undefined;
    try {
      const opened = new Promise<number>((resolve) => {
        listener = (_event, method, params) => {
          if (method === 'Page.fileChooserOpened') resolve(Number(asRecord(params).backendNodeId));
        };
        this.contents.debugger.on('message', listener);
      });
      await this.click(selector);
      const backendNodeId = await within(opened, this.chooserTimeoutMs, 'the file chooser to open');
      await this.cdp('DOM.setFileInputFiles', { files, backendNodeId });
    } finally {
      if (listener) this.contents.debugger.removeListener('message', listener);
      await this.cdp('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => undefined);
    }
  }

  async insertText(selector: string, text: string): Promise<void> {
    const focused = await this.evaluate<boolean>(
      `(() => { const el = document.querySelector(${json(selector)}); if (!el) return false; el.focus(); return true; })()`,
    );
    if (!focused) throw new Error(`No element matches ${selector}`);
    this.contents.focus();
    await within(this.contents.insertText(text), this.operationTimeoutMs, 'inserting text');
  }

  async click(selector: string): Promise<void> {
    const target = await this.evaluate<{ x: number; y: number; empty: boolean } | null>(
      `(() => {
        const el = document.querySelector(${json(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, empty: r.width === 0 || r.height === 0 };
      })()`,
    );
    if (!target) throw new Error(`No element matches ${selector}`);

    if (target.empty) {
      // Nothing to hit with a mouse event (not laid out): fall back to the element's own click().
      await this.evaluate(`document.querySelector(${json(selector)}).click()`);
      return;
    }
    const base = { x: target.x, y: target.y, button: 'left', clickCount: 1 };
    await this.cdp('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' });
    await this.cdp('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
    await this.cdp('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
  }

  async pageText(): Promise<string> {
    return this.evaluate<string>(`(document.body ? (document.body.innerText ?? document.body.textContent ?? '') : '')`);
  }

  async fetchImage(selector: string, timeoutMs: number, options: FetchImageOptions = {}): Promise<Uint8Array> {
    const rewrites = (options.urlRewrites ?? []).map((r) => ({ pattern: r.pattern, replacement: r.replacement }));
    const script = `(async () => {
      const img = document.querySelector(${json(selector)});
      if (!img) throw new Error('image element not found');
      let url = img.currentSrc || img.src || img.getAttribute('src');
      if (!url) throw new Error('image has no URL');
      for (const r of ${json(rewrites)}) url = url.replace(new RegExp(r.pattern), r.replacement);

      // Image CDNs usually allow anonymous reads; try that first, then with the session cookies.
      let response;
      for (const credentials of ['omit', 'include']) {
        try { response = await fetch(url, { credentials }); if (response.ok) break; } catch (error) { response = undefined; }
      }
      if (!response || !response.ok) throw new Error('download failed' + (response ? ' (HTTP ' + response.status + ')' : ''));

      const blob = await response.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      return String(dataUrl).split(',')[1] || '';
    })()`;
    const base64 = await within(this.evaluate<string>(script), timeoutMs, `downloading ${selector}`);
    if (!base64) throw new Error('The download was empty.');
    return Buffer.from(base64, 'base64');
  }
}
