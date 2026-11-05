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
