import { IPC_VERSION } from '@ie/contracts';
import { describe, expect, it } from 'vitest';

import { handleAppPing } from '../main/ipc/app.js';

describe('app.ping handler', () => {
  it('returns version and ipcVersion for a void request', () => {
    expect(handleAppPing(undefined, '0.1.0')).toEqual({
      ok: true,
      value: { version: '0.1.0', ipcVersion: IPC_VERSION },
    });
  });

  it.each([{}, 'x', 42, null, { a: 1 }, []])('returns a typed error for malformed payload %j', (payload) => {
    const result = handleAppPing(payload, '0.1.0');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_request');
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  it('returns a typed error instead of throwing when the version is invalid', () => {
    const result = handleAppPing(undefined, '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_response');
  });
});
