import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CURRENT_RISK_NOTICE_VERSION } from '@ie/contracts';
import {
  createHealthProbe,
  createSessionManager,
  createSessionMonitor,
  PROVIDER_IDS,
  partitionFor,
  providersConfig,
} from '@ie/sessions';
import { createElectronBackend } from '@ie/sessions/electron';
import { getFeatures } from '@ie/intake';
import { app, BrowserWindow, ipcMain, session, type WebContents } from 'electron';
import sharp from 'sharp';

import { handleAppPing, ipcError } from './ipc/app.js';
import { handleIntakeCreateJob, handleIntakeImport } from './ipc/intake.js';
import { handlePresetsList, handlePresetsSuggest } from './ipc/presets.js';
import { handleSessionsClear, handleSessionsOpen, handleSessionsStatus } from './ipc/sessions.js';
import { handleSettingsGet, handleSettingsSet } from './ipc/settings.js';
import { createAssetRegistry } from './assetRegistry.js';
import { createSettingsStore } from './settingsStore.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const smoke = process.argv.includes('--smoke');

// Smoke runs use a throwaway profile so they never touch (or depend on) real settings and logins.
if (smoke) app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'ie-smoke-profile-')));

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

let mainWindow: BrowserWindow | undefined;

function registerIpc(): void {
  const settings = createSettingsStore(path.join(app.getPath('userData'), 'settings.json'), app.getPath('userData'));
  if (smoke) settings.set({ firstRunAcknowledged: true, riskNoticeVersion: CURRENT_RISK_NOTICE_VERSION });

  const manager = createSessionManager({
    backend: createElectronBackend(),
    healthProbe: createHealthProbe(),
    loginUrlFor: (provider) => providersConfig[provider].loginUrl,
  });
  const monitor = createSessionMonitor({
    manager,
    onStatus: (providerId, status) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sessions.status', { providerId, status });
    },
  });
  if (!smoke) monitor.start();
  const sessionDeps = { manager, monitor };

  ipcMain.handle('app.ping', (_event, payload: unknown) => {
    try {
      return handleAppPing(payload, app.getVersion());
    } catch (error) {
      return ipcError('internal', error instanceof Error ? error.message : 'unknown error');
    }
  });

  const assets = createAssetRegistry();
  ipcMain.handle('intake.import', (_event, payload: unknown) => handleIntakeImport(payload, undefined, assets));
  ipcMain.handle('intake.createJob', (_event, payload: unknown) => handleIntakeCreateJob(payload, assets));
  ipcMain.handle('presets.list', () => handlePresetsList());
  const featuresDir = path.join(app.getPath('userData'), 'features');
  ipcMain.handle('presets.suggestCategory', (_event, payload: unknown) =>
    handlePresetsSuggest(payload, {
      registry: assets,
      featuresFor: async (asset) => (await getFeatures(asset, featuresDir)).features,
    }),
  );
  ipcMain.handle('sessions.open', (_event, payload: unknown) => handleSessionsOpen(payload, sessionDeps));
  ipcMain.handle('sessions.status', (_event, payload: unknown) => handleSessionsStatus(payload, sessionDeps));
  ipcMain.handle('sessions.clear', (_event, payload: unknown) => handleSessionsClear(payload, sessionDeps));
  ipcMain.handle('settings.get', () => handleSettingsGet(settings));
  ipcMain.handle('settings.set', (_event, payload: unknown) => handleSettingsSet(payload, settings));
}

/**
 * Imports a generated PNG and runs auto-detect on it through the real handlers, proving that
 * sharp (import and feature extraction) works in this build.
 */
async function smokeImport(): Promise<boolean> {
  const file = path.join(app.getPath('temp'), `ie-smoke-${process.pid}.png`);
  try {
    await sharp({ create: { width: 8, height: 4, channels: 3, background: '#ffffff' } })
      .png()
      .toFile(file);
    const registry = createAssetRegistry();
    const imported = await handleIntakeImport({ path: file }, undefined, registry);
    if (!imported.ok || imported.value.width !== 8 || imported.value.height !== 4) return false;

    const suggested = await handlePresetsSuggest(
      { assetId: imported.value.id, prompt: '' },
      {
        registry,
        featuresFor: async (asset) => (await getFeatures(asset, path.join(app.getPath('userData'), 'features'))).features,
      },
    );
    return suggested.ok;
  } finally {
    await rm(file, { force: true });
  }
}

/** Provider windows load third-party sites on their own partitions; they get a looser navigation policy. */
function isProviderContents(contents: WebContents): boolean {
  return PROVIDER_IDS.some((provider) => contents.session === session.fromPartition(partitionFor(provider)));
}

function applySecurity(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
      },
    });
  });

  app.on('web-contents-created', (_e, contents) => {
    contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

    if (isProviderContents(contents)) {
      // Login flows redirect and pop up (OAuth). Popups open in-app on the same partition;
      // nothing here ever hands a URL to the system default browser.
      contents.setWindowOpenHandler(() => ({ action: 'allow' }));
      return;
    }

    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  // Hidden provider windows would otherwise keep the app alive after the main window closes.
  win.on('closed', () => app.quit());
  void win.loadFile(path.join(here, 'renderer', 'index.html'));

  if (smoke) {
    // Smoke: pass only if the renderer rendered the ping result and the native image
    // stack (sharp) works end to end through the intake handler.
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void Promise.all([win.webContents.executeJavaScript('document.body.innerText'), smokeImport()])
          .then(([text, importOk]: [string, boolean]) => {
            const ok = text.includes('Main process ready') && importOk;
            console.log(ok ? 'SMOKE_OK' : `SMOKE_FAIL: importOk=${importOk} text=${text}`);
            app.exit(ok ? 0 : 1);
          })
          .catch((error: unknown) => {
            console.log(`SMOKE_FAIL: ${error instanceof Error ? error.message : String(error)}`);
            app.exit(1);
          });
      }, 1000);
    });
  }

  return win;
}

app.on('window-all-closed', () => app.quit());

// No top-level await: Electron defers `ready` until an ESM main module finishes evaluating.
void app.whenReady().then(() => {
  applySecurity();
  registerIpc();
  mainWindow = createWindow();
});
