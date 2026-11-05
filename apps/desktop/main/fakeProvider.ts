import path from 'node:path';

import type { EnhanceRequest } from '@ie/contracts';
import type { ProviderAdapter } from '@ie/providers';
import { FakeAdapter } from '@ie/providers/fake';

/**
 * Development only: a provider that needs no account, slowed down so a person can watch the Run screen work.
 * Switched on by `IE_FAKE_PROVIDER=1` in an unpackaged build; `IE_FAKE_FAIL_RATE` (0-1) injects failures.
 */
export function createDevFakeProvider(outputDir: string, env: NodeJS.ProcessEnv = process.env): ProviderAdapter {
  process.env.IE_ALLOW_FAKE = '1'; // the fake refuses to exist otherwise; this path is already gated on a dev build
  const failRate = Number(env.IE_FAKE_FAIL_RATE ?? 0);
  const delayMs = Number(env.IE_FAKE_DELAY_MS ?? 1500);
  const inner = new FakeAdapter({ outputDir: path.join(outputDir, 'fake-provider'), seed: 1, failRate: Number.isFinite(failRate) ? failRate : 0 });
  return {
    get id() {
      return inner.id;
    },
    get capabilities() {
      return inner.capabilities;
    },
    health: () => inner.health(),
    async enhance(req: EnhanceRequest) {
      await new Promise((resolve) => setTimeout(resolve, Number.isFinite(delayMs) ? delayMs : 1500));
      return inner.enhance(req);
    },
  };
}

/** Whether the dev fake is wanted: only ever in a build that is not packaged. */
export const wantsDevFake = (packaged: boolean, env: NodeJS.ProcessEnv = process.env): boolean => !packaged && env.IE_FAKE_PROVIDER === '1';
