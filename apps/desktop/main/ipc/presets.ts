import { parseIpcRequest, parseIpcResponse, type ImageAsset, type ImageFeatures, type IpcResponse } from '@ie/contracts';
import { listCategories, suggestCategory } from '@ie/presets';

import type { AssetRegistry } from '../assetRegistry.js';
import { ipcError, type IpcResult } from './app.js';

export function handlePresetsList(list: typeof listCategories = listCategories): IpcResult<IpcResponse<'presets.list'>> {
  try {
    return { ok: true, value: list() };
  } catch {
    return ipcError('internal', 'The category list could not be loaded.');
  }
}

export interface SuggestDeps {
  registry: AssetRegistry;
  /** Cached image features for an asset (computed once, keyed by content hash). */
  featuresFor: (asset: ImageAsset) => Promise<ImageFeatures>;
  suggest?: typeof suggestCategory;
}

/**
 * `presets.suggestCategory` handler. Entirely local: it reads the asset's cached features and runs the
 * heuristic. It touches no provider or session, and it never creates a Job.
 */
export async function handlePresetsSuggest(
  payload: unknown,
  { registry, featuresFor, suggest = suggestCategory }: SuggestDeps,
): Promise<IpcResult<IpcResponse<'presets.suggestCategory'>>> {
  const request = parseIpcRequest('presets.suggestCategory', payload);
  if (!request.ok) return ipcError('invalid_request', request.error);

  const asset = registry.get(request.value.assetId);
  if (!asset) return ipcError('invalid_request', 'That image is no longer available. Import it again.');

  let suggestion;
  try {
    suggestion = suggest(await featuresFor(asset), request.value.prompt);
  } catch {
    return ipcError('internal', 'The image could not be analysed.');
  }

  const response = parseIpcResponse('presets.suggestCategory', suggestion);
  if (!response.ok) return ipcError('invalid_response', response.error);
  return { ok: true, value: response.value };
}
