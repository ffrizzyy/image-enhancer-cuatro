import type { ProviderId, SessionHandle, SessionStatus } from '@ie/contracts';

/** A provider's browser view (an Electron WebContentsView in production). */
export interface ProviderView {
  readonly partition: string;
  setVisible(visible: boolean): void;
  isVisible(): boolean;
  loadURL(url: string): Promise<void>;
  /** Run a read-only script in the page and return its (serializable) result. */
  evaluate<T>(script: string): Promise<T>;
  close(): void;
  /** The underlying Electron `WebContents`, for drivers that need the DevTools protocol. Absent on test fakes. */
  readonly native?: unknown;
}

/**
 * The slice of Electron the manager needs. Keeps the manager unit-testable
 * without a running Electron; `electronBackend.ts` is the real implementation.
 */
export interface SessionBackend {
  createView(partition: string, opts: { visible: boolean }): ProviderView;
  /** Remove cookies and storage for exactly this partition. */
  clearPartition(partition: string): Promise<void>;
}

/** Read-only health check for an open view. Provided by the health module (Task 7). */
export type HealthProbe = (provider: ProviderId, view: ProviderView) => Promise<SessionStatus>;

export interface OpenSession extends SessionHandle {
  view: ProviderView;
}

export interface SessionManager {
  open(provider: ProviderId, opts?: { visible?: boolean }): Promise<OpenSession>;
  /** Providers that currently have a view (and so can be probed). */
  openProviders(): ProviderId[];
  /** Read-only. `unknown` when the provider has no open view or no probe is configured. */
  status(provider: ProviderId): Promise<SessionStatus>;
  clear(provider: ProviderId): Promise<void>;
}
