import { parseIpcRequest, type IpcResponse } from '@ie/contracts';
import type { SessionManager, SessionMonitor } from '@ie/sessions';

import { ipcError, type IpcResult } from './app.js';

export interface SessionDeps {
  manager: SessionManager;
  monitor: SessionMonitor;
}

const failed = (what: string) => ipcError('internal', `Could not ${what}.`);

export async function handleSessionsOpen(
  payload: unknown,
  { manager }: SessionDeps,
): Promise<IpcResult<IpcResponse<'sessions.open'>>> {
  const request = parseIpcRequest('sessions.open', payload);
  if (!request.ok) return ipcError('invalid_request', request.error);

  try {
    const { providerId, partition, visible } = await manager.open(request.value.providerId, {
      visible: request.value.visible ?? false,
    });
    return { ok: true, value: { providerId, partition, visible } };
  } catch {
    return failed('open the provider window');
  }
}

/** Read-only: probes the provider without changing its page or window. */
export async function handleSessionsStatus(
  payload: unknown,
  { manager }: SessionDeps,
): Promise<IpcResult<IpcResponse<'sessions.status'>>> {
  const request = parseIpcRequest('sessions.status', payload);
  if (!request.ok) return ipcError('invalid_request', request.error);

  try {
    return { ok: true, value: await manager.status(request.value.providerId) };
  } catch {
    return failed('read the provider status');
  }
}

export async function handleSessionsClear(
  payload: unknown,
  { manager, monitor }: SessionDeps,
): Promise<IpcResult<IpcResponse<'sessions.clear'>>> {
  const request = parseIpcRequest('sessions.clear', payload);
  if (!request.ok) return ipcError('invalid_request', request.error);

  try {
    await manager.clear(request.value.providerId);
    monitor.forget(request.value.providerId);
    return { ok: true, value: { cleared: true } };
  } catch {
    return failed('clear the provider session');
  }
}
