import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { EnhanceRequest } from '@ie/contracts';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createImageSaver, ProviderError, WebAdapter, type PageDriver, type ProviderConfig } from '../src';
import { FakeClock, FakePage, type FakePageOptions, type PageScenario } from './support/fakePage';
import { testConfig } from './support/testConfig';

let dir: string;
let big: Buffer;
let counter = 0;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ie-webadapter-'));
  big = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#335577' } }).png().toBuffer();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const request = (over: Partial<EnhanceRequest> = {}): EnhanceRequest => ({
  attachments: [{ role: 'tile', path: 'C:/tmp/tile.png' }],
  prompt: 'Enhance this tile.',
  timeoutMs: 20_000,
  ...over,
});

interface SetupOptions {
  scenario?: PageScenario;
  page?: Partial<FakePageOptions>;
  config?: Partial<ProviderConfig>;
  random?: () => number;
}

function setup(o: SetupOptions = {}) {
  const clock = new FakeClock();
  const sleeps: number[] = [];
  const page = new FakePage({ scenario: o.scenario ?? 'ok', clock, image: big, resultAfterPolls: 2, ...o.page });
  const adapter = new WebAdapter({
    driver: page,
    config: testConfig(o.config),
    saveImage: createImageSaver(path.join(dir, `out-${counter++}`)),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
    },
    random: o.random ?? (() => 0.5),
    now: clock.now,
    pollMs: 1000,
  });
  return { adapter, page, clock, sleeps };
}

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProviderError);
  return error as ProviderError;
}

/** A driver that sees a fixed page, for classification and error-mapping tests. */
function staticDriver(text: string, present: readonly string[] = [], over: Partial<PageDriver> = {}): PageDriver {
  return {
    goto: async () => {},
    count: async (s) => s.split(',').filter((p) => present.includes(p.trim())).length,
    waitFor: async () => false,
    setInputFiles: async () => {},
    insertText: async () => {},
    click: async () => {},
    pageText: async () => text,
    fetchImage: async () => big,
    ...over,
  };
}

function adapterFor(driver: PageDriver, config = testConfig()): WebAdapter {
  const clock = new FakeClock();
  return new WebAdapter({
    driver,
    config,
    saveImage: createImageSaver(path.join(dir, `out-${counter++}`)),
    sleep: async (ms) => clock.advance(ms),
    now: clock.now,
  });
}

describe('the normal flow', () => {
  it('opens a new chat, attaches in order, pastes the prompt once, submits, waits, then downloads', async () => {
    const { adapter, page } = setup();
    const attachments = [
      { role: 'tile' as const, path: 'C:/t/a.png' },
      { role: 'global-reference' as const, path: 'C:/t/b.png' },
      { role: 'neighbor' as const, path: 'C:/t/c.png' },
    ];
    const prompt = 'Line one.\nLine two with "quotes".';
    const result = await adapter.enhance(request({ attachments, prompt }));

    const at = (prefix: string) => page.log.findIndex((l) => l.startsWith(prefix));
    expect(page.log[0]).toBe('goto:https://chat.example.test/new');
    expect(page.log).toContain('setFiles:input[type=file]:C:/t/a.png|C:/t/b.png|C:/t/c.png');
    expect(page.log.filter((l) => l.startsWith('insert:'))).toEqual([`insert:#prompt:${prompt}`]);
    expect(at('setFiles')).toBeLessThan(at('insert'));
    expect(at('insert')).toBeLessThan(at('click'));
    expect(at('click')).toBeLessThan(at('waitFor:img.result'));
    expect(at('waitFor:img.result')).toBeLessThan(at('fetch'));
    expect(page.log.filter((l) => l.startsWith('click:'))).toEqual(['click:button.send']);

    expect(result).toMatchObject({ width: 1024, height: 1024 });
    expect(result.imagePath).toMatch(/result-001\.png$/);
  });

  it('reports elapsed time from the clock', async () => {
    const { adapter, clock } = setup();
    const result = await adapter.enhance(request());
    expect(result.elapsedMs).toBe(clock.t);
    expect(result.elapsedMs).toBeGreaterThan(0);
  });

  it('opens a fresh chat for every call', async () => {
    const { adapter, page } = setup();
    await adapter.enhance(request());
    await adapter.enhance(request());
    expect(page.newChats).toBe(2);
    expect(page.log.filter((l) => l.startsWith('goto:'))).toHaveLength(2);
  });

  it('waits for the spinner to go even after the image first appears', async () => {
    const { adapter, page } = setup({ page: { resultAfterPolls: 1 } });
    await adapter.enhance(request());
    expect(page.log.some((l) => l.startsWith('fetch'))).toBe(true);
  });

  it('copies capabilities from the config instead of sharing them', () => {
    const config = testConfig();
    const { adapter } = setup({ config });
    expect(adapter.id).toBe('gpt');
    expect(adapter.capabilities).toEqual(config.capabilities);
    adapter.capabilities.outputAspects.push('16:9' as never);
    expect(config.capabilities.outputAspects).toEqual(['1:1', '2:3', '3:2']);
  });
});

describe('human-like pacing', () => {
  it('pauses 150-599 ms around the prompt, using the injected random', async () => {
    const low = setup({ random: () => 0 });
    await low.adapter.enhance(request());
    expect(low.sleeps.filter((ms) => ms === 150)).toHaveLength(2);

    const high = setup({ random: () => 0.999 });
    await high.adapter.enhance(request());
    expect(high.sleeps.filter((ms) => ms === 599)).toHaveLength(2);
    expect(Math.max(...high.sleeps.filter((ms) => ms !== 250))).toBeLessThanOrEqual(599);
  });
});

describe('selectors', () => {
  it('tries the fallbacks in order and uses the first that matches', async () => {
    const { adapter, page } = setup();
    await adapter.enhance(request());
    // "#prompt-missing" is first in the config but absent; "#prompt" is used.
    expect(page.log.some((l) => l.startsWith('insert:#prompt:'))).toBe(true);
    expect(page.log.some((l) => l.includes('#prompt-missing:'))).toBe(false);
  });

  it('prefers an earlier fallback when several match', async () => {
    const config = testConfig();
    config.selectors.promptInput = ['#composer', '#prompt'];
    const { adapter, page } = setup({ config, page: { extra: ['#composer'] } });
    await adapter.enhance(request());
    expect(page.log.some((l) => l.startsWith('insert:#composer:'))).toBe(true);
  });

  it('throws ui-changed naming the missing selector key and what it tried', async () => {
    const { adapter } = setup({ page: { missing: ['#prompt'] } });
    const error = await failure(adapter.enhance(request()));
    expect(error.kind).toBe('ui-changed');
    expect(error.selector).toBe('promptInput');
    expect(error.message).toContain('promptInput');
    expect(error.message).toContain('#prompt-missing | #prompt');
  });

  it('a change to the config alone fixes a simulated UI change', async () => {
    const page = { missing: ['#prompt'], extra: ['#composer'] };
    expect((await failure(setup({ page }).adapter.enhance(request()))).selector).toBe('promptInput');

    const config = testConfig();
    config.selectors.promptInput = ['#prompt', '#composer'];
    await expect(setup({ page, config }).adapter.enhance(request())).resolves.toMatchObject({ width: 1024 });
  });

  it.each([
    ['attachInput', 'input[type=file]'],
    ['submitButton', 'button.send'],
    ['resultImage', 'img.result'],
  ])('reports %s as the missing selector when the page lacks it', async (key, selector) => {
    const { adapter } = setup({ page: { missing: [selector] } });
    const error = await failure(adapter.enhance(request()));
    expect(error).toMatchObject({ kind: 'ui-changed', selector: key });
  });

  it('notices attachments that never appear, before submitting', async () => {
    const { adapter, page } = setup({ page: { thumbnails: 1 } });
    const error = await failure(
      adapter.enhance(
        request({ attachments: [{ role: 'tile', path: 'C:/a.png' }, { role: 'global-reference', path: 'C:/b.png' }] }),
      ),
    );
    expect(error).toMatchObject({ kind: 'ui-changed', selector: 'attachmentThumb' });
    expect(error.message).toContain('Only 1 of 2 attachments');
    expect(page.log.some((l) => l.startsWith('click:'))).toBe(false);
  });
});

describe('page states map to exactly one error kind', () => {
  it.each([
    ['quota', 'quota'],
    ['refusal', 'refusal'],
    ['challenge', 'challenge'],
  ] as const)('%s while generating', async (scenario, kind) => {
    const { adapter } = setup({ scenario });
    expect((await failure(adapter.enhance(request()))).kind).toBe(kind);
  });

  it('logged-out is caught on opening the chat, before anything is attached', async () => {
    const { adapter, page } = setup({ scenario: 'logged-out' });
    expect((await failure(adapter.enhance(request()))).kind).toBe('logged-out');
    expect(page.log.some((l) => l.startsWith('setFiles'))).toBe(false);
  });

  it('recognises a marker by selector alone, and by text alone, case-insensitively', async () => {
    expect((await failure(adapterFor(staticDriver('', ['iframe.captcha'])).enhance(request()))).kind).toBe('challenge');
    expect((await failure(adapterFor(staticDriver('', ['.login-btn'])).enhance(request()))).kind).toBe('logged-out');
    expect((await failure(adapterFor(staticDriver('YOU HAVE REACHED THE USAGE LIMIT')).enhance(request()))).kind).toBe('quota');
    expect((await failure(adapterFor(staticDriver("Sorry, I CAN'T HELP WITH THAT.")).enhance(request()))).kind).toBe('refusal');
  });

  it('picks one kind by priority when several markers show: challenge > logged-out > quota > refusal', async () => {
    const all = "verify you are human. log in to continue. usage limit. can't help with that";
    expect((await failure(adapterFor(staticDriver(all)).enhance(request()))).kind).toBe('challenge');
    expect((await failure(adapterFor(staticDriver("log in to continue. usage limit. can't help with that")).enhance(request()))).kind).toBe('logged-out');
    expect((await failure(adapterFor(staticDriver("usage limit. can't help with that")).enhance(request()))).kind).toBe('quota');
  });
});

describe('timeouts', () => {
  it('times out when the image never appears, within the configured generation time', async () => {
    const { adapter, clock } = setup({ scenario: 'never' });
    const error = await failure(adapter.enhance(request()));
    expect(error.kind).toBe('timeout');
    expect(error.message).toContain('waiting for the image');
    expect(clock.t).toBeLessThanOrEqual(3000 + 1500);
  });

  it('lets the request timeout shorten, but not extend, the wait', async () => {
    const short = setup({ scenario: 'never' });
    expect((await failure(short.adapter.enhance(request({ timeoutMs: 1500 })))).kind).toBe('timeout');
    expect(short.clock.t).toBeLessThanOrEqual(1600);

    const long = setup({ scenario: 'never' });
    await failure(long.adapter.enhance(request({ timeoutMs: 3_600_000 })));
    expect(long.clock.t).toBeLessThanOrEqual(3000 + 1500); // the 3000 ms generation cap still applies
  });

  it('times out when the budget is spent before a step', async () => {
    const { adapter } = setup();
    expect((await failure(adapter.enhance(request({ timeoutMs: 100 })))).kind).toBe('timeout');
  });
});

describe('download', () => {
  it('maps a failed fetch to download-failed and keeps the cause', async () => {
    const { adapter } = setup({ scenario: 'download-failed' });
    const error = await failure(adapter.enhance(request()));
    expect(error.kind).toBe('download-failed');
    expect(String((error.cause as Error).message)).toContain('403');
  });

  it('treats a thumbnail-sized image as a preview, not the result', async () => {
    const preview = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#000' } }).png().toBuffer();
    const { adapter } = setup({ scenario: 'preview-only', page: { preview } });
    const error = await failure(adapter.enhance(request()));
    expect(error.kind).toBe('download-failed');
    expect(error.message).toMatch(/preview/);
    expect(error.message).toContain('512');
  });

  it('maps bytes that are not an image to download-failed', async () => {
    const { adapter } = setup({ page: { image: Buffer.from('this is not an image') } });
    const error = await failure(adapter.enhance(request()));
    expect(error).toMatchObject({ kind: 'download-failed' });
    expect(error.message).toContain('not a usable image');
  });
});

describe('error discipline', () => {
  it('reports an unexpected driver failure as a ProviderError with the cause, never a plain Error', async () => {
    const boom = new Error('target closed');
    const error = await failure(adapterFor(staticDriver('Ask anything', [], { goto: async () => Promise.reject(boom) })).enhance(request()));
    expect(error.kind).toBe('ui-changed');
    expect(error.message).toContain('target closed');
    expect(error.cause).toBe(boom);
  });

  it('reports a non-Error throw too', async () => {
    const error = await failure(adapterFor(staticDriver('', [], { goto: () => Promise.reject('string failure') })).enhance(request()));
    expect(error.message).toContain('string failure');
  });

  it('rejects a malformed request with RangeError, without touching the page', async () => {
    const { adapter, page } = setup();
    for (const bad of [
      request({ attachments: [] }),
      request({ attachments: Array.from({ length: 4 }, () => ({ role: 'tile' as const, path: 'C:/a.png' })) }),
      request({ timeoutMs: 0 }),
      request({ timeoutMs: NaN }),
    ]) {
      const error = await adapter.enhance(bad).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(RangeError);
      expect(error).not.toBeInstanceOf(ProviderError);
    }
    expect(page.log).toEqual([]);
  });
});

describe('health', () => {
  it('is ok on a healthy idle page, without generating', async () => {
    const { adapter, page } = setup();
    expect(await adapter.health()).toEqual({ ok: true, missingSelectors: [] });
    expect(page.log.some((l) => /^(setFiles|insert|click|fetch)/.test(l))).toBe(false);
  });

  it('lists exactly the idle selector keys that no longer match', async () => {
    const { adapter } = setup({ page: { missing: ['#prompt', 'button.send'] } });
    expect(await adapter.health()).toEqual({ ok: false, missingSelectors: ['promptInput', 'submitButton'] });
  });

  it('is not ok when the page is logged out or challenged, with no missing selectors', async () => {
    expect(await setup({ scenario: 'logged-out' }).adapter.health()).toEqual({ ok: false, missingSelectors: [] });
    expect((await adapterFor(staticDriver('verify you are human', ['#prompt', 'input[type=file]', 'button.send'])).health()).ok).toBe(false);
  });

  it('reports a driver failure as a ProviderError', async () => {
    const error = await failure(adapterFor(staticDriver('', [], { goto: async () => Promise.reject(new Error('gone')) })).health());
    expect(error.kind).toBe('ui-changed');
  });
});

describe('config features for menu-driven UIs', () => {
  const withMenu = (): ProviderConfig => {
    const config = testConfig();
    config.beforeAttach = [['#no-such-menu', 'button.menu']];
    return config;
  };

  it('clicks the beforeAttach controls, in order, before looking up the file input', async () => {
    const { adapter, page } = setup({ config: withMenu(), page: { attachBehindMenu: true } });
    await adapter.enhance(request());

    const at = (prefix: string) => page.log.findIndex((l) => l.startsWith(prefix));
    expect(at('click:button.menu')).toBeGreaterThan(-1);
    expect(at('click:button.menu')).toBeLessThan(at('setFiles'));
    expect(at('setFiles')).toBeLessThan(at('insert'));
  });

  it('fails clearly, naming the step, when a beforeAttach control is missing', async () => {
    const config = testConfig();
    config.beforeAttach = [['#no-such-menu']];
    const error = await failure(setup({ config, page: { attachBehindMenu: true } }).adapter.enhance(request()));
    expect(error).toMatchObject({ kind: 'ui-changed', selector: 'beforeAttach[0]' });
    expect(error.message).toContain('#no-such-menu');
  });

  it('without the menu step, a file input hidden behind a menu is reported as the missing attachInput', async () => {
    const error = await failure(setup({ page: { attachBehindMenu: true } }).adapter.enhance(request()));
    expect(error).toMatchObject({ kind: 'ui-changed', selector: 'attachInput' });
  });

  it('health checks only the configured healthKeys, since a menu-hidden input is absent when idle', async () => {
    const strict = setup({ page: { attachBehindMenu: true } });
    expect(await strict.adapter.health()).toEqual({ ok: false, missingSelectors: ['attachInput'] });

    const config = testConfig();
    config.healthKeys = ['promptInput'];
    const lenient = setup({ config, page: { attachBehindMenu: true } });
    expect(await lenient.adapter.health()).toEqual({ ok: true, missingSelectors: [] });
  });

  it('times out as a PageTimeoutError from the driver and reports it as a timeout', async () => {
    const { PageTimeoutError } = await import('../src');
    const adapter = adapterFor(
      staticDriver('Ask anything', ['#prompt'], { goto: async () => Promise.reject(new PageTimeoutError('loading', 5)) }),
    );
    expect((await failure(adapter.enhance(request()))).kind).toBe('timeout');
  });
});