import type { ProviderId, SessionStatus } from '@ie/contracts';

import rawConfig from '../config/providers.json';
import { ProvidersConfigSchema, type ProviderConfig, type ProvidersConfig } from './schema';
import type { HealthProbe } from './types';

/** Throws at startup if the shipped config is malformed. */
export const providersConfig: ProvidersConfig = ProvidersConfigSchema.parse(rawConfig);

export interface PageFacts {
  ready: boolean;
  loggedOut: boolean;
  challenge: boolean;
  quota: boolean;
}

/**
 * Self-contained, read-only script that reports which markers a page shows.
 * The same source runs inside a provider view in production and in jsdom in tests.
 * Invalid selectors count as absent, so it never throws.
 */
export function factsScript(config: ProviderConfig): string {
  const { probes, textMarkers } = config;
  return `(() => {
  const has = (s) => { try { return document.querySelector(s) !== null; } catch { return false; } };
  const body = document.body;
  const text = ((body && (body.innerText || body.textContent)) || '').toLowerCase();
  const found = (list) => list.some(has);
  const mentions = (list) => list.some((t) => text.includes(t.toLowerCase()));
  return {
    ready: found(${JSON.stringify(probes.ready)}),
    loggedOut: found(${JSON.stringify(probes.loggedOut)}),
    challenge: found(${JSON.stringify(probes.challenge)}) || mentions(${JSON.stringify(textMarkers.challenge)}),
    quota: found(${JSON.stringify(probes.quota)}) || mentions(${JSON.stringify(textMarkers.quota)}),
  };
})()`;
}

/**
 * Challenge and quota win because they block the user regardless of login state;
 * logged-out beats ready because some providers show a composer to signed-out visitors.
 */
export function classify(facts: Partial<PageFacts> | null | undefined): SessionStatus {
  if (!facts) return 'unknown';
  if (facts.challenge) return 'challenge';
  if (facts.quota) return 'quota-limited';
  if (facts.loggedOut) return 'logged-out';
  if (facts.ready) return 'ready';
  return 'unknown';
}

/** A page that has not answered by now (loading, crashed, or busy) is reported as unknown, never waited on. */
export const PROBE_TIMEOUT_MS = 8000;

export function createHealthProbe(config: ProvidersConfig = providersConfig, timeoutMs = PROBE_TIMEOUT_MS): HealthProbe {
  return async (provider: ProviderId, view) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      });
      return classify(await Promise.race([view.evaluate<PageFacts>(factsScript(config[provider])), timedOut]));
    } catch {
      return 'unknown';
    } finally {
      clearTimeout(timer);
    }
  };
}
