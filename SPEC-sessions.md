# Spec: sessions

## Objective
Give each provider (gpt, gemini, grok) an isolated, persistent logged-in browser session the user
establishes manually. Success: user logs in once per provider, stays logged in across restarts, and
the app can tell at any time whether a session is valid, expired, or blocked by a challenge.

## Tech Stack
Electron (session.fromPartition, BrowserWindow/WebContentsView), TypeScript strict, Vitest, Playwright Test.

## Commands
Build: pnpm --filter sessions build
Test: pnpm --filter sessions test
E2E (needs manual login fixture): pnpm --filter sessions e2e
Dev: pnpm dev

## Project Structure
packages/sessions/
  src/SessionManager.ts   -> open/close/status per provider
  src/partitions.ts       -> partition names persist:gpt | persist:gemini | persist:grok
  src/health.ts           -> logged-in / expired / challenge detection via config probes
  src/types.ts
  config/providers.json   -> login URL, "logged-in" probe selector, challenge indicators
  test/

## Code Style
```ts
export type SessionStatus = "logged-out" | "ready" | "challenge" | "quota-limited" | "unknown";

export interface SessionManager {
  open(provider: ProviderId, opts?: { visible: boolean }): Promise<SessionHandle>;
  status(provider: ProviderId): Promise<SessionStatus>;
  clear(provider: ProviderId): Promise<void>;
}
```
Conventions: no `any`, no password or cookie values in logs, status checks are read-only.

## Testing Strategy
- Unit: health detection against saved HTML fixtures per provider (logged-in, logged-out, captcha).
- Integration: partitions are isolated (cookie set in gpt not visible in gemini).
- E2E manual-assisted: log in, restart app, status stays "ready".

## Boundaries
- Always: keep partitions separate; show visible window whenever status is `logged-out` or `challenge`.
- Ask first: adding a provider; changing how login probes work.
- Never: read, store, or transmit credentials; auto-fill login forms; solve captchas automatically.

## Success Criteria
- Login persists across app restarts for each provider.
- status() returns the right state for all fixture pages.
- clear() fully removes the provider's cookies/storage.
- First-run notice about ToS/account risk is shown and acknowledgement recorded.

## Decisions (resolved)
- Provider windows are hidden during runs by default and auto-shown the moment status becomes `logged-out` or `challenge`. A "Watch mode" toggle keeps them visible.

## Open Questions
None.
