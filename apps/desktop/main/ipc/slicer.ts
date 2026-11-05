import { parseIpcRequest, parseIpcResponse, type IpcResponse } from '@ie/contracts';
import { planTiles, PlanError } from '@ie/slicer';

import type { AssetRegistry } from '../assetRegistry.js';
import { ipcError, type IpcResult } from './app.js';

/**
 * `slicer.plan` handler: the exact tile plan the job will use, for the Setup preview. The plan is pure and
 * deterministic, so the orchestrator reproduces it from the job's source size and grid.
 */
export function handleSlicerPlan(payload: unknown, registry: AssetRegistry): IpcResult<IpcResponse<'slicer.plan'>> {
  const request = parseIpcRequest('slicer.plan', payload);
  if (!request.ok) return ipcError('invalid_request', request.error);

  const { assetId, grid, overlapPct, wrap } = request.value;
  const asset = registry.get(assetId);
  if (!asset) return ipcError('invalid_request', 'That image is no longer available. Import it again.');

  let plan;
  try {
    plan = planTiles({ width: asset.width, height: asset.height, rows: grid.rows, cols: grid.cols, overlapPct, wrap: wrap ?? false });
  } catch (error) {
    if (error instanceof PlanError) return ipcError('invalid_request', error.message);
    return ipcError('internal', 'The tile plan could not be made.');
  }

  const response = parseIpcResponse('slicer.plan', plan);
  if (!response.ok) return ipcError('invalid_response', response.error);
  return { ok: true, value: response.value };
}