import type { ProviderId, SessionStatus } from '@ie/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionManager } from '../src/SessionManager';
import { createSessionMonitor } from '../src/monitor';
import type { ProviderView, SessionBackend } from '../src/types';

function setup(initial: Partial<Record<ProviderId, SessionStatus>> = {}) {
  const statuses: Partial<Record<ProviderId, SessionStatus>> = { ...initial };
  const views = new Map<string, ProviderView & { visible: boolean; loaded: string[] }>();
  const backend: SessionBackend = {
    createView(partition, { visible }) {
      const view = {
        partition,
        visible,
        loaded: [] as string[],
        setVisible(v: boolean) {
          view.visible = v;
        },
        isVisible: () => view.visible,
        loadURL: async (url: string) => {
          view.loaded.push(url);
        },
        evaluate: async () => undefined as never,
        close: () => {},
      };
      views.set(partition, view);
      return view;
    },
    clearPartition: async () => {},
  };
  const manager = createSessionManager({
    backend,
    healthProbe: async (provider) => statuses[provider] ?? 'unknown',
    loginUrlFor: (provider) => `https://${provider}.example/login`,
  });
  const events: Array<[ProviderId, SessionStatus]> = [];
  const monitor = createSessionMonitor({ manager, onStatus: (p, s) => events.push([p, s]) });
  return { statuses, views, manager, monitor, events };
}

afterEach(() => vi.useRealTimers());

describe('SessionManager additions', () => {
  it('loads the login URL when a view is first created, not on reuse', async () => {
    const { manager, views } = setup();
    await manager.open('gpt');
    await manager.open('gpt', { visible: true });
    expect(views.get('persist:gpt')?.loaded).toEqual(['https://gpt.example/login']);
  });

  it('tolerates a failed initial navigation', async () => {
    const backend: SessionBackend = {
      createView: (partition) => ({
        partition,
        setVisible: () => {},
        isVisible: () => false,
        loadURL: () => Promise.reject(new Error('ERR_ABORTED')),
        evaluate: async () => undefined as never,
        close: () => {},
      }),
      clearPartition: async () => {},
    };
    const manager = createSessionManager({ backend, loginUrlFor: () => 'https://x.example' });
    await expect(manager.open('grok')).resolves.toMatchObject({ providerId: 'grok' });
  });

  it('lists open providers and drops cleared ones', async () => {
    const { manager } = setup();
    expect(manager.openProviders()).toEqual([]);
    await manager.open('gpt');
    await manager.open('grok');
    expect(manager.openProviders()).toEqual(['gpt', 'grok']);
    await manager.clear('gpt');
    expect(manager.openProviders()).toEqual(['grok']);
  });
});

describe('session monitor', () => {
  it('reports a status once, and again only when it changes', async () => {
    const { manager, monitor, events, statuses } = setup({ gpt: 'ready' });
    await manager.open('gpt');

    await monitor.tick();
    await monitor.tick();
    expect(events).toEqual([['gpt', 'ready']]);

    statuses.gpt = 'quota-limited';
    await monitor.tick();
    expect(events).toEqual([
      ['gpt', 'ready'],
      ['gpt', 'quota-limited'],
    ]);
  });

  it.each(['logged-out', 'challenge'] as const)('shows the hidden window when status becomes %s', async (status) => {
    const { manager, monitor, views, statuses } = setup({ gemini: 'ready' });
    await manager.open('gemini');
    await monitor.tick();
    expect(views.get('persist:gemini')?.visible).toBe(false);

    statuses.gemini = status;
    await monitor.tick();
    expect(views.get('persist:gemini')?.visible).toBe(true);
  });

  it('does not re-show a window the user hid while the status is unchanged', async () => {
    const { manager, monitor, views } = setup({ gpt: 'logged-out' });
    await manager.open('gpt');
    await monitor.tick();
    expect(views.get('persist:gpt')?.visible).toBe(true);

    views.get('persist:gpt')!.setVisible(false);
    await monitor.tick();
    expect(views.get('persist:gpt')?.visible).toBe(false);
  });

  it('leaves the window hidden for ready, quota-limited and unknown', async () => {
    const { manager, monitor, views, statuses } = setup();
    await manager.open('gpt');
    for (const status of ['ready', 'quota-limited', 'unknown'] as const) {
      statuses.gpt = status;
      await monitor.tick();
    }
    expect(views.get('persist:gpt')?.visible).toBe(false);
  });

  it('ignores providers that are not open', async () => {
    const { monitor, events } = setup({ gpt: 'logged-out' });
    await monitor.tick();
    expect(events).toEqual([]);
  });

  it('forget() makes the next reading report again', async () => {
    const { manager, monitor, events } = setup({ gpt: 'ready' });
    await manager.open('gpt');
    await monitor.tick();
    monitor.forget('gpt');
    await monitor.tick();
    expect(events).toHaveLength(2);
  });

  it('survives a failing probe by reporting unknown', async () => {
    const backend: SessionBackend = {
      createView: (partition) => ({
        partition,
        setVisible: () => {},
        isVisible: () => false,
        loadURL: async () => {},
        evaluate: async () => undefined as never,
        close: () => {},
      }),
      clearPartition: async () => {},
    };
    const manager = createSessionManager({
      backend,
      healthProbe: () => Promise.reject(new Error('probe crashed')),
    });
    const events: Array<[ProviderId, SessionStatus]> = [];
    const monitor = createSessionMonitor({ manager, onStatus: (p, s) => events.push([p, s]) });
    await manager.open('gpt');
    await monitor.tick();
    expect(events).toEqual([['gpt', 'unknown']]);
  });

  it('polls every second, within the 1 s auto-show budget, until stopped', async () => {
    vi.useFakeTimers();
    const { manager, monitor, views, statuses } = setup({ gpt: 'ready' });
    await manager.open('gpt');
    monitor.start();
    monitor.start(); // second start is a no-op

    await vi.advanceTimersByTimeAsync(1000);
    statuses.gpt = 'logged-out';
    await vi.advanceTimersByTimeAsync(1000);
    expect(views.get('persist:gpt')?.visible).toBe(true);

    monitor.stop();
    statuses.gpt = 'ready';
    await vi.advanceTimersByTimeAsync(5000);
    expect(views.get('persist:gpt')?.visible).toBe(true);
  });
});
