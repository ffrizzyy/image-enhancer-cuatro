import {
  IPC_VERSION,
  parseIpcRequest,
  parseIpcResponse,
  type IpcResponse,
} from '@ie/contracts';
import type { IntakeErrorCode } from '@ie/intake';

/** Typed error envelope: handlers never throw across the IPC boundary. */
export type IpcErrorCode = 'invalid_request' | 'invalid_response' | 'internal' | IntakeErrorCode;

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: IpcErrorCode; message: string } };

export function ipcError(code: IpcErrorCode, message: string): IpcResult<never> {
  return { ok: false, error: { code, message } };
}

/**
 * `app.ping` handler. Pure (no Electron import) so it is unit-testable.
 * The request is validated with the contract schema; the response is
 * validated too, so a bad version string surfaces as a typed error.
 */
export function handleAppPing(payload: unknown, appVersion: string): IpcResult<IpcResponse<'app.ping'>> {
  const request = parseIpcRequest('app.ping', payload);
  if (!request.ok) {
    return ipcError('invalid_request', request.error);
  }

  const response = parseIpcResponse('app.ping', { version: appVersion, ipcVersion: IPC_VERSION });
  if (!response.ok) {
    return ipcError('invalid_response', response.error);
  }

  return { ok: true, value: response.value };
}
