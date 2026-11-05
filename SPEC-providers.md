# Spec: providers

## Objective
One adapter interface that turns "attachments + prompt" into "an enhanced image file" by driving a
provider's consumer web UI inside its logged-in session. Success: orchestrator can call any adapter
identically and receive either a full-resolution image or a typed error it knows how to handle.

## Tech Stack
TypeScript strict, Electron webContents + Chrome DevTools Protocol (via `webContents.debugger`), Zod for
selector-config validation, Vitest, Playwright Test for adapter contract tests against saved page fixtures.

## Commands
Build: pnpm --filter providers build
Test: pnpm --filter providers test
Contract tests (recorded fixtures): pnpm --filter providers test:contract
Live smoke (manual, uses your logged-in account, 1 generation): pnpm --filter providers smoke -- --provider gpt
Health check (no generation): pnpm --filter providers health

## Project Structure
packages/providers/
  src/ProviderAdapter.ts   -> interface + error types
  src/base/WebAdapter.ts   -> shared steps: newChat, attach, type, submit, waitForImage, download
  src/adapters/gpt.ts | gemini.ts | grok.ts
  src/adapters/api/        -> reserved for optional API-key adapter (not built in v1)
  config/gpt.json ...      -> urls, selectors with ordered fallbacks, timeouts, text markers for quota/refusal
  test/fixtures/           -> saved DOM snapshots per state (idle, generating, done, quota, refusal, challenge)

## Code Style
```ts
export interface EnhanceRequest {
  attachments: { role: "tile" | "global-reference" | "neighbor"; path: string }[];
  prompt: string;
  timeoutMs: number;
}
export interface EnhanceResult { imagePath: string; width: number; height: number; elapsedMs: number }

export type ProviderErrorKind =
  | "logged-out" | "challenge" | "quota" | "refusal" | "timeout" | "ui-changed" | "download-failed";
export class ProviderError extends Error { constructor(readonly kind: ProviderErrorKind, msg: string) { super(msg); } }

export interface ProviderAdapter {
  readonly id: "gpt" | "gemini" | "grok";
  readonly capabilities: { maxAttachments: number; outputAspects: string[]; approxOutputPx: number };
  health(): Promise<{ ok: boolean; missingSelectors: string[] }>;
  enhance(req: EnhanceRequest): Promise<EnhanceResult>;
}
```
Conventions: adapters never throw plain Error; every UI wait has a timeout; no hard-coded selectors in code.

## Behavior
1. Open a NEW chat per call (avoids context drift and thread bloat).
2. Attach files in the order given; verify the attachment thumbnails appeared before submitting.
3. Paste the prompt via clipboard-style insertion (not per-key typing) with small randomized pauses.
4. Submit, then wait for the final image using DOM mutation observation, not fixed sleeps.
5. Download the original-resolution image by fetching its URL inside the page context (keeps cookies),
   never by screenshot. If only a preview is available, return `download-failed`.
6. Classify page state after each step; map to ProviderError kinds using config markers.
7. Selector lookup tries fallbacks in order; if all fail, throw `ui-changed` with the missing selector name.

## Testing Strategy
- Contract tests: each adapter runs the same suite against fixtures for idle, generating, done, quota, refusal, challenge, logged-out.
- Config test: every selector key required by WebAdapter exists in every provider config.
- Live smoke is manual and never part of CI.
- Coverage >= 85% for src/base.

## Boundaries
- Always: run `health()` before a job; surface the exact missing selector on `ui-changed`.
- Ask first: adding a provider; adding retries inside an adapter (retries belong to orchestrator).
- Never: read or store credentials; bypass or auto-solve captchas; send requests outside the provider's own site; hammer the UI without orchestrator pacing.

## Success Criteria
- All three adapters pass the shared contract suite on fixtures.
- Live smoke on gpt returns a real image file >= 1024 px on its longest side.
- Every failure state maps to exactly one ProviderErrorKind.
- Changing a selector in config alone (no code change) fixes a simulated UI change.

## Open Questions
None. (Optional API-key adapter remains a post-v1 addition behind the same interface.)
