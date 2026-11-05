import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CURRENT_RISK_NOTICE_VERSION } from '@ie/contracts';
import type { SessionManager, SessionMonitor } from '@ie/sessions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleSessionsClear, handleSessionsOpen, handleSessionsStatus } from '../main/ipc/sessions.js';
import { handleSettingsGet, handleSettingsSet } from '../main/ipc/settings.js';
import { createSettingsStore } from '../main/settingsStore.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ie-settings-'));
  file = path.join(dir, 'nested', 'settings.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('settings store', () => {
  it('starts with safe defaults and an unacknowledged notice', () => {
    expect(createSettingsStore(file, dir).get()).toEqual({
      firstRunAcknowledged: false,
      pacingPreset: 'safe',
      dataFolder: dir,
      watchMode: false,
      riskNoticeVersion: 0,
    });
  });

  it('persists across a restart (a new store instance reads the file)', () => {
    createSettingsStore(file, dir).set({ firstRunAcknowledged: true, riskNoticeVersion: 1 });
    const restarted = createSettingsStore(file, dir).get();
    expect(restarted).toMatchObject({ firstRunAcknowledged: true, riskNoticeVersion: 1, pacingPreset: 'safe' });
  });

  it('merges patches without losing other keys, and writes atomically', () => {
    const store = createSettingsStore(file, dir);
    store.set({ watchMode: true });
    store.set({ pacingPreset: 'normal' });
    expect(store.get()).toMatchObject({ watchMode: true, pacingPreset: 'normal' });
    expect(readdirSync(path.dirname(file))).toEqual(['settings.json']);
  });

  it('ignores undefined patch values', () => {
    const store = createSettingsStore(file, dir);
    store.set({ watchMode: true });
    store.set({ watchMode: undefined });
    expect(store.get().watchMode).toBe(true);
  });

  it.each(['{ not json', '{"pacingPreset":"turbo"}', '[]'])('falls back to defaults for corrupt content %s', (content) => {
    const store = createSettingsStore(file, dir);
    store.set({ watchMode: true });
    writeFileSync(file, content);
    expect(store.get().firstRunAcknowledged).toBe(false);
    expect(store.get().pacingPreset).toBe('safe');
  });

  it('rejects an invalid patch without touching the file', () => {
    const store = createSettingsStore(file, dir);
    store.set({ watchMode: true });
    const before = readFileSync(file, 'utf8');
    expect(() => store.set({ pacingPreset: 'turbo' as never })).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('settings handlers', () => {
  it('get returns the stored settings', () => {
    const store = createSettingsStore(file, dir);
    expect(handleSettingsGet(store)).toMatchObject({ ok: true, value: { firstRunAcknowledged: false } });
  });

  it('acknowledging records the current notice version', () => {
    const store = createSettingsStore(file, dir);
    const result = handleSettingsSet({ firstRunAcknowledged: true }, store);
    expect(result).toMatchObject({
      ok: true,
      value: { firstRunAcknowledged: true, riskNoticeVersion: CURRENT_RISK_NOTICE_VERSION },
    });
    expect(createSettingsStore(file, dir).get().firstRunAcknowledged).toBe(true);
  });

  it('keeps an explicit notice version', () => {
    const store = createSettingsStore(file, dir);
    expect(handleSettingsSet({ firstRunAcknowledged: true, riskNoticeVersion: 7 }, store)).toMatchObject({
      value: { riskNoticeVersion: 7 },
    });
  });

  it.each(['x', 42, { pacingPreset: 'turbo' }, { watchMode: 'yes' }])('rejects malformed payload %j', (payload) => {
    expect(handleSettingsSet(payload, createSettingsStore(file, dir))).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });

  it('maps store failures to typed errors', () => {
    const broken = {
      get: () => {
        throw new Error('disk');
      },
      set: () => {
        throw new Error('disk');
      },
    };
    expect(handleSettingsGet(broken)).toMatchObject({ ok: false, error: { code: 'internal' } });
    expect(handleSettingsSet({ watchMode: true }, broken)).toMatchObject({ ok: false, error: { code: 'internal' } });
  });
});

describe('sessions handlers', () => {
  const makeDeps = () => {
    const manager = {
      open: vi.fn(async (providerId: string, opts?: { visible?: boolean }) => ({
        providerId,
        partition: `persist:${providerId}`,
        visible: opts?.visible ?? false,
        view: {},
      })),
      openProviders: vi.fn(() => []),
      status: vi.fn(async () => 'ready' as const),
      clear: vi.fn(async () => {}),
    };
    const monitor = { start: vi.fn(), stop: vi.fn(), tick: vi.fn(), forget: vi.fn() };
    return { manager, monitor, deps: { manager: manager as unknown as SessionManager, monitor: monitor as SessionMonitor } };
  };

  it('open returns the handle without the view and defaults to hidden', async () => {
    const { manager, deps } = makeDeps();
    const result = await handleSessionsOpen({ providerId: 'gpt' }, deps);
    expect(result).toEqual({ ok: true, value: { providerId: 'gpt', partition: 'persist:gpt', visible: false } });
    expect(manager.open).toHaveBeenCalledWith('gpt', { visible: false });

    expect(await handleSessionsOpen({ providerId: 'gemini', visible: true }, deps)).toMatchObject({
      value: { visible: true },
    });
  });

  it('status is a read-only call to the manager', async () => {
    const { manager, deps } = makeDeps();
    expect(await handleSessionsStatus({ providerId: 'grok' }, deps)).toEqual({ ok: true, value: 'ready' });
    expect(manager.status).toHaveBeenCalledWith('grok');
    expect(manager.open).not.toHaveBeenCalled();
    expect(manager.clear).not.toHaveBeenCalled();
  });

  it('clear clears that provider and resets its monitor state', async () => {
    const { manager, monitor, deps } = makeDeps();
    expect(await handleSessionsClear({ providerId: 'gpt' }, deps)).toEqual({ ok: true, value: { cleared: true } });
    expect(manager.clear).toHaveBeenCalledExactlyOnceWith('gpt');
    expect(monitor.forget).toHaveBeenCalledExactlyOnceWith('gpt');
  });

  it.each([undefined, {}, { providerId: 'bing' }, 'gpt'])('rejects malformed payload %j', async (payload) => {
    const { deps } = makeDeps();
    for (const handler of [handleSessionsOpen, handleSessionsStatus, handleSessionsClear]) {
      expect(await handler(payload, deps)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    }
  });

  it('maps manager failures to generic typed errors without leaking details', async () => {
    const { manager, deps } = makeDeps();
    const boom = new Error('secret cookie value abc');
    manager.open.mockRejectedValue(boom);
    manager.status.mockRejectedValue(boom);
    manager.clear.mockRejectedValue(boom);

    for (const result of [
      await handleSessionsOpen({ providerId: 'gpt' }, deps),
      await handleSessionsStatus({ providerId: 'gpt' }, deps),
      await handleSessionsClear({ providerId: 'gpt' }, deps),
    ]) {
      expect(result).toMatchObject({ ok: false, error: { code: 'internal' } });
      expect(JSON.stringify(result)).not.toContain('secret');
    }
  });
});
