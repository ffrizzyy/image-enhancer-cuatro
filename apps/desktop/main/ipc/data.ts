import { parseIpcRequest, type IpcResponse } from '@ie/contracts';
import { getShippedCategory, OverrideError, listOverriddenIds, resetCategoryOverride, saveCategoryOverride } from '@ie/presets';

import { JobServiceError } from '../jobService.js';
import { ipcError, type IpcResult } from './app.js';

/** `presets.*` handlers for the template editor. Overrides live under userData/overrides; the shipped catalog is never written. */
export function handlePresetsOverrides(): IpcResult<IpcResponse<'presets.overrides'>> {
  return { ok: true, value: listOverriddenIds() };
}

export function handlePresetsShipped(payload: unknown): IpcResult<IpcResponse<'presets.shipped'>> {
  const request = parseIpcRequest('presets.shipped', payload);
  if (!request.ok) return ipcError('invalid_request', request.error);
  const category = getShippedCategory(request.value.categoryId);
  return category ? { ok: true, value: category } : ipcError('invalid_request', 'That category does not exist.');
}

export function handlePresetsSaveOverride(payload: unknown): IpcResult<IpcResponse<'presets.saveOverride'>> {
  const request = parseIpcRequest('presets.saveOverride', payload);
  if (!request.ok) return ipcError('invalid_request', request.error);
  const { categoryId, template, defaultPrompt } = request.value;
  try {
    return {
      ok: true,
      value: saveCategoryOverride(categoryId, {
        ...(template !== undefined ? { template } : {}),
        ...(defaultPrompt !== undefined ? { defaultPrompt } : {}),
      }),
    };
  } catch (error) {
    if (error instanceof OverrideError) return ipcError('invalid_request', error.message);
    return ipcError('internal', 'The change could not be saved.');
  }
}

export function handlePresetsResetOverride(payload: unknown): IpcResult<IpcResponse<'presets.resetOverride'>> {
  const request = parseIpcRequest('presets.resetOverride', payload);
  if (!request.ok) return ipcError('invalid_request', request.error);
  try {
    return { ok: true, value: resetCategoryOverride(request.value.categoryId) };
  } catch (error) {
    if (error instanceof OverrideError) return ipcError('invalid_request', error.message);
    return ipcError('internal', 'The template could not be reset.');
  }
}

export interface DataDeps {
  dataFolder: () => string;
  /** Opens the folder in the system file manager. Returns an error message, or '' on success. */
  openFolder: (folder: string) => Promise<string>;
  /** Asks the person in a native dialog; the renderer alone can never confirm a deletion. */
  confirmClear: () => Promise<boolean>;
  clearJobs: () => Promise<number>;
}

export async function handleDataOpenFolder(deps: DataDeps): Promise<IpcResult<IpcResponse<'data.openFolder'>>> {
  const folder = deps.dataFolder();
  const problem = await deps.openFolder(folder);
  return problem ? ipcError('internal', `The folder could not be opened: ${problem}`) : { ok: true, value: { path: folder } };
}

export async function handleDataClearJobs(deps: DataDeps): Promise<IpcResult<IpcResponse<'data.clearJobs'>>> {
  if (!(await deps.confirmClear())) return ipcError('cancelled', 'Nothing was deleted.');
  try {
    return { ok: true, value: { removed: await deps.clearJobs() } };
  } catch (error) {
    if (error instanceof JobServiceError) return ipcError('invalid_request', error.message);
    return ipcError('internal', 'The job data could not be cleared.');
  }
}
