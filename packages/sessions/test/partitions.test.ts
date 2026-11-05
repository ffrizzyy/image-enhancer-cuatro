import { describe, expect, it, vi } from 'vitest';

import { PROVIDER_IDS, partitionFor } from '../src/partitions';
import { createSessionManager } from '../src/SessionManager';
import type { ProviderView, SessionBackend } from '../src/types';

function fakeBackend() {
  const views: (ProviderView & { closed: boolean; visible: boolean })[] = [];
  const cleared: string[] = [];
  const backend: SessionBackend = {
    createView(partition, { visible }) {
      const view = {
        partition,
        closed: false,
        visible,
        setVisible(v: boolean) {
          view.visible = v;
        },
        isVisible: () => view.visible,
        loadURL: vi.fn(async () => {}),
        evaluate: vi.fn(async () => undefined as never),
        close() {
          view.closed = true;
        },
      };
      views.push(view);
      return view;
    },
    clearPartition: async (partition) => {
      cleared.push(partition);
    },
  };
  return { backend, views, cleared };
}

describe('partitionFor', () => {
  it('gives each provider a distinct persistent partition', () => {
    expect(PROVIDER_IDS.map(partitionFor)).toEqual(['persist:gpt', 'persist:gemini', 'persist:grok']);
  });
});

describe('SessionManager', () => {
  it('opens a hidden view on the provider partition by default', async () => {
    const { backend, views } = fakeBackend();
    const handle = await createSessionManager({ backend }).open('gpt');

    expect(handle).toMatchObject({ providerId: 'gpt', partition: 'persist:gpt', visible: false });
    expect(handle.view.partition).toBe('persist:gpt');
    expect(views).toHaveLength(1);
    expect(views[0]?.visible).toBe(false);
  });

  it('reuses the open view and applies the requested visibility', async () => {
    const { backend, views } = fakeBackend();
    const manager = createSessionManager({ backend });

    await manager.open('gemini');
    const again = await manager.open('gemini', { visible: true });

    expect(views).toHaveLength(1);
    expect(again.visible).toBe(true);
    expect(views[0]?.visible).toBe(true);
  });

  it('clear() closes and clears only the requested provider', async () => {
    const { backend, views, cleared } = fakeBackend();
    const manager = createSessionManager({ backend });
    await manager.open('gpt');
    await manager.open('gemini');

    await manager.clear('gpt');

    expect(cleared).toEqual(['persist:gpt']);
    expect(views.find((v) => v.partition === 'persist:gpt')?.closed).toBe(true);
    expect(views.find((v) => v.partition === 'persist:gemini')?.closed).toBe(false);
  });

  it('clear() works for a provider that was never opened', async () => {
    const { backend, cleared } = fakeBackend();
    await createSessionManager({ backend }).clear('grok');
    expect(cleared).toEqual(['persist:grok']);
  });

  it('reopens a fresh view after clear()', async () => {
    const { backend, views } = fakeBackend();
    const manager = createSessionManager({ backend });
    await manager.open('gpt');
    await manager.clear('gpt');
    await manager.open('gpt');
    expect(views).toHaveLength(2);
  });

  describe('status()', () => {
    it('is unknown when the provider is not open or no probe is configured', async () => {
      const { backend } = fakeBackend();
      const manager = createSessionManager({ backend });
      expect(await manager.status('gpt')).toBe('unknown');
      await manager.open('gpt');
      expect(await manager.status('gpt')).toBe('unknown');
    });

    it('delegates to the probe without touching the view', async () => {
      const { backend, views } = fakeBackend();
      const healthProbe = vi.fn(async () => 'ready' as const);
      const manager = createSessionManager({ backend, healthProbe });
      await manager.open('grok');

      expect(await manager.status('grok')).toBe('ready');
      expect(healthProbe).toHaveBeenCalledWith('grok', views[0]);
      expect(views[0]?.closed).toBe(false);
      expect(views[0]?.visible).toBe(false);
    });
  });
});
