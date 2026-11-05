import { parseIpcRequest, parseIpcResponse, type IpcResponse } from '@ie/contracts';
import { createJob, importImage, IntakeError } from '@ie/intake';
import sharp from 'sharp';

import type { AssetRegistry } from '../assetRegistry.js';
import { ipcError, type IpcResult } from './app.js';

/**
 * `intake.import` handler. Validates the request, imports the file (read-only),
 * and maps intake failures to their specific codes so the UI can show the real reason.
 * The importer is injectable so the handler is unit-testable.
 */
export async function handleIntakeImport(
  payload: unknown,
  importFn: typeof importImage = importImage,
  registry?: AssetRegistry,
): Promise<IpcResult<IpcResponse<'intake.import'>>> {
  const request = parseIpcRequest('intake.import', payload);
  if (!request.ok) return ipcError('invalid_request', request.error);

  let asset;
  try {
    asset = await importFn(request.value.path);
  } catch (error) {
    if (error instanceof IntakeError) return ipcError(error.code, error.message);
    return ipcError('internal', 'The image could not be imported.');
  }

  const response = parseIpcResponse('intake.import', asset);
  if (!response.ok) return ipcError('invalid_response', response.error);
  registry?.add(response.value);
  return { ok: true, value: response.value };
}

/** `intake.createJob` handler: the only place a Job is created, called when the user presses Start. */
export function handleIntakeCreateJob(
  payload: unknown,
  registry: AssetRegistry,
  createJobFn: typeof createJob = createJob,
): IpcResult<IpcResponse<'intake.createJob'>> {
  const request = parseIpcRequest('intake.createJob', payload);
  if (!request.ok) return ipcError('invalid_request', request.error);

  const { assetId, prompt, categoryId, grid, providerId, categorySource, categoryConfidence } = request.value;
  const asset = registry.get(assetId);
  if (!asset) return ipcError('invalid_request', 'That image is no longer available. Import it again.');

  let job;
  try {
    job = createJobFn(asset, {
      prompt,
      categoryId,
      grid,
      providerId,
      ...(categorySource !== undefined ? { categorySource } : {}),
      ...(categoryConfidence !== undefined ? { categoryConfidence } : {}),
    });
  } catch (error) {
    if (error instanceof IntakeError) return ipcError(error.code, error.message);
    return ipcError('internal', 'The job could not be created.');
  }

  const response = parseIpcResponse('intake.createJob', job);
  if (!response.ok) return ipcError('invalid_response', response.error);
  return { ok: true, value: response.value };
}

const DEFAULT_PREVIEW_SIDE = 1024;

export type PreviewRenderer = (path: string, maxSide: number) => Promise<IpcResponse<'intake.preview'>>;

/** A JPEG no larger than `maxSide` on its longer side, never enlarged. The image file is only read. */
export const renderPreview: PreviewRenderer = async (path, maxSide) => {
  const { data, info } = await sharp(path)
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer({ resolveWithObject: true });
  return { dataUrl: `data:image/jpeg;base64,${data.toString('base64')}`, width: info.width, height: info.height };
};

/** `intake.preview` handler: a small picture of an imported image, to draw the tile grid over. */
export async function handleIntakePreview(
  payload: unknown,
  registry: AssetRegistry,
  render: PreviewRenderer = renderPreview,
): Promise<IpcResult<IpcResponse<'intake.preview'>>> {
  const request = parseIpcRequest('intake.preview', payload);
  if (!request.ok) return ipcError('invalid_request', request.error);

  const asset = registry.get(request.value.assetId);
  if (!asset) return ipcError('invalid_request', 'That image is no longer available. Import it again.');

  let preview;
  try {
    preview = await render(asset.path, request.value.maxSide ?? DEFAULT_PREVIEW_SIDE);
  } catch (error) {
    const missing = error instanceof Error && /ENOENT|no such file|Input file is missing/i.test(error.message);
    return missing ? ipcError('file-not-found', 'The image file is no longer there.') : ipcError('internal', 'The preview could not be made.');
  }

  const response = parseIpcResponse('intake.preview', preview);
  if (!response.ok) return ipcError('invalid_response', response.error);
  return { ok: true, value: response.value };
}
