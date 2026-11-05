import { JSDOM } from 'jsdom';

import type { DriverContents, DriverDebugger } from '../../src/electron';

type Listener = (event: unknown, method: string, params: unknown) => void;

export interface CdpCall {
  method: string;
  params: Record<string, unknown> | undefined;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A stand-in for Electron's `WebContents`: executes the driver's in-page scripts in jsdom, and plays the
 * DevTools protocol against that same DOM while recording every command.
 */
export class JsdomContents implements DriverContents {
  readonly dom: JSDOM;
  readonly cdp: CdpCall[] = [];
  readonly inserted: string[] = [];
  readonly loaded: string[] = [];
  attachCalls = 0;
  detachCalls = 0;
  focusCalls = 0;
  /** How many `isLoading()` calls still report true. */
  loadingTicks = 0;
  /** When set, `loadURL` rejects with it. */
  loadError: Error | null = null;
  /** When true, `loadURL` never settles. */
  loadHangs = false;
  /** When true, a click on an upload control opens the (intercepted) file chooser. */
  chooserOpensOnClick = true;
  /** Layout for elements (jsdom has none): selector -> box. */
  boxes = new Map<string, Box>();

  private attached = false;
  private intercept = false;
  private readonly listeners = new Set<Listener>();
  private readonly nodes: Element[] = [];

  readonly debugger: DriverDebugger;

  constructor(html: string) {
    this.dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = this.dom;
    window.Element.prototype.scrollIntoView = () => {};
    window.Element.prototype.getBoundingClientRect = function (this: Element) {
      for (const [selector, box] of boxes()) if (this.matches(selector)) return { ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => ({}) } as DOMRect;
      return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
    const boxes = (): Map<string, Box> => this.boxes;

    this.debugger = {
      isAttached: () => this.attached,
      attach: () => {
        this.attached = true;
        this.attachCalls++;
      },
      detach: () => {
        this.attached = false;
        this.detachCalls++;
      },
      sendCommand: (method, params) => this.command(method, params),
      on: (_event, listener) => void this.listeners.add(listener),
      removeListener: (_event, listener) => void this.listeners.delete(listener),
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  get interceptingChooser(): boolean {
    return this.intercept;
  }

  /** Runs `fn` against the page document (to build up or change the DOM in a test). */
  mutate(fn: (document: Document) => void): void {
    fn(this.dom.window.document);
  }

  async loadURL(url: string): Promise<void> {
    this.loaded.push(url);
    if (this.loadHangs) return new Promise(() => {});
    if (this.loadError) throw this.loadError;
  }

  isLoading(): boolean {
    if (this.loadingTicks > 0) {
      this.loadingTicks--;
      return true;
    }
    return false;
  }

  executeJavaScript(code: string): Promise<unknown> {
    try {
      return Promise.resolve(this.dom.window.eval(code));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async insertText(text: string): Promise<void> {
    this.inserted.push(text);
    const active = this.dom.window.document.activeElement;
    if (active) active.textContent = `${active.textContent ?? ''}${text}`;
    this.didInsertText(text);
  }

  /** Hooks for page simulations (see GeminiPageSim). */
  protected didInsertText(text: string): void {
    void text;
  }
  protected didSetFiles(files: string[]): void {
    void files;
  }

  focus(): void {
    this.focusCalls++;
  }

  private emit(method: string, params: unknown): void {
    for (const listener of [...this.listeners]) listener({}, method, params);
  }

  protected async command(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.cdp.push({ method, params });
    const document = this.dom.window.document;
    switch (method) {
      case 'DOM.getDocument':
        return { root: { nodeId: 1 } };
      case 'DOM.querySelector': {
        const el = document.querySelector(String(params?.selector));
        if (!el) return { nodeId: 0 };
        this.nodes.push(el);
        return { nodeId: 100 + this.nodes.length - 1 };
      }
      case 'DOM.describeNode': {
        const el = this.nodes[Number(params?.nodeId) - 100];
        const attributes = el ? Array.from(el.attributes).flatMap((a) => [a.name, a.value]) : [];
        return { node: { nodeName: el?.nodeName ?? '', attributes } };
      }
      case 'DOM.setFileInputFiles':
        this.didSetFiles((params?.files as string[] | undefined) ?? []);
        return {};
      case 'Page.setInterceptFileChooserDialog':
        this.intercept = Boolean(params?.enabled);
        return {};
      case 'Input.dispatchMouseEvent':
        if (params?.type === 'mouseReleased' && this.intercept && this.chooserOpensOnClick) {
          setTimeout(() => this.emit('Page.fileChooserOpened', { frameId: 'f', mode: 'selectMultiple', backendNodeId: 77 }), 0);
        }
        return {};
      default:
        return {};
    }
  }
}

export const page = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;
