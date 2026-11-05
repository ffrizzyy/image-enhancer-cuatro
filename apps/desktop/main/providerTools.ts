import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ProviderId } from '@ie/contracts';
import { getCategory, buildPrompt } from '@ie/presets';
import {
  createGeminiAdapter,
  createImageSaver,
  DISCOVERY_SCRIPT,
  loadProviderConfig,
  ProviderError,
  type ProviderAdapter,
} from '@ie/providers';
import { ElectronPageDriver } from '@ie/providers/electron';
import { createElectronBackend } from '@ie/sessions/electron';
import { createHealthProbe, createSessionManager, providersConfig, type OpenSession } from '@ie/sessions';
import sharp from 'sharp';

/** Structure of every image and busy/stop control on the page: tags, classes, sizes, URL host and kind. No text. */
const IMAGE_SURVEY = `(() => {
  const cut = (v, n = 60) => String(v == null ? '' : v).slice(0, n);
  const path = (el) => { const p = []; for (let e = el, i = 0; e && i < 5; e = e.parentElement, i++) p.unshift(e.tagName.toLowerCase() + [...e.classList].slice(0, 2).map((c) => '.' + cut(c, 30)).join('')); return p.join(' > '); };
  const images = [...document.images].map((img) => {
    let host = '', suffix = '', kind = 'other';
    try { const u = new URL(img.currentSrc || img.src); host = u.host; kind = u.protocol.replace(':', ''); suffix = u.pathname.slice(-12) + (u.search ? '?' + cut(u.search, 12) : '') + u.hash.slice(0, 0); } catch {}
    return { path: path(img), alt: cut(img.alt), natural: img.naturalWidth + 'x' + img.naturalHeight, shown: img.width + 'x' + img.height, host, kind, urlTail: suffix };
  });
  const busy = [...document.querySelectorAll('[aria-busy="true"], button[aria-label*="Stop" i], button[aria-label*="Cancel" i], [class*="loading" i], [class*="progress" i]')].slice(0, 20).map((el) => ({ path: path(el), label: cut(el.getAttribute('aria-label')) }));
  return { page: location.origin + location.pathname, images, busy };
})()`;

export type ToolCommand = 'discover' | 'health' | 'enhance' | 'download';

export interface ToolArgs {
  command: ToolCommand;
  provider: ProviderId;
  /** discover only: type this into the prompt box first (never submitted), so controls that need text appear. */
  type?: string;
  /** discover only: run the configured menu and attach steps with a synthetic test image (still never sent). */
  attach?: boolean;
  /** discover only: click this control first (e.g. an upload menu button), so its menu items can be listed. */
  open?: string;
  /** download only: an existing conversation on the provider's own site, to fetch its result image from (no generation). */
  chat?: string;
}

const COMMANDS: readonly string[] = ['discover', 'health', 'enhance', 'download'];
const PROVIDERS: readonly string[] = ['gpt', 'gemini', 'grok'];

/** Parses `<command> <provider>` from the arguments after `--provider-tool`. */
export function parseToolArgs(argv: readonly string[]): ToolArgs | string {
  const at = argv.indexOf('--provider-tool');
  const [command, provider, ...rest] = at >= 0 ? argv.slice(at + 1) : [];
  if (!command || !COMMANDS.includes(command)) return `Usage: --provider-tool <${COMMANDS.join('|')}> <${PROVIDERS.join('|')}> [--draft <text>] [--open <selector>]`;
  if (!provider || !PROVIDERS.includes(provider)) return `Unknown provider "${provider ?? ''}". Use one of: ${PROVIDERS.join(', ')}.`;

  const args: ToolArgs = { command: command as ToolCommand, provider: provider as ProviderId };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--attach') {
      args.attach = true;
      continue;
    }
    const value = rest[++i];
    if ((flag !== '--draft' && flag !== '--open' && flag !== '--chat') || value === undefined) {
      return `Unexpected argument "${flag ?? ''}": use --draft <text>, --open <selector>, --chat <url> or --attach.`;
    }
    if (flag === '--draft') args.type = value;
    else if (flag === '--chat') args.chat = value;
    else args.open = value;
  }
  return args;
}

const log = (message: string): void => console.log(`[provider-tool] ${message}`);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What the page reports about itself, or why it could not. Never includes page text. */
async function describePage(session: OpenSession): Promise<string> {
  const answer = session.view
    .evaluate<string>(`JSON.stringify({ url: location.origin + location.pathname, state: document.readyState, composer: document.querySelectorAll('.ql-editor, textarea, [contenteditable=true]').length })`)
    .catch((error: unknown) => `script failed: ${error instanceof Error ? error.message : String(error)}`);
  const timeout = new Promise<string>((resolve) => setTimeout(() => resolve('no answer from the page within 3 s'), 3000));
  return Promise.race([answer, timeout]);
}

/**
 * With `lenient` (discovery only), a page that has a composer and is not on a login or challenge status counts
 * as ready: a provider whose readiness probe is not verified yet can still be surveyed.
 */
async function waitUntilReady(manager: ReturnType<typeof createSessionManager>, session: OpenSession, provider: ProviderId, timeoutMs: number, lenient = false): Promise<boolean> {
  const stop = Date.now() + timeoutMs;
  let last = '';
  let polls = 0;
  let composerSeen = 0;
  while (Date.now() < stop) {
    const status = await manager.status(provider);
    if (lenient && status === 'unknown') {
      const page = await describePage(session);
      composerSeen = /"composer":[1-9]/.test(page) && !/login|signin|sign-in|auth/i.test(page) ? composerSeen + 1 : 0;
      if (composerSeen >= 3) {
        log(`status unknown (readiness probe not verified for ${provider}), but the page shows a composer: surveying anyway`);
        return true;
      }
    }
    if (status !== 'ready' && polls++ % 5 === 0) log(`page: ${await describePage(session)}`);
    if (status !== last) {
      log(`status: ${status}`);
      last = status;
      if (status === 'logged-out' || status === 'challenge') log('The provider window needs you: log in or finish the check there, then wait.');
    }
    if (status === 'ready') return true;
    await sleep(1000);
  }
  return false;
}

/** A small synthetic picture to enhance, so the smoke needs no personal image. */
async function makeTestImage(file: string): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="512">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4d58d"/><stop offset="1" stop-color="#3b6ea5"/></linearGradient></defs>
    <rect width="768" height="512" fill="url(#g)"/>
    <circle cx="560" cy="150" r="70" fill="#fff6d6"/>
    <polygon points="40,512 260,200 420,512" fill="#2d4a3e"/><polygon points="260,512 480,260 700,512" fill="#35614f"/>
    <rect x="300" y="400" width="90" height="60" fill="#8a5a44"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

function adapterFor(provider: ProviderId, session: OpenSession, outDir: string): ProviderAdapter {
  const driver = new ElectronPageDriver(session.view.native);
  const saveImage = createImageSaver(outDir, `${provider}-result`);
  if (provider === 'gemini') return createGeminiAdapter({ driver, saveImage });
  // Fails with a clear message for providers whose config is not shipped yet.
  loadProviderConfig(provider);
  throw new Error(`No adapter for ${provider} yet.`);
}

/**
 * Developer tools against the real, logged-in provider session in this app's profile. `discover` and `health`
 * only read the page. `enhance` performs ONE real generation on the account. Nothing here logs in, clears a
 * session, or reads credentials.
 */
export async function runProviderTool({ command, provider, type, open, attach, chat }: ToolArgs): Promise<number> {
  const manager = createSessionManager({
    backend: createElectronBackend(),
    healthProbe: createHealthProbe(),
    loginUrlFor: (p) => providersConfig[p].loginUrl,
  });
  const outDir = path.join(tmpdir(), 'ie-discovery');
  mkdirSync(outDir, { recursive: true });

  log(`opening ${provider} (visible) and waiting for a ready session...`);
  const session = await manager.open(provider, { visible: true });
  if (!(await waitUntilReady(manager, session, provider, 180_000, command === 'discover'))) {
    log('The session did not become ready in time. Log in in the provider window and run the tool again.');
    return 2;
  }

  try {
    if (command === 'discover') {
      const driver = new ElectronPageDriver(session.view.native);
      // Optional steps, to reveal controls that only exist after an interaction. Nothing is ever submitted.
      if (type) {
        let prompt = providersConfig[provider].probes.ready[0] ?? '';
        for (const candidate of ['.ql-editor[contenteditable="true"]', '.ProseMirror[contenteditable="true"]', 'textarea']) {
          if ((await driver.count(candidate)) > 0) {
            prompt = candidate;
            break;
          }
        }
        log(`typing a draft (not sent) into ${prompt}`);
        await driver.insertText(prompt, type);
        await sleep(1000);
      }
      if (open) {
        log(`clicking ${open} to reveal its menu`);
        await driver.click(open);
        await sleep(1200);
      }
      if (attach) {
        // The adapter's own attach steps, from the shipped config, with a throwaway synthetic image.
        const config = loadProviderConfig(provider);
        const tile = path.join(outDir, 'smoke-tile.png');
        await makeTestImage(tile);
        for (const step of config.beforeAttach ?? []) {
          log(`clicking ${step[0]}`);
          await driver.click(step[0] ?? '');
          await sleep(1200);
        }
        const input = config.selectors.attachInput[0] ?? '';
        log(`attaching a test image to ${input} (it will NOT be sent)`);
        await driver.setInputFiles(input, [tile]);
        await sleep(4000);
      }
      const report = await session.view.evaluate(DISCOVERY_SCRIPT);
      driver.dispose();
      const file = path.join(outDir, `${provider}-${type || open ? 'after' : 'idle'}.json`);
      writeFileSync(file, JSON.stringify(report, null, 2));
      log(`wrote ${file}`);
      return 0;
    }

    if (command === 'download') {
      // Read-only: open a conversation that already exists and fetch its result image, to test the download path.
      const config = loadProviderConfig(provider);
      if (!chat || new URL(chat).origin !== new URL(config.urls.newChat).origin) {
        log(`download needs --chat <a conversation URL on ${new URL(config.urls.newChat).origin}>`);
        return 1;
      }
      const driver = new ElectronPageDriver(session.view.native);
      try {
        await driver.goto(chat, config.timeouts.navigationMs);
        const selector = config.selectors.resultImage.join(', ');
        if (!(await driver.waitFor(selector, 30_000))) {
          log(`no element matched the resultImage selectors: ${selector}`);
          return 1;
        }
        await sleep(1500);
        const bytes = await driver.fetchImage(selector, config.timeouts.downloadMs, { urlRewrites: config.download?.urlRewrites ?? [] });
        const saved = await createImageSaver(outDir, `${provider}-download`)(bytes);
        log(`downloaded ${saved.width}x${saved.height} (${bytes.length} bytes) -> ${saved.imagePath}`);
        return 0;
      } finally {
        driver.dispose();
      }
    }

    const adapter = adapterFor(provider, session, outDir);
    if (command === 'health') {
      log(`health: ${JSON.stringify(await adapter.health())}`);
      return 0;
    }

    // enhance: one real generation.
    const tile = path.join(outDir, 'smoke-tile.png');
    await makeTestImage(tile);
    const category = getCategory('custom')!;
    const prompt = buildPrompt(category, 'A simple landscape illustration with mountains and a sun.', {
      role: 'center',
      row: 0,
      col: 0,
      grid: { rows: 1, cols: 1 },
    }).text;
    log('running ONE real enhancement on your account...');
    const result = await adapter.enhance({ attachments: [{ role: 'tile', path: tile }], prompt, timeoutMs: 240_000 });
    log(`result: ${result.width}x${result.height} in ${result.elapsedMs} ms -> ${result.imagePath}`);
    return Math.max(result.width, result.height) >= 1024 ? 0 : 3;
  } catch (error) {
    if (error instanceof ProviderError) log(`failed: ${error.kind}: ${error.message}${error.selector ? ` (selector key: ${error.selector})` : ''}`);
    else log(`failed: ${error instanceof Error ? error.message : String(error)}`);
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause) log(`cause: ${cause instanceof Error ? cause.message : String(cause)}`);
    if (command === 'enhance') {
      // What the page shows right now, structure only (no page text): lets a failed run still teach us the selectors.
      const state = await session.view.evaluate(IMAGE_SURVEY).catch((e: unknown) => `survey failed: ${String(e)}`);
      const file = path.join(outDir, `${provider}-failure.json`);
      writeFileSync(file, JSON.stringify(state, null, 2));
      log(`wrote page survey ${file}`);
    }
    return 1;
  }
}
