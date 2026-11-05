import {
  CURRENT_RISK_NOTICE_VERSION,
  parseIpcRequest,
  type IpcResponse,
} from '@ie/contracts';

import type { SettingsStore } from '../settingsStore.js';
import { ipcError, type IpcResult } from './app.js';

export function handleSettingsGet(store: SettingsStore): IpcResult<IpcResponse<'settings.get'>> {
  try {
    return { ok: true, value: store.get() };
  } catch {
    return ipcError('internal', 'Settings could not be read.');
  }
}

export function handleSettingsSet(payload: unknown, store: SettingsStore): IpcResult<IpcResponse<'settings.set'>> {
  const request = parseIpcRequest('settings.set', payload);
  if (!request.ok) return ipcError('invalid_request', request.error);

  const patch = { ...request.value };
  // Acknowledging the notice records which version of the text was acknowledged.
  if (patch.firstRunAcknowledged === true && patch.riskNoticeVersion === undefined) {
    patch.riskNoticeVersion = CURRENT_RISK_NOTICE_VERSION;
  }

  try {
    return { ok: true, value: store.set(patch) };
  } catch {
    return ipcError('internal', 'Settings could not be saved.');
  }
}
