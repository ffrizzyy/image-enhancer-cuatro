import type { ProviderId, SessionStatus } from '@ie/contracts';

import type { SessionManager } from './types';

export interface SessionMonitorOptions {
  manager: SessionManager;
  /** Called when a provider's status changes (first reading included). */
  onStatus: (provider: ProviderId, status: SessionStatus) => void;
  /** Poll interval; 1 s keeps the auto-show latency within the spec. */
  intervalMs?: number;
}

export interface SessionMonitor {
  start(): void;
  stop(): void;
  /** Probe every open provider once. Exposed so tests and callers need no timers. */
  tick(): Promise<void>;
  /** Forget a provider's last status (after clear) so the next reading is reported. */
  forget(provider: ProviderId): void;
}

const NEEDS_USER: readonly SessionStatus[] = ['logged-out', 'challenge'];

/**
 * Polls open providers (read-only probes). On a change it reports the status, and on a
 * change into `logged-out` or `challenge` it shows that provider's window. It acts only on
 * transitions, so a user who hides the window is not re-interrupted every second.
 */
export function createSessionMonitor({ manager, onStatus, intervalMs = 1000 }: SessionMonitorOptions): SessionMonitor {
  const last = new Map<ProviderId, SessionStatus>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (const provider of manager.openProviders()) {
        const status = await manager.status(provider).catch((): SessionStatus => 'unknown');
        if (last.get(provider) === status) continue;
        last.set(provider, status);
        onStatus(provider, status);
        if (NEEDS_USER.includes(status)) await manager.open(provider, { visible: true });
      }
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    tick,
    forget: (provider) => void last.delete(provider),
  };
}
