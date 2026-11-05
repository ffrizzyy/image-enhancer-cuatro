// Runs inside Electron (see scripts/integration.mjs): proves real partitions are isolated.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { app, session } from 'electron';

import { createElectronBackend } from '../../src/electronBackend';
import { createHealthProbe } from '../../src/health';
import { createSessionMonitor } from '../../src/monitor';
import { partitionFor } from '../../src/partitions';
import { createSessionManager } from '../../src/SessionManager';
import type { ProviderView, SessionBackend } from '../../src/types';

// Isolated profile so the run never touches real provider logins.
app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'ie-sessions-')));

// Closing the last window (clear() destroys it) must not quit the app mid-test.
app.on('window-all-closed', () => {});

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`ok - ${message}`);
}

async function cookieNames(partition: string): Promise<string[]> {
  return (await session.fromPartition(partition).cookies.get({})).map((c) => c.name);
}

const page = (body: string): string =>
  `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><body>${body}</body>`)}`;

// Real WebContentsViews, real probe script, real monitor: local pages stand in for providers.
async function runHealthAndAutoShow(): Promise<void> {
  const pages = {
    gpt: page("<button data-testid='login-button'>Log in</button>"),
    gemini: page('<rich-textarea></rich-textarea>'),
    grok: page('<h1>Just a moment...</h1>'),
  } as const;

  // Record views as they are created so visibility can be observed without calling open().
  const real = createElectronBackend();
  const views = new Map<string, ProviderView>();
  const backend: SessionBackend = {
    createView: (partition, opts) => {
      const view = real.createView(partition, opts);
      views.set(partition, view);
      return view;
    },
    clearPartition: real.clearPartition,
  };

  const manager = createSessionManager({
    backend,
    healthProbe: createHealthProbe(),
    loginUrlFor: (provider) => pages[provider],
  });
  const seen = new Map<string, string>();
  const monitor = createSessionMonitor({ manager, onStatus: (p, s) => seen.set(p, s) });

  for (const provider of ['gpt', 'gemini', 'grok'] as const) await manager.open(provider);
  const settled = () => seen.get('gpt') === 'logged-out' && seen.get('gemini') === 'ready' && seen.get('grok') === 'challenge';
  for (const deadline = Date.now() + 15000; Date.now() < deadline && !settled(); ) {
    await monitor.tick();
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  check(seen.get('gpt') === 'logged-out', 'real page with a login button probes as logged-out');
  check(seen.get('gemini') === 'ready', 'real page with the composer probes as ready');
  check(seen.get('grok') === 'challenge', 'real page with a bot-check phrase probes as challenge');

  check(views.get(partitionFor('gpt'))?.isVisible() === true, 'monitor auto-showed the logged-out window');
  check(views.get(partitionFor('grok'))?.isVisible() === true, 'monitor auto-showed the challenge window');
  check(views.get(partitionFor('gemini'))?.isVisible() === false, 'the ready window stayed hidden');

  for (const provider of ['gpt', 'gemini', 'grok'] as const) await manager.clear(provider);
}

async function run(): Promise<void> {
  const manager = createSessionManager({ backend: createElectronBackend() });
  const gpt = partitionFor('gpt');
  const gemini = partitionFor('gemini');

  const handle = await manager.open('gpt');
  check(handle.partition === gpt, 'open() returns a handle on persist:gpt');
  check(!handle.view.isVisible(), 'view is hidden by default');

  const url = 'https://example.com';
  await session.fromPartition(gpt).cookies.set({ url, name: 'gpt_cookie', value: 'x' });
  await session.fromPartition(gemini).cookies.set({ url, name: 'gemini_cookie', value: 'y' });

  check((await cookieNames(gpt)).join() === 'gpt_cookie', 'gpt partition holds only its own cookie');
  check((await cookieNames(gemini)).join() === 'gemini_cookie', 'gemini partition does not see the gpt cookie');

  await manager.clear('gpt');
  check((await cookieNames(gpt)).length === 0, 'clear(gpt) removes gpt cookies');
  check((await cookieNames(gemini)).join() === 'gemini_cookie', 'clear(gpt) leaves gemini untouched');

  await runHealthAndAutoShow();
}

void app.whenReady().then(async () => {
  try {
    await run();
    console.log('INTEGRATION_OK');
    app.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    app.exit(1);
  }
});
