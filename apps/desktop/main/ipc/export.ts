import { parseIpcRequest, parseIpcResponse, type ExportRequest, type IpcResponse } from '@ie/contracts';

import { JobServiceError, type JobService } from '../jobService.js';
import { ipcError, type IpcResult } from './app.js';

/** Asks the person where to put the file (the main process owns the save dialog). Null means they cancelled. */
export type DestinationChooser = (request: ExportRequest) => Promise<string | null>;

/**
 * `export.save`: writes the finished picture in PNG, JPEG or WebP. The renderer never chooses a destination by itself;
 * it comes from the save dialog, and a cancelled dialog is reported as a typed `cancelled` result, not an error.
 */
export async function handleExportSave(
  payload: unknown,
  service: JobService,
  chooseDestination: DestinationChooser,
): Promise<IpcResult<IpcResponse<'export.save'>>> {
  const request = parseIpcRequest('export.save', payload);
  if (!request.ok) return ipcError('invalid_request', request.error);
  try {
    const destination = request.value.destination ?? (await chooseDestination(request.value));
    if (!destination) return ipcError('cancelled', 'Saving was cancelled.');
    const response = parseIpcResponse('export.save', await service.save({ ...request.value, destination }));
    return response.ok ? { ok: true, value: response.value } : ipcError('invalid_response', response.error);
  } catch (error) {
    if (error instanceof JobServiceError) return ipcError('invalid_request', error.message);
    return ipcError('internal', error instanceof Error ? error.message : 'unknown error');
  }
}
