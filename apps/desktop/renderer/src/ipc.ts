import type { ProviderId } from '@ie/contracts';

import type { IeApi } from '../../preload/index';

declare global {
  interface Window {
    ie: IeApi;
  }
}

/**
 * Typed IPC client. The only renderer path to the main process; it reads
 * `window.ie` lazily so tests can install a fake bridge.
 */
export const ipc = {
  app: {
    ping: () => window.ie.app.ping(),
  },
  intake: {
    import: (path: string) => window.ie.intake.import(path),
    createJob: (request: Parameters<IeApi['intake']['createJob']>[0]) => window.ie.intake.createJob(request),
    preview: (request: Parameters<IeApi['intake']['preview']>[0]) => window.ie.intake.preview(request),
  },
  slicer: {
    plan: (request: Parameters<IeApi['slicer']['plan']>[0]) => window.ie.slicer.plan(request),
  },
  jobs: {
    start: (jobId: string) => window.ie.jobs.start(jobId),
    pause: (jobId: string) => window.ie.jobs.pause(jobId),
    resume: (jobId: string) => window.ie.jobs.resume(jobId),
    cancel: (jobId: string) => window.ie.jobs.cancel(jobId),
    get: (jobId: string) => window.ie.jobs.get(jobId),
    listRecent: (limit?: number) => window.ie.jobs.listRecent(limit),
    acceptTile: (jobId: string, index: number) => window.ie.jobs.acceptTile(jobId, index),
    rerunTile: (jobId: string, index: number) => window.ie.jobs.rerunTile(jobId, index),
    setTileOverride: (jobId: string, index: number, patch: Parameters<IeApi['jobs']['setTileOverride']>[2]) => window.ie.jobs.setTileOverride(jobId, index, patch),
    result: (request: Parameters<IeApi['jobs']['result']>[0]) => window.ie.jobs.result(request),
    finishReview: (jobId: string) => window.ie.jobs.finishReview(jobId),
    costPreview: (request: Parameters<IeApi['jobs']['costPreview']>[0]) => window.ie.jobs.costPreview(request),
    tileThumbnail: (request: Parameters<IeApi['jobs']['tileThumbnail']>[0]) => window.ie.jobs.tileThumbnail(request),
    onProgress: (listener: Parameters<IeApi['jobs']['onProgress']>[0]) => window.ie.jobs.onProgress(listener),
    onLog: (listener: Parameters<IeApi['jobs']['onLog']>[0]) => window.ie.jobs.onLog(listener),
  },
  export: {
    save: (request: Parameters<IeApi['export']['save']>[0]) => window.ie.export.save(request),
  },
  presets: {
    list: () => window.ie.presets.list(),
    suggestCategory: (request: Parameters<IeApi['presets']['suggestCategory']>[0]) => window.ie.presets.suggestCategory(request),
  },
  files: {
    pathFor: (file: File) => window.ie.files.pathFor(file),
  },
  sessions: {
    open: (providerId: ProviderId, visible: boolean) => window.ie.sessions.open(providerId, visible),
    status: (providerId: ProviderId) => window.ie.sessions.status(providerId),
    clear: (providerId: ProviderId) => window.ie.sessions.clear(providerId),
    onStatus: (listener: Parameters<IeApi['sessions']['onStatus']>[0]) => window.ie.sessions.onStatus(listener),
  },
  settings: {
    get: () => window.ie.settings.get(),
    set: (patch: Parameters<IeApi['settings']['set']>[0]) => window.ie.settings.set(patch),
  },
};
