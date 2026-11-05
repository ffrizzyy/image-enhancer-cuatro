import { contextBridge, ipcRenderer, webUtils } from 'electron';

import type { IpcEvents, IpcRequest, IpcResponse } from '@ie/contracts';

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

export interface IeApi {
  app: {
    ping(): Promise<IpcResult<IpcResponse<'app.ping'>>>;
  };
  intake: {
    import(path: IpcRequest<'intake.import'>['path']): Promise<IpcResult<IpcResponse<'intake.import'>>>;
    /** The only way a Job is created; called when the user presses Start. */
    createJob(request: IpcRequest<'intake.createJob'>): Promise<IpcResult<IpcResponse<'intake.createJob'>>>;
    /** A downscaled picture of an imported image, to draw the tile grid over. */
    preview(request: IpcRequest<'intake.preview'>): Promise<IpcResult<IpcResponse<'intake.preview'>>>;
  };
  slicer: {
    /** The exact tile plan for the current grid; pure, never calls a provider. */
    plan(request: IpcRequest<'slicer.plan'>): Promise<IpcResult<IpcResponse<'slicer.plan'>>>;
  };
  jobs: {
    /** Starts the pre-run checks and the run in the background; progress arrives through `onProgress`. */
    start(jobId: string): Promise<IpcResult<IpcResponse<'jobs.start'>>>;
    pause(jobId: string): Promise<IpcResult<IpcResponse<'jobs.pause'>>>;
    resume(jobId: string): Promise<IpcResult<IpcResponse<'jobs.resume'>>>;
    cancel(jobId: string): Promise<IpcResult<IpcResponse<'jobs.cancel'>>>;
    get(jobId: string): Promise<IpcResult<IpcResponse<'jobs.get'>>>;
    listRecent(limit?: number): Promise<IpcResult<IpcResponse<'jobs.listRecent'>>>;
    /** Review: keep a tile that was set aside exactly as it came back. */
    acceptTile(jobId: string, index: number): Promise<IpcResult<IpcResponse<'jobs.acceptTile'>>>;
    /** Review: generate a tile again with a fresh set of retries. */
    rerunTile(jobId: string, index: number): Promise<IpcResult<IpcResponse<'jobs.rerunTile'>>>;
    /** Review: every tile is settled, so put the picture together. */
    finishReview(jobId: string): Promise<IpcResult<IpcResponse<'jobs.finishReview'>>>;
    /** What a run of this many tiles would cost, before any job exists. */
    costPreview(request: IpcRequest<'jobs.costPreview'>): Promise<IpcResult<IpcResponse<'jobs.costPreview'>>>;
    tileThumbnail(request: IpcRequest<'jobs.tileThumbnail'>): Promise<IpcResult<IpcResponse<'jobs.tileThumbnail'>>>;
    /** Live job progress, pushed whenever a job or one of its tiles changes. Returns an unsubscribe function. */
    onProgress(listener: (event: IpcEvents['jobs.progress']) => void): () => void;
    onLog(listener: (event: IpcEvents['jobs.log']) => void): () => void;
  };
  presets: {
    list(): Promise<IpcResult<IpcResponse<'presets.list'>>>;
    /** Local, offline category suggestion for an imported image; never calls a provider. */
    suggestCategory(request: IpcRequest<'presets.suggestCategory'>): Promise<IpcResult<IpcResponse<'presets.suggestCategory'>>>;
  };
  files: {
    /** Absolute path of a dropped or picked File (the renderer cannot read `File.path`). */
    pathFor(file: File): string;
  };
  sessions: {
    open(
      providerId: IpcRequest<'sessions.open'>['providerId'],
      visible: boolean,
    ): Promise<IpcResult<IpcResponse<'sessions.open'>>>;
    status(providerId: IpcRequest<'sessions.status'>['providerId']): Promise<IpcResult<IpcResponse<'sessions.status'>>>;
    clear(providerId: IpcRequest<'sessions.clear'>['providerId']): Promise<IpcResult<IpcResponse<'sessions.clear'>>>;
    /** Subscribes to live status changes; returns an unsubscribe function. */
    onStatus(listener: (event: IpcEvents['sessions.status']) => void): () => void;
  };
  settings: {
    get(): Promise<IpcResult<IpcResponse<'settings.get'>>>;
    set(patch: IpcRequest<'settings.set'>): Promise<IpcResult<IpcResponse<'settings.set'>>>;
  };
}

const invoke = <T>(channel: string, payload?: unknown) => ipcRenderer.invoke(channel, payload) as Promise<IpcResult<T>>;

const api: IeApi = {
  app: {
    ping: () => invoke('app.ping'),
  },
  intake: {
    import: (path) => invoke('intake.import', { path }),
    createJob: (request) => invoke('intake.createJob', request),
    preview: (request) => invoke('intake.preview', request),
  },
  slicer: {
    plan: (request) => invoke('slicer.plan', request),
  },
  jobs: {
    start: (jobId) => invoke('jobs.start', { jobId }),
    pause: (jobId) => invoke('jobs.pause', { jobId }),
    resume: (jobId) => invoke('jobs.resume', { jobId }),
    cancel: (jobId) => invoke('jobs.cancel', { jobId }),
    get: (jobId) => invoke('jobs.get', { jobId }),
    listRecent: (limit) => invoke('jobs.listRecent', limit === undefined ? {} : { limit }),
    acceptTile: (jobId, index) => invoke('jobs.acceptTile', { jobId, index }),
    rerunTile: (jobId, index) => invoke('jobs.rerunTile', { jobId, index }),
    finishReview: (jobId) => invoke('jobs.finishReview', { jobId }),
    costPreview: (request) => invoke('jobs.costPreview', request),
    tileThumbnail: (request) => invoke('jobs.tileThumbnail', request),
    onProgress: (listener) => {
      const handler = (_event: unknown, payload: IpcEvents['jobs.progress']) => listener(payload);
      ipcRenderer.on('jobs.progress', handler);
      return () => ipcRenderer.removeListener('jobs.progress', handler);
    },
    onLog: (listener) => {
      const handler = (_event: unknown, payload: IpcEvents['jobs.log']) => listener(payload);
      ipcRenderer.on('jobs.log', handler);
      return () => ipcRenderer.removeListener('jobs.log', handler);
    },
  },
  presets: {
    list: () => invoke('presets.list'),
    suggestCategory: (request) => invoke('presets.suggestCategory', request),
  },
  files: {
    pathFor: (file) => webUtils.getPathForFile(file),
  },
  sessions: {
    open: (providerId, visible) => invoke('sessions.open', { providerId, visible }),
    status: (providerId) => invoke('sessions.status', { providerId }),
    clear: (providerId) => invoke('sessions.clear', { providerId }),
    onStatus: (listener) => {
      const handler = (_event: unknown, payload: IpcEvents['sessions.status']) => listener(payload);
      ipcRenderer.on('sessions.status', handler);
      return () => ipcRenderer.removeListener('sessions.status', handler);
    },
  },
  settings: {
    get: () => invoke('settings.get'),
    set: (patch) => invoke('settings.set', patch),
  },
};

// The only surface exposed to the renderer.
contextBridge.exposeInMainWorld('ie', api);
