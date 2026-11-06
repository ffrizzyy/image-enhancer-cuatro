import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CURRENT_RISK_NOTICE_VERSION, type ExportFormat, type ExportRequest, type ProviderId } from '@ie/contracts';
import {
  createHealthProbe,
  createSessionManager,
  createSessionMonitor,
  PROVIDER_IDS,
  partitionFor,
  providersConfig,
  type ProviderView,
  type SessionManager,
  type SessionMonitor,
} from '@ie/sessions';
import { createElectronBackend } from '@ie/sessions/electron';
import { getFeatures } from '@ie/intake';
import { configureOverrides } from '@ie/presets';
import { openStore, PACING_PRESETS } from '@ie/orchestrator';
import { createGeminiAdapter, createGptAdapter, createGrokAdapter, createImageSaver, type ProviderAdapter } from '@ie/providers';
import { ElectronPageDriver } from '@ie/providers/electron';
import { app, BrowserWindow, dialog, ipcMain, session, shell, type WebContents } from 'electron';
import sharp from 'sharp';

import { handleAppPing, ipcError } from './ipc/app.js';
import { handleExportSave } from './ipc/export.js';
import { handleIntakeImport, handleIntakePreview } from './ipc/intake.js';
import {
  handleCreateAndRegisterJob,
  handleJobsAcceptTile,
  handleJobsCancel,  handleJobsCostPreview,
  handleJobsFinishReview,
  handleJobsGet,
  handleJobsListRecent,
  handleJobsPause,
  handleJobsResult,
  handleJobsRerunTile,
  handleJobsResume,  handleJobsStart,
  handleJobsSetTileOverride,
  handleJobsTileThumbnail,
} from './ipc/jobs.js';
import { handleDataClearJobs, handleDataOpenFolder, handlePresetsOverrides, handlePresetsResetOverride, handlePresetsSaveOverride, handlePresetsShipped, type DataDeps } from './ipc/data.js';
import { handlePresetsList, handlePresetsSuggest } from './ipc/presets.js';
import { handleSessionsClear, handleSessionsOpen, handleSessionsStatus } from './ipc/sessions.js';
import { handleSettingsGet, handleSettingsSet } from './ipc/settings.js';
import { handleSlicerPlan } from './ipc/slicer.js';
import { createAssetRegistry } from './assetRegistry.js';
import { createDevFakeProvider, wantsDevFake } from './fakeProvider.js';
import { createJobService, type AdapterLease } from './jobService.js';
import { parseToolArgs, runProviderTool } from './providerTools.js';
import { createSettingsStore } from './settingsStore.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const smoke = process.argv.includes('--smoke');

// Smoke runs use a throwaway profile so they never touch (or depend on) real settings and logins.
if (smoke) app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'ie-smoke-profile-')));

// The Playwright e2e (and a packaged run on an isolated profile) can point the app at its own data folder too.
// Electron requires the folder to exist before it is made the user-data path.
const userDataOverride = process.env.IE_USER_DATA_DIR;
if (userDataOverride) {
  mkdirSync(userDataOverride, { recursive: true });
  app.setPath('userData', userDataOverride);
}

/** Sorting the dev fake's provider session: every provider is always ready, and opening one never opens a browser. */
function createDevFakeSessionManager(): SessionManager {
  const view = (partition: string): ProviderView => ({
    partition,
    setVisible: () => undefined,
    isVisible: () => false,
    loadURL: async () => undefined,
    evaluate: async <T>() => undefined as T,
    close: () => undefined,
  });
  return {
    async open(provider, opts) {
      const partition = partitionFor(provider);
      return { providerId: provider, partition, visible: opts?.visible ?? false, view: view(partition) };
    },
    openProviders: () => [],
    status: async () => 'ready',
    clear: async () => undefined,
  };
}

/** The dev fake has no login to watch, so its monitor is a no-op. */
function createDevFakeSessionMonitor(): SessionMonitor {
  return {
    start: () => undefined,
    stop: () => undefined,
    tick: async () => undefined,
    forget: () => undefined,
  };
}

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

// The developer tools do not need the GPU, and a wedged GPU cache would otherwise stall the provider pages.
if (process.argv.includes('--provider-tool')) app.disableHardwareAcceleration();

let mainWindow: BrowserWindow | undefined;

const EXPORT_FILTERS: Record<ExportFormat, string> = {
  png: 'PNG picture',
  jpeg: 'JPEG picture',
  webp: 'WebP picture',
};

/** Opens the native save dialog and returns the chosen path, or null when the person cancels. */
async function chooseExportDestination(request: ExportRequest): Promise<string | null> {
  const extension = request.format === 'jpeg' ? 'jpg' : request.format;
  const base = path.basename(request.imagePath, path.extname(request.imagePath)) || 'enhanced';
  const options = {
    title: 'Save the enhanced picture',
    defaultPath: path.join(app.getPath('pictures'), `${base}.${extension}`),
    filters: [{ name: EXPORT_FILTERS[request.format], extensions: [extension] }],
  };
  const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  return result.canceled || !result.filePath ? null : result.filePath;
}

function registerIpc(): void {
  const settings = createSettingsStore(path.join(app.getPath('userData'), 'settings.json'), app.getPath('userData'));
  if (smoke) settings.set({ firstRunAcknowledged: true, riskNoticeVersion: CURRENT_RISK_NOTICE_VERSION });

  const devFake = wantsDevFake(app.isPackaged);
  const manager = devFake ? createDevFakeSessionManager() : createSessionManager({
    backend: createElectronBackend(),
    healthProbe: createHealthProbe(),
    loginUrlFor: (provider) => providersConfig[provider].loginUrl,
  });
  const monitor = devFake ? createDevFakeSessionMonitor() : createSessionMonitor({
    manager,
    onStatus: (providerId, status) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sessions.status', { providerId, status });
      // A job paused for a check or login resumes by itself once the provider is fine again.
      jobs.onSessionStatus(providerId, status);
    },
  });
  if (!smoke && !devFake) monitor.start();
  const sessionDeps = { manager, monitor };

  ipcMain.handle('app.ping', (_event, payload: unknown) => {
    try {
      return handleAppPing(payload, app.getVersion());
    } catch (error) {
      return ipcError('internal', error instanceof Error ? error.message : 'unknown error');
    }
  });

  const assets = createAssetRegistry();

  // Jobs: saved in a database in the data folder, run in the background, reported to the window as events.
  const userData = app.getPath('userData');
  // The person's template edits live here; the shipped catalog files are never written.
  configureOverrides(path.join(userData, 'overrides'));
  const send = (channel: string, payload: unknown): void => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };
  // The dev fake keeps one adapter per provider for the profile: `IE_FAKE_MODES` is a sequence across resumes,
  // not a sequence that restarts every time a paused job continues.
  const devFakeAdapters = new Map<ProviderId, ProviderAdapter>();
  const adapterFor = async (providerId: ProviderId): Promise<AdapterLease> => {
    if (devFake) {
      let adapter = devFakeAdapters.get(providerId);
      if (!adapter) {
        adapter = createDevFakeProvider(userData);
        devFakeAdapters.set(providerId, adapter);
      }
      return { adapter };
    }
    // Watch mode keeps the provider window on screen; otherwise it opens only when it needs the person.
    const opened = await manager.open(providerId, { visible: settings.get().watchMode });
    const driver = new ElectronPageDriver(opened.view.native);
    const saveImage = createImageSaver(path.join(userData, 'provider-downloads', providerId), `${providerId}-result`);
    const adapter: ProviderAdapter = providerId === 'gemini' ? createGeminiAdapter({ driver, saveImage, reuseChat: true }) : providerId === 'gpt' ? createGptAdapter({ driver, saveImage, reuseChat: true }) : createGrokAdapter({ driver, saveImage, reuseChat: true });
    return { adapter, release: () => driver.dispose() };
  };
  const autoResumeMs = Number(process.env.IE_FAKE_AUTO_RESUME_MS ?? 3000);
  const jobs = createJobService({
    store: openStore(path.join(userData, 'jobs.sqlite'), { onCommit: (change) => jobs.notify(change) }),
    dataDir: userData,
    // The fake provider has nothing to pace: an e2e (and a person watching a fake run) should not wait 8-25 s per tile.
    pacing: () => (devFake ? { concurrency: 1, minDelayMs: 0, maxDelayMs: 0 } : PACING_PRESETS[settings.get().pacingPreset]),
    adapterFor,
    sessionStatus: devFake ? async () => 'ready' : (providerId) => manager.status(providerId),
    // The e2e keeps a pause on screen long enough to press Resume; normal fake runs auto-resume as usual.
    ...(devFake ? { autoResume: { settleMs: Number.isFinite(autoResumeMs) ? autoResumeMs : 3000 } } : {}),
    // The window comes forward only when a real provider needs the person; the dev fake has nothing to show.
    ...(devFake ? {} : { showProvider: async (providerId: ProviderId) => void (await manager.open(providerId, { visible: true })) }),
    // And goes back to how they want it (hidden unless Watch mode is on) when the job carries on.
    ...(devFake ? {} : { restoreWindow: async (providerId: ProviderId) => void (await manager.open(providerId, { visible: settings.get().watchMode })) }),
    emitProgress: (progress) => send('jobs.progress', progress),
    emitLog: (log) => send('jobs.log', log),
  });
  // Jobs that were running when the app last closed are put back in a state they can continue from.
  jobs.restore();

  ipcMain.handle('intake.import', (_event, payload: unknown) => handleIntakeImport(payload, undefined, assets));
  ipcMain.handle('intake.createJob', (_event, payload: unknown) => handleCreateAndRegisterJob(payload, assets, jobs));
  ipcMain.handle('jobs.start', (_event, payload: unknown) => handleJobsStart(payload, jobs));
  ipcMain.handle('jobs.pause', (_event, payload: unknown) => handleJobsPause(payload, jobs));
  ipcMain.handle('jobs.resume', (_event, payload: unknown) => handleJobsResume(payload, jobs));
  ipcMain.handle('jobs.cancel', (_event, payload: unknown) => handleJobsCancel(payload, jobs));
  ipcMain.handle('jobs.get', (_event, payload: unknown) => handleJobsGet(payload, jobs));
  ipcMain.handle('jobs.listRecent', (_event, payload: unknown) => handleJobsListRecent(payload, jobs));
  ipcMain.handle('jobs.acceptTile', (_event, payload: unknown) => handleJobsAcceptTile(payload, jobs));
  ipcMain.handle('jobs.rerunTile', (_event, payload: unknown) => handleJobsRerunTile(payload, jobs));
  ipcMain.handle('jobs.setTileOverride', (_event, payload: unknown) => handleJobsSetTileOverride(payload, jobs));
  ipcMain.handle('jobs.result', (_event, payload: unknown) => handleJobsResult(payload, jobs));
  ipcMain.handle('jobs.finishReview', (_event, payload: unknown) => handleJobsFinishReview(payload, jobs));
  ipcMain.handle('jobs.costPreview', (_event, payload: unknown) => handleJobsCostPreview(payload, jobs));
  ipcMain.handle('jobs.tileThumbnail', (_event, payload: unknown) => handleJobsTileThumbnail(payload, jobs));
  ipcMain.handle('export.save', (_event, payload: unknown) => handleExportSave(payload, jobs, chooseExportDestination));
  ipcMain.handle('intake.preview', (_event, payload: unknown) => handleIntakePreview(payload, assets));
  ipcMain.handle('slicer.plan', (_event, payload: unknown) => handleSlicerPlan(payload, assets));
  ipcMain.handle('presets.list', () => handlePresetsList());
  ipcMain.handle('presets.overrides', () => handlePresetsOverrides());
  ipcMain.handle('presets.shipped', (_event, payload: unknown) => handlePresetsShipped(payload));
  ipcMain.handle('presets.saveOverride', (_event, payload: unknown) => handlePresetsSaveOverride(payload));
  ipcMain.handle('presets.resetOverride', (_event, payload: unknown) => handlePresetsResetOverride(payload));
  const dataDeps: DataDeps = {
    dataFolder: () => userData,
    openFolder: (folder) => shell.openPath(folder),
    confirmClear: async () => {
      const options = {
        type: 'warning' as const,
        buttons: ['Delete all job data', 'Keep it'],
        defaultId: 1,
        cancelId: 1,
        message: 'Delete all job data?',
        detail: 'Every job, its tiles and its finished pictures will be removed. Pictures you already saved elsewhere are not touched. This cannot be undone.',
      };
      const result = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
      return result.response === 0;
    },
    clearJobs: () => jobs.clearAll(),
  };
  ipcMain.handle('data.openFolder', () => handleDataOpenFolder(dataDeps));
  ipcMain.handle('data.clearJobs', () => handleDataClearJobs(dataDeps));
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
    await rm(file, { force: true }).catch(() => undefined);
  }
}

/**
 * Runs a small job end to end with the fake provider inside the packaged runtime: the SQLite store, the orchestrator,
 * the tile pipeline and the stitcher, exactly as a real run would use them. Proves they all work in this build.
 */
async function smokeJobs(): Promise<boolean> {
  const dir = path.join(app.getPath('temp'), `ie-smoke-jobs-${process.pid}`);
  try {
    await mkdir(dir, { recursive: true });
    const source = path.join(dir, 'source.png');
    const data = Buffer.alloc(800 * 400 * 3);
    for (let y = 0; y < 400; y++) for (let x = 0; x < 800; x++) data.set([128 + 90 * Math.sin(x / 31), 110 + 70 * Math.cos(y / 23), 120 + 60 * Math.sin((x + y) / 41)], (y * 800 + x) * 3);
    await sharp(data, { raw: { width: 800, height: 400, channels: 3 } }).png().toFile(source);

    let service!: ReturnType<typeof createJobService>;
    const store = openStore(path.join(dir, 'jobs.sqlite'), { onCommit: (change) => service.notify(change) });
    try {
      service = createJobService({
        store,
        dataDir: dir,
        adapterFor: async () => ({ adapter: createDevFakeProvider(dir, { IE_FAKE_DELAY_MS: '0' }) }),
        sessionStatus: async () => 'ready',
        emitProgress: () => {},
        emitLog: () => {},
        runOptions: { sleep: async () => {} },
      });
      service.register({
        id: 'SMOKE',
        createdAt: new Date().toISOString(),
        source: { path: source, width: 800, height: 400, sha256: '0'.repeat(64) },
        prompt: 'Enhance this tile.',
        promptSource: 'user',
        categoryId: 'env-realistic',
        categorySource: 'user',
        grid: { rows: 1, cols: 4, overlapPct: 15 },
        providerId: 'gemini',
      });
      await service.start('SMOKE');
      await service.whenIdle();
      const finished = service.get('SMOKE');
      if (finished.state !== 'done' || finished.completedTiles !== 4) return false;

      // Exporting is part of the release check: prove all three formats are written at the finished picture's size.
      // The file is read into memory first: on Windows, a sharp instance reading a file by path can keep the file
      // handle open, which would block the cleanup below.
      const result = await service.result('SMOKE');
      for (const format of ['png', 'jpeg', 'webp'] as const) {
        const destination = path.join(dir, `export.${format}`);
        const saved = await service.save({ imagePath: result.imagePath, format, destination });
        const meta = await sharp(readFileSync(saved.path)).metadata();
        if (meta.width !== result.width || meta.height !== result.height) return false;
      }
      return true;
    } finally {
      store.close();
    }
  } finally {
    // Windows can keep a freshly written file locked for a moment (antivirus, indexing); a leftover temp folder
    // must never turn a passing smoke into a failure.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
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
        void Promise.all([win.webContents.executeJavaScript('document.body.innerText'), smokeImport(), smokeJobs()])
          .then(([text, importOk, jobsOk]: [string, boolean, boolean]) => {
            const ok = text.includes('Main process ready') && importOk && jobsOk;
            console.log(ok ? 'SMOKE_OK' : `SMOKE_FAIL: importOk=${importOk} jobsOk=${jobsOk} text=${text}`);
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

  // Developer tools against the real provider sessions in this profile: no app window, no IPC.
  if (process.argv.includes('--provider-tool')) {
    const parsed = parseToolArgs(process.argv);
    if (typeof parsed === 'string') {
      console.log(`[provider-tool] ${parsed}`);
      app.exit(64);
      return;
    }
    void runProviderTool(parsed).then(
      (code) => app.exit(code),
      (error: unknown) => {
        console.log(`[provider-tool] crashed: ${error instanceof Error ? error.message : String(error)}`);
        app.exit(1);
      },
    );
    return;
  }

  registerIpc();
  mainWindow = createWindow();
});
