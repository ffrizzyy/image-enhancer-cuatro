import { describe, expect, it, vi } from 'vitest';

import { PageTimeoutError } from '../src';
import { ElectronPageDriver } from '../src/electron';
import { JsdomContents, page } from './support/jsdomContents';

const driverFor = (contents: JsdomContents, chooserTimeoutMs = 200) =>
  new ElectronPageDriver(contents, { sleep: async () => {}, chooserTimeoutMs });

const SIMPLE = page(`
  <rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea>
  <button class="send" aria-label="Send message"></button>
  <input type="file" id="files" multiple />
  <button class="upload" aria-label="Upload files"></button>
  <p>Hello there</p>`);

describe('count and pageText', () => {
  it('counts matches, including selector lists, and treats a bad selector as no match', async () => {
    const driver = driverFor(new JsdomContents(page('<i class="a"></i><i class="a"></i><b id="b"></b>')));
    expect(await driver.count('.a')).toBe(2);
    expect(await driver.count('.a, #b')).toBe(3);
    expect(await driver.count('.missing')).toBe(0);
    expect(await driver.count('[[[')).toBe(0);
  });

  it('reads the page text', async () => {
    expect(await driverFor(new JsdomContents(SIMPLE)).pageText()).toContain('Hello there');
    expect(await driverFor(new JsdomContents('')).pageText()).toBeTypeOf('string');
  });
});

describe('waitFor (DOM mutation observation)', () => {
  it('resolves true at once when the element is already there', async () => {
    expect(await driverFor(new JsdomContents(SIMPLE)).waitFor('.send', 1000)).toBe(true);
  });

  it('resolves true as soon as the element appears, without waiting out the timeout', async () => {
    const contents = new JsdomContents(page('<div id="root"></div>'));
    setTimeout(() => contents.mutate((d) => d.getElementById('root')!.insertAdjacentHTML('beforeend', '<img class="result" />')), 40);

    const started = performance.now();
    expect(await driverFor(contents).waitFor('img.result', 5000)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it('notices an attribute change that makes an element match', async () => {
    const contents = new JsdomContents(page('<button id="go" disabled></button>'));
    setTimeout(() => contents.mutate((d) => d.getElementById('go')!.removeAttribute('disabled')), 30);
    expect(await driverFor(contents).waitFor('button:not([disabled])', 3000)).toBe(true);
  });

  it('resolves false at the timeout, and for a selector that cannot match', async () => {
    const driver = driverFor(new JsdomContents(SIMPLE));
    expect(await driver.waitFor('.never', 60)).toBe(false);
    expect(await driver.waitFor('[[[', 60)).toBe(false);
  });
});

describe('goto', () => {
  it('loads the URL and returns once the page has stopped loading', async () => {
    const contents = new JsdomContents(SIMPLE);
    contents.loadingTicks = 3;
    await driverFor(contents).goto('https://chat.example.test/new', 1000);
    expect(contents.loaded).toEqual(['https://chat.example.test/new']);
    expect(contents.loadingTicks).toBe(0);
  });

  it('ignores the navigation error a redirect produces', async () => {
    const contents = new JsdomContents(SIMPLE);
    contents.loadError = new Error('ERR_ABORTED (-3)');
    await expect(driverFor(contents).goto('https://chat.example.test/', 1000)).resolves.toBeUndefined();
  });

  it('times out as a PageTimeoutError when the load never settles, or never finishes', async () => {
    const hang = new JsdomContents(SIMPLE);
    hang.loadHangs = true;
    await expect(driverFor(hang).goto('https://x.test/', 50)).rejects.toThrow(PageTimeoutError);

    const stuck = new JsdomContents(SIMPLE);
    stuck.loadingTicks = Number.MAX_SAFE_INTEGER;
    await expect(new ElectronPageDriver(stuck, { sleep: () => new Promise((r) => setTimeout(r, 5)) }).goto('https://x.test/', 40)).rejects.toThrow(
      /finishing the load/,
    );
  });
});

describe('insertText', () => {
  it('focuses the element and inserts the whole text in one call', async () => {
    const contents = new JsdomContents(SIMPLE);
    const text = 'Line one.\nLine two "quoted" and \u00e9\u00e8.';
    await driverFor(contents).insertText('.ql-editor', text);

    expect(contents.inserted).toEqual([text]);
    expect(contents.focusCalls).toBe(1);
    expect(contents.dom.window.document.activeElement?.className).toBe('ql-editor');
  });

  it('fails clearly when the element is missing, without inserting anything', async () => {
    const contents = new JsdomContents(SIMPLE);
    await expect(driverFor(contents).insertText('.nope', 'x')).rejects.toThrow(/No element matches \.nope/);
    expect(contents.inserted).toEqual([]);
  });
});

describe('click', () => {
  it('sends a trusted mouse click at the centre of the element, attaching the debugger once', async () => {
    const contents = new JsdomContents(SIMPLE);
    contents.boxes.set('.send', { left: 100, top: 200, width: 40, height: 20 });
    const driver = driverFor(contents);
    await driver.click('.send');
    await driver.click('.send');

    const mouse = contents.cdp.filter((c) => c.method === 'Input.dispatchMouseEvent');
    expect(mouse.map((m) => m.params?.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(mouse[1]!.params).toMatchObject({ x: 120, y: 210, button: 'left', clickCount: 1 });
    expect(contents.attachCalls).toBe(1);
  });

  it('falls back to the element\'s own click() when it has no layout', async () => {
    const contents = new JsdomContents(SIMPLE);
    const clicked = vi.fn();
    contents.dom.window.document.querySelector('.send')!.addEventListener('click', clicked);
    await driverFor(contents).click('.send');
    expect(clicked).toHaveBeenCalledOnce();
    expect(contents.cdp.some((c) => c.method === 'Input.dispatchMouseEvent')).toBe(false);
  });

  it('fails clearly when the element is missing', async () => {
    await expect(driverFor(new JsdomContents(SIMPLE)).click('.nope')).rejects.toThrow(/No element matches \.nope/);
  });
});

describe('setInputFiles', () => {
  const files = ['C:\\tmp\\tile.png', 'C:\\tmp\\whole.png'];

  it('sets files on a file input directly, in order', async () => {
    const contents = new JsdomContents(SIMPLE);
    await driverFor(contents).setInputFiles('#files', files);

    const set = contents.cdp.find((c) => c.method === 'DOM.setFileInputFiles')!;
    expect(set.params).toMatchObject({ files, nodeId: 100 });
    expect(contents.cdp.some((c) => c.method === 'Page.setInterceptFileChooserDialog')).toBe(false);
  });

  it('intercepts the file chooser for a control that opens one, then cleans up', async () => {
    const contents = new JsdomContents(SIMPLE);
    contents.boxes.set('.upload', { left: 10, top: 10, width: 30, height: 30 });
    await driverFor(contents).setInputFiles('.upload', files);

    const methods = contents.cdp.map((c) => c.method);
    expect(methods).toContain('Page.enable');
    expect(methods.indexOf('Input.dispatchMouseEvent')).toBeGreaterThan(methods.indexOf('Page.setInterceptFileChooserDialog'));
    const set = contents.cdp.find((c) => c.method === 'DOM.setFileInputFiles')!;
    expect(set.params).toMatchObject({ files, backendNodeId: 77 });

    const intercepts = contents.cdp.filter((c) => c.method === 'Page.setInterceptFileChooserDialog').map((c) => c.params?.enabled);
    expect(intercepts).toEqual([true, false]);
    expect(contents.interceptingChooser).toBe(false);
    expect(contents.listenerCount).toBe(0);
  });

  it('times out as a PageTimeoutError if no chooser opens, and still cleans up', async () => {
    const contents = new JsdomContents(SIMPLE);
    contents.chooserOpensOnClick = false;
    contents.boxes.set('.upload', { left: 10, top: 10, width: 30, height: 30 });

    await expect(driverFor(contents, 60).setInputFiles('.upload', files)).rejects.toThrow(PageTimeoutError);
    expect(contents.interceptingChooser).toBe(false);
    expect(contents.listenerCount).toBe(0);
  });

  it('fails clearly when nothing matches', async () => {
    await expect(driverFor(new JsdomContents(SIMPLE)).setInputFiles('.nope', files)).rejects.toThrow(/No element matches \.nope/);
  });
});

describe('fetchImage', () => {
  const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 250, 251, 252]);

  function withFetch(contents: JsdomContents, impl: (url: string, init: { credentials: string }) => Promise<unknown>): void {
    (contents.dom.window as unknown as { fetch: unknown }).fetch = impl;
  }
  const ok = (bytes: Uint8Array, contents: JsdomContents) => ({
    ok: true,
    status: 200,
    blob: async () => new contents.dom.window.Blob([bytes as unknown as BlobPart]),
  });

  const IMAGE = page('<img class="result" src="https://cdn.example.test/img/abc=s512" />');

  it('downloads the bytes of the image in the page', async () => {
    const contents = new JsdomContents(IMAGE);
    withFetch(contents, async () => ok(PNG, contents));
    const bytes = await driverFor(contents).fetchImage('img.result', 2000);
    expect([...bytes]).toEqual([...PNG]);
  });

  it('rewrites the URL to reach the original resolution, in order', async () => {
    const contents = new JsdomContents(IMAGE);
    const seen: string[] = [];
    withFetch(contents, async (url) => {
      seen.push(url);
      return ok(PNG, contents);
    });
    await driverFor(contents).fetchImage('img.result', 2000, {
      urlRewrites: [{ pattern: '=s\\d+$', replacement: '=s0' }, { pattern: 'cdn\\.', replacement: 'big.' }],
    });
    expect(seen).toEqual(['https://big.example.test/img/abc=s0']);
  });

  it('tries without credentials first, then with the session cookies', async () => {
    const contents = new JsdomContents(IMAGE);
    const modes: string[] = [];
    withFetch(contents, async (_url, init) => {
      modes.push(init.credentials);
      return init.credentials === 'omit' ? { ok: false, status: 403 } : ok(PNG, contents);
    });
    expect([...(await driverFor(contents).fetchImage('img.result', 2000))]).toEqual([...PNG]);
    expect(modes).toEqual(['omit', 'include']);
  });

  it('survives a network error on the first attempt', async () => {
    const contents = new JsdomContents(IMAGE);
    let calls = 0;
    withFetch(contents, async () => {
      if (calls++ === 0) throw new TypeError('Failed to fetch');
      return ok(PNG, contents);
    });
    expect([...(await driverFor(contents).fetchImage('img.result', 2000))]).toEqual([...PNG]);
  });

  it('rejects with the HTTP status when both attempts fail', async () => {
    const contents = new JsdomContents(IMAGE);
    withFetch(contents, async () => ({ ok: false, status: 404 }));
    await expect(driverFor(contents).fetchImage('img.result', 2000)).rejects.toThrow(/HTTP 404/);
  });

  it('reads a loaded image back from a canvas when it cannot be fetched (blob: URLs)', async () => {
    const contents = new JsdomContents(page('<img class="result" src="blob:https://app.example.test/abc" />'));
    withFetch(contents, async () => {
      throw new TypeError('Failed to fetch');
    });
    const { window } = contents.dom;
    const img = window.document.querySelector('img')!;
    Object.defineProperty(img, 'complete', { value: true });
    Object.defineProperty(img, 'naturalWidth', { value: 1024 });
    Object.defineProperty(img, 'naturalHeight', { value: 683 });
    const drawn: number[] = [];
    window.HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: () => drawn.push(1) })) as never;
    window.HTMLCanvasElement.prototype.toDataURL = () => `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`;

    const bytes = await driverFor(contents).fetchImage('img.result', 2000);
    expect([...bytes]).toEqual([...PNG]);
    expect(drawn).toHaveLength(1);
  });

  it('still fails when the image cannot be fetched and has not loaded', async () => {
    const contents = new JsdomContents(page('<img class="result" src="blob:https://app.example.test/abc" />'));
    withFetch(contents, async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(driverFor(contents).fetchImage('img.result', 2000)).rejects.toThrow(/download failed/);
  });

  it('rejects when there is no image, no URL, or an empty body', async () => {
    const missing = new JsdomContents(page(''));
    await expect(driverFor(missing).fetchImage('img.result', 2000)).rejects.toThrow(/image element not found/);

    const noUrl = new JsdomContents(page('<img class="result" />'));
    await expect(driverFor(noUrl).fetchImage('img.result', 2000)).rejects.toThrow(/no URL/);

    const empty = new JsdomContents(IMAGE);
    withFetch(empty, async () => ok(new Uint8Array(0), empty));
    await expect(driverFor(empty).fetchImage('img.result', 2000)).rejects.toThrow(/empty/);
  });

  it('times out as a PageTimeoutError if the download never finishes', async () => {
    const contents = new JsdomContents(IMAGE);
    withFetch(contents, () => new Promise(() => {}));
    await expect(driverFor(contents).fetchImage('img.result', 60)).rejects.toThrow(PageTimeoutError);
  });
});

describe('dispose', () => {
  it('detaches the debugger once, and is safe to call again or before attaching', async () => {
    const contents = new JsdomContents(SIMPLE);
    const driver = driverFor(contents);
    driver.dispose();
    expect(contents.detachCalls).toBe(0);

    contents.boxes.set('.send', { left: 1, top: 1, width: 5, height: 5 });
    await driver.click('.send');
    driver.dispose();
    driver.dispose();
    expect(contents.detachCalls).toBe(1);
  });
});
