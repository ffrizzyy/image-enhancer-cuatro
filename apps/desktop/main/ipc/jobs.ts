import { parseIpcRequest, parseIpcResponse, type IpcRequest, type IpcResponse } from '@ie/contracts';

import type { AssetRegistry } from '../assetRegistry.js';
import { JobServiceError, type JobService } from '../jobService.js';
import { handleIntakeCreateJob } from './intake.js';
import { ipcError, type IpcResult } from './app.js';

function toIpcError(error: unknown): IpcResult<never> {
  if (error instanceof JobServiceError) return ipcError('invalid_request', error.message);
  return ipcError('internal', error instanceof Error ? error.message : 'unknown error');
}

type JobChannel = 'jobs.pause' | 'jobs.resume' | 'jobs.cancel' | 'jobs.get';

/** Validates a `{ jobId }` request, runs the action, and validates the progress it returns. */
async function jobAction(channel: JobChannel, payload: unknown, run: (jobId: string) => Promise<IpcResponse<JobChannel>> | IpcResponse<JobChannel>): Promise<IpcResult<IpcResponse<JobChannel>>> {
  const request = parseIpcRequest(channel, payload);
  if (!request.ok) return ipcError('invalid_request', request.error);
  try {
    const result = await run((request.value as IpcRequest<'jobs.get'>).jobId);
    const response = parseIpcResponse(channel, result);
    return response.ok ? { ok: true, value: response.value } : ipcError('invalid_response', response.error);
  } catch (error) {
    return toIpcError(error);
  }
}

/** `jobs.start` replies with just the job id and where it is; everything else arrives as `jobs.progress` events. */
export async function handleJobsStart(payload: unknown, service: JobService): Promise<IpcResult<IpcResponse<'jobs.start'>>> {
  const request = parseIpcRequest('jobs.start', payload);
  if (!request.ok) return ipcError('invalid_request', request.error);
  try {
    const progress = await service.start(request.value.jobId);
    const response = parseIpcResponse('jobs.start', { jobId: progress.jobId, state: progress.state });
    return response.ok ? { ok: true, value: response.value } : ipcError('invalid_response', response.error);
  } catch (error) {
    return toIpcError(error);
  }
}
export const handleJobsPause = (payload: unknown, service: JobService) => jobAction('jobs.pause', payload, (id) => service.pause(id)) as Promise<IpcResult<IpcResponse<'jobs.get'>>>;
export const handleJobsResume = (payload: unknown, service: JobService) => jobAction('jobs.resume', payload, (id) => service.resume(id)) as Promise<IpcResult<IpcResponse<'jobs.get'>>>;
export const handleJobsCancel = (payload: unknown, service: JobService) => jobAction('jobs.cancel', payload, (id) => service.cancel(id)) as Promise<IpcResult<IpcResponse<'jobs.get'>>>;
export const handleJobsGet = (payload: unknown, service: JobService) => jobAction('jobs.get', payload, (id) => service.get(id)) as Promise<IpcResult<IpcResponse<'jobs.get'>>>;

type TileChannel = 'jobs.acceptTile' | 'jobs.rerunTile';

async function tileAction(channel: TileChannel, payload: unknown, run: (jobId: string, index: number) => Promise<IpcResponse<'jobs.get'>> | IpcResponse<'jobs.get'>): Promise<IpcResult<IpcResponse<'jobs.get'>>> {
  const request = parseIpcRequest(channel, payload);
  if (!request.ok) return ipcError('invalid_request', request.error);
  try {
    const response = parseIpcResponse(channel, await run(request.value.jobId, request.value.index));
    return response.ok ? { ok: true, value: response.value } : ipcError('invalid_response', response.error);
  } catch (error) {
    return toIpcError(error);
  }
}

/** Review: keep a tile that was set aside exactly as it came back. */
export const handleJobsAcceptTile = (payload: unknown, service: JobService) => tileAction('jobs.acceptTile', payload, (id, index) => service.acceptTile(id, index));
/** Review: generate a tile again, with a fresh set of retries. */
export const handleJobsRerunTile = (payload: unknown, service: JobService) => tileAction('jobs.rerunTile', payload, (id, index) => service.rerunTile(id, index));

/** Review: change one tile's prompt or source picture before it is run again. */
export async function handleJobsSetTileOverride(payload: unknown, service: JobService): Promise<IpcResult<IpcResponse<'jobs.setTileOverride'>>> {
  const request = parseIpcRequest('jobs.setTileOverride', payload);
  if (!request.ok) return ipcError('invalid_request', request.error);
  try {
    const progress = await service.setTileOverride(request.value.jobId, request.value.index, {
      ...(request.value.prompt !== undefined ? { prompt: request.value.prompt } : {}),
      ...(request.value.sourcePath !== undefined ? { sourcePath: request.value.sourcePath } : {}),
    });
    const response = parseIpcResponse('jobs.setTileOverride', progress);
    return response.ok ? { ok: true, value: response.value } : ipcError('invalid_response', response.error);
  } catch (error) {
    return toIpcError(error);
  }
}

/** Everything the Result screen shows for a finished job. */
export async function handleJobsResult(payload: unknown, service: JobService): Promise<IpcResult<IpcResponse<'jobs.result'>>> {
  const request = parseIpcRequest('jobs.result', payload);
  if (!request.ok) return ipcError('invalid_request', request.error);
  try {
    const result = await service.result(request.value.jobId, request.value.maxSide);
    const response = parseIpcResponse('jobs.result', result);
    return response.ok ? { ok: true, value: response.value } : ipcError('invalid_response', response.error);
  } catch (error) {
    return toIpcError(error);
  }
}

/** Review: every tile is settled, so put the picture together. */
export async function handleJobsFinishReview(payload: unknown, service: JobService): Promise<IpcResult<IpcResponse<'jobs.get'>>> {
  const request = parseIpcRequest('jobs.finishReview', payload);
  if (!request.ok) return ipcError('invalid_request', request.error);
  try {
    const response = parseIpcResponse('jobs.finishReview', await service.finishReview(request.value.jobId));
    return response.ok ? { ok: true, value: response.value } : ipcError('invalid_response', response.error);
  } catch (error) {
    return toIpcError(error);
  }
}
export function handleJobsListRecent(payload: unknown, service: JobService): IpcResult<IpcResponse<'jobs.listRecent'>> {
  const request = parseIpcRequest('jobs.listRecent', payload ?? {});
  if (!request.ok) return ipcError('invalid_request', request.error);
  try {
    const response = parseIpcResponse('jobs.listRecent', service.listRecent(request.value.limit));
    return response.ok ? { ok: true, value: response.value } : ipcError('invalid_response', response.error);
  } catch (error) {
    return toIpcError(error);
  }
}

export function handleJobsCostPreview(payload: unknown, service: JobService): IpcResult<IpcResponse<'jobs.costPreview'>> {
  const request = parseIpcRequest('jobs.costPreview', payload);
  if (!request.ok) return ipcError('invalid_request', request.error);
  try {
    const response = parseIpcResponse('jobs.costPreview', service.costPreview(request.value.providerId, request.value.tileCount));
    return response.ok ? { ok: true, value: response.value } : ipcError('invalid_response', response.error);
  } catch (error) {
    return toIpcError(error);
  }
}

export async function handleJobsTileThumbnail(payload: unknown, service: JobService): Promise<IpcResult<IpcResponse<'jobs.tileThumbnail'>>> {
  const request = parseIpcRequest('jobs.tileThumbnail', payload);
  if (!request.ok) return ipcError('invalid_request', request.error);
  try {
    const response = parseIpcResponse('jobs.tileThumbnail', await service.tileThumbnail(request.value.jobId, request.value.index, request.value.maxSide));
    return response.ok ? { ok: true, value: response.value } : ipcError('invalid_response', response.error);
  } catch (error) {
    return toIpcError(error);
  }
}

/**
 * `intake.createJob`, and then the job is saved with its tile plan so Start can run it and a restart does not lose it.
 * The job is only created in the job store here, when the user presses Start on Setup.
 */
export function handleCreateAndRegisterJob(payload: unknown, registry: AssetRegistry, service: JobService): IpcResult<IpcResponse<'intake.createJob'>> {
  const created = handleIntakeCreateJob(payload, registry);
  if (!created.ok) return created;
  try {
    service.register(created.value);
  } catch (error) {
    return ipcError('internal', `The job could not be saved: ${error instanceof Error ? error.message : String(error)}`);
  }
  return created;
}
