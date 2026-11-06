import path from 'node:path';

import type { EnhanceRequest } from '@ie/contracts';
import type { ProviderAdapter } from '@ie/providers';
import { FAILING_MODES, FakeAdapter, type FailureMode } from '@ie/providers/fake';

/** Every mode the fake understands, so a bad `IE_FAKE_MODES` entry is ignored instead of pretending to be a failure. */
const KNOWN_MODES: ReadonlySet<string> = new Set<FailureMode>(['ok', ...FAILING_MODES]);

/** Reads `IE_FAKE_MODES` (`ok,challenge,ok,...`) into a validated list, or undefined when it is not set. */
function modesFromEnv(env: NodeJS.ProcessEnv): readonly FailureMode[] | undefined {
  const raw = env.IE_FAKE_MODES;
  if (!raw) return undefined;
  const modes = raw
    .split(',')
    .map((mode) => mode.trim())
    .filter((mode): mode is FailureMode => KNOWN_MODES.has(mode));
  return modes.length > 0 ? modes : undefined;
}

/**
 * Development only: a provider that needs no account, slowed down so a person can watch the Run screen work.
 * Switched on by `IE_FAKE_PROVIDER=1` in an unpackaged build; `IE_FAKE_FAIL_RATE` (0-1) injects failures and
 * `IE_FAKE_MODES` (`ok,challenge,ok,...`) scripts the exact sequence of outcomes, one per provider call.
 */
export function createDevFakeProvider(outputDir: string, env: NodeJS.ProcessEnv = process.env): ProviderAdapter {
  process.env.IE_ALLOW_FAKE = '1'; // the fake refuses to exist otherwise; this path is already gated on a dev build
  const failRate = Number(env.IE_FAKE_FAIL_RATE ?? 0);
  const delayMs = Number(env.IE_FAKE_DELAY_MS ?? 1500);
  const modes = modesFromEnv(env);
  const inner = new FakeAdapter({
    outputDir: path.join(outputDir, 'fake-provider'),
    seed: 1,
    ...(modes ? { modes } : { failRate: Number.isFinite(failRate) ? failRate : 0 }),
  });
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
