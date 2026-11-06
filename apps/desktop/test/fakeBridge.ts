import { CURRENT_RISK_NOTICE_VERSION, IPC_VERSION, type AppSettings, type SessionStatus } from '@ie/contracts';
import { listCategories } from '@ie/presets';
import { planTiles } from '@ie/slicer';
import { vi } from 'vitest';

import type { IeApi } from '../preload/index';
import { emptyDraft } from '../renderer/src/draft';
import { useShellStore } from '../renderer/src/store';

export const acknowledgedSettings: AppSettings = {
  firstRunAcknowledged: true,
  pacingPreset: 'safe',
  dataFolder: 'C:\\data',
  watchMode: false,
  riskNoticeVersion: CURRENT_RISK_NOTICE_VERSION,
};

type StatusListener = Parameters<IeApi['sessions']['onStatus']>[0];
type ProgressListener = Parameters<IeApi['jobs']['onProgress']>[0];
type LogListener = Parameters<IeApi['jobs']['onLog']>[0];

/** Installs a fake `window.ie` with sensible defaults; override any member per test. */
export function installBridge(overrides: { settings?: AppSettings } = {}) {
  const listeners = new Set<StatusListener>();
  const progressListeners = new Set<ProgressListener>();
  const logListeners = new Set<LogListener>();
  const bridge = {
    ping: vi.fn(),
    importImage: vi.fn(),
    createJob: vi.fn(),
    plan: vi.fn(),
    preview: vi.fn(),
    startJob: vi.fn(),
    pauseJob: vi.fn(),
    resumeJob: vi.fn(),
    cancelJob: vi.fn(),
    getJob: vi.fn(),
    listRecent: vi.fn(),
    tileThumbnail: vi.fn(),
    costPreview: vi.fn(),
    acceptTile: vi.fn(),
    rerunTile: vi.fn(),
    setTileOverride: vi.fn(),
    result: vi.fn(),
    finishReview: vi.fn(),
    saveExport: vi.fn(),
    listPresets: vi.fn(),
    suggest: vi.fn(),
    pathFor: vi.fn(),
    open: vi.fn(),
    status: vi.fn(),
    clear: vi.fn(),
    getSettings: vi.fn(),
    setSettings: vi.fn(),
    /** Pushes a live status event to subscribers, like the main-process monitor does. */
    emitStatus: (providerId: 'gpt' | 'gemini' | 'grok', status: SessionStatus) =>
      listeners.forEach((listener) => listener({ providerId, status })),
    listenerCount: () => listeners.size,
    /** Pushes a live job progress event, like the main process does. */
    emitProgress: (progress: Parameters<ProgressListener>[0]) => progressListeners.forEach((listener) => listener(progress)),
    emitLog: (log: Parameters<LogListener>[0]) => logListeners.forEach((listener) => listener(log)),
    progressListenerCount: () => progressListeners.size,
  };

  bridge.ping.mockResolvedValue({ ok: true, value: { version: '0.1.0', ipcVersion: IPC_VERSION } });
  bridge.open.mockImplementation(async (providerId: string, visible: boolean) => ({
    ok: true,
    value: { providerId, partition: `persist:${providerId}`, visible },
  }));
  bridge.listPresets.mockResolvedValue({ ok: true, value: listCategories() });
  bridge.suggest.mockResolvedValue({
    ok: true,
    value: {
      categoryId: 'env-realistic',
      confidence: 0.8,
      alternatives: [
        { categoryId: 'landscape-matte', confidence: 0.3 },
        { categoryId: 'architecture-interior', confidence: 0.2 },
        { categoryId: 'props-realistic', confidence: 0.1 },
      ],
      signals: ['Looks photographic (many colours, natural noise)'],
      lowConfidence: false,
    },
  });
  // The real slicer, for the asset the test has put in the store.
  bridge.plan.mockImplementation(async (request: { grid: { rows: number; cols: number }; overlapPct: number; wrap?: boolean }) => {
    const asset = useShellStore.getState().asset;
    if (!asset) return { ok: false, error: { code: 'invalid_request', message: 'That image is no longer available. Import it again.' } };
    return {
      ok: true,
      value: planTiles({ width: asset.width, height: asset.height, rows: request.grid.rows, cols: request.grid.cols, overlapPct: request.overlapPct, wrap: request.wrap ?? false }),
    };
  });
  bridge.preview.mockImplementation(async () => ({ ok: true, value: { dataUrl: 'data:image/jpeg;base64,AAAA', width: 400, height: 300 } }));
  bridge.startJob.mockImplementation(async (jobId: string) => ({ ok: true, value: { jobId, state: 'preflight' } }));
  bridge.listRecent.mockImplementation(async () => ({ ok: true, value: useShellStore.getState().recentJobs }));
  bridge.tileThumbnail.mockResolvedValue({ ok: true, value: { dataUrl: 'data:image/jpeg;base64,BBBB', width: 160, height: 120 } });
  bridge.saveExport.mockResolvedValue({ ok: true, value: { path: 'C:\\Pictures\\enhanced.png', width: 800, height: 400 } });
  bridge.costPreview.mockImplementation(async (request: { providerId: string; tileCount: number }) => ({
    ok: true,
    value: { tiles: request.tileCount, estimatedMinutes: Math.max(1, Math.round(request.tileCount * 0.6)), quotaNote: `This run makes ${request.tileCount} image generation${request.tileCount === 1 ? '' : 's'} on your ${request.providerId} account, plus any retries.` },
  }));
  bridge.status.mockResolvedValue({ ok: true, value: 'unknown' });
  bridge.clear.mockResolvedValue({ ok: true, value: { cleared: true } });
  bridge.getSettings.mockResolvedValue({ ok: true, value: overrides.settings ?? acknowledgedSettings });
  bridge.setSettings.mockImplementation(async (patch: Partial<AppSettings>) => ({
    ok: true,
    value: { ...(overrides.settings ?? acknowledgedSettings), ...patch, riskNoticeVersion: CURRENT_RISK_NOTICE_VERSION },
  }));

  window.ie = {
    app: { ping: bridge.ping },
    intake: { import: bridge.importImage, createJob: bridge.createJob, preview: bridge.preview },
    slicer: { plan: bridge.plan },
    jobs: {
      start: bridge.startJob,
      pause: bridge.pauseJob,
      resume: bridge.resumeJob,
      cancel: bridge.cancelJob,
      get: bridge.getJob,
      listRecent: bridge.listRecent,
      tileThumbnail: bridge.tileThumbnail,
      costPreview: bridge.costPreview,
      acceptTile: bridge.acceptTile,
      rerunTile: bridge.rerunTile,
      setTileOverride: bridge.setTileOverride,
      result: bridge.result,
      finishReview: bridge.finishReview,
      onProgress: (listener) => {
        progressListeners.add(listener);
        return () => progressListeners.delete(listener);
      },
      onLog: (listener) => {
        logListeners.add(listener);
        return () => logListeners.delete(listener);
      },
    },
    presets: { list: bridge.listPresets, suggestCategory: bridge.suggest },
    export: { save: bridge.saveExport },
    files: { pathFor: bridge.pathFor },
    sessions: {
      open: bridge.open,
      status: bridge.status,
      clear: bridge.clear,
      onStatus: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    settings: { get: bridge.getSettings, set: bridge.setSettings },
  };

  useShellStore.setState({
    route: 'home',
    ping: { status: 'idle' },
    settings: null,
    settingsError: null,
    providers: { gpt: 'unknown', gemini: 'unknown', grok: 'unknown' },
    providerError: null,
    asset: null,
    importing: false,
    importError: null,
    recentJobs: [],
    categories: [],
    categoriesError: null,
    draft: emptyDraft(),
    detection: { status: 'idle' },
    plan: { status: 'idle' },
    cost: { status: 'idle' },
    preview: null,
    previewError: null,
    job: null,
    starting: false,
    startError: null,
    activeJobId: null,
    progress: {},
    jobLog: {},
    runError: null,
    result: { status: 'idle' },
  });

  return bridge;
}
