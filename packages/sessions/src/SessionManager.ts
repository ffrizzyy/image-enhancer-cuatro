import type { ProviderId } from '@ie/contracts';

import { partitionFor } from './partitions';
import type { HealthProbe, OpenSession, SessionBackend, SessionManager } from './types';

export interface SessionManagerDeps {
  backend: SessionBackend;
  healthProbe?: HealthProbe;
  /** When set, a newly created view navigates here so the user (or the probe) sees the provider. */
  loginUrlFor?: (provider: ProviderId) => string;
}

export function createSessionManager({ backend, healthProbe, loginUrlFor }: SessionManagerDeps): SessionManager {
  const open = new Map<ProviderId, OpenSession>();

  return {
    async open(provider, opts) {
      const visible = opts?.visible ?? false;
      const existing = open.get(provider);
      if (existing) {
        existing.view.setVisible(visible);
        existing.visible = visible;
        return existing;
      }

      const partition = partitionFor(provider);
      const view = backend.createView(partition, { visible });
      const session: OpenSession = { providerId: provider, partition, visible, view };
      open.set(provider, session);

      // Redirects routinely abort the first navigation; a failed load must not fail open().
      if (loginUrlFor) view.loadURL(loginUrlFor(provider)).catch(() => {});
      return session;
    },

    openProviders: () => [...open.keys()],

    async status(provider) {
      const session = open.get(provider);
      if (!session || !healthProbe) return 'unknown';
      return healthProbe(provider, session.view);
    },

    async clear(provider) {
      open.get(provider)?.view.close();
      open.delete(provider);
      await backend.clearPartition(partitionFor(provider));
    },
  };
}
