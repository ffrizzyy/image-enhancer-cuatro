import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { configureOverrides, getCategory } from '@ie/presets';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleDataClearJobs, handleDataOpenFolder, handlePresetsResetOverride, handlePresetsSaveOverride, handlePresetsShipped, type DataDeps } from '../main/ipc/data';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ie-data-'));
  configureOverrides(path.join(dir, 'overrides'));
});
afterEach(() => {
  configureOverrides(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('template overrides over IPC', () => {
  it('saves, uses and resets an override, and the shipped view stays the original', () => {
    const shipped = handlePresetsShipped({ categoryId: 'env-realistic' });
    expect(shipped.ok && shipped.value.defaultPrompt).toBeTruthy();

    const saved = handlePresetsSaveOverride({ categoryId: 'env-realistic', defaultPrompt: 'Mine.' });
    expect(saved).toMatchObject({ ok: true, value: { defaultPrompt: 'Mine.' } });
    expect(getCategory('env-realistic')!.defaultPrompt).toBe('Mine.');
    expect(handlePresetsShipped({ categoryId: 'env-realistic' })).toEqual(shipped);

    const reset = handlePresetsResetOverride({ categoryId: 'env-realistic' });
    expect(reset).toEqual(shipped);
    expect(getCategory('env-realistic')!.defaultPrompt).toBe(shipped.ok ? shipped.value.defaultPrompt : '');
  });

  it('refuses an invalid template with a plain message', () => {
    const result = handlePresetsSaveOverride({ categoryId: 'env-realistic', template: 'nothing useful' });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request', message: expect.stringMatching(/userPrompt/) } });
    expect(handlePresetsSaveOverride({ nope: 1 })).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });
});

describe('data folder', () => {
  const deps = (over: Partial<DataDeps> = {}): DataDeps => ({
    dataFolder: () => '/data',
    openFolder: async () => '',
    confirmClear: async () => true,
    clearJobs: async () => 3,
    ...over,
  });

  it('opens the data folder and reports a failure', async () => {
    const open = vi.fn(async () => '');
    expect(await handleDataOpenFolder(deps({ openFolder: open }))).toEqual({ ok: true, value: { path: '/data' } });
    expect(open).toHaveBeenCalledWith('/data');
    expect(await handleDataOpenFolder(deps({ openFolder: async () => 'no such folder' }))).toMatchObject({ ok: false, error: { code: 'internal' } });
  });

  it('deletes nothing unless the person confirms in the native dialog', async () => {
    const clear = vi.fn(async () => 3);
    expect(await handleDataClearJobs(deps({ confirmClear: async () => false, clearJobs: clear }))).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(clear).not.toHaveBeenCalled();
    expect(await handleDataClearJobs(deps({ clearJobs: clear }))).toEqual({ ok: true, value: { removed: 3 } });
  });
});
