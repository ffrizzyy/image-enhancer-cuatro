# Spec: app-ui

## Objective
A desktop interface where a non-technical user imports an image, writes a prompt, picks a category and
grid, watches progress, fixes any problem tiles, compares before/after, and exports one image.

## Screens
1. **Home / Import**: drag-drop or picker; recent jobs list (resume paused jobs).
2. **Setup**: category picker (grouped by family, with one-line descriptions and warnings), prompt box
   prefilled from the category's default prompt and fully editable (with "Reset to category default"),
   grid selector (6, 8, custom) drawn as an overlay on the image with overlap shown, provider picker with
   live login status, cost preview (tiles, rough time, quota note), "Start". Choosing Auto-detect runs a
   local analysis and shows the suggested category, confidence, and top alternatives for override.
3. **Run**: tile grid with per-tile state and thumbnails, overall progress, Pause/Resume/Cancel, "Watch mode"
   toggle (show provider window), clear banners for captcha, logged-out and quota pauses with a one-click action.
4. **Result**: before/after slider, zoom, seam overlay toggle, flagged-tile list, per-tile re-run / accept /
   edit prompt, quality badge (seam score), Export (PNG, JPEG, WebP).
5. **Settings**: provider logins (open window, status, clear), a note that provider windows use the
   app's built-in browser and never launch the system default, template editor with reset-to-default,
   pacing preset (Safe / Normal), data folder, first-run risk notice review.

## Tech Stack
Electron renderer with React + TypeScript + Vite, Zustand for state, Tailwind CSS, Vitest + Testing Library,
Playwright (Electron) for e2e. IPC contract typed and shared with main process.

## Commands
Dev: pnpm dev
Build: pnpm build
Test: pnpm --filter app-ui test
E2E: pnpm --filter app-ui e2e   (uses fake provider; no real accounts)
Package: pnpm package

## Project Structure
apps/desktop/
  main/               -> Electron main: IPC handlers, window mgmt, wiring of packages
  renderer/src/screens/ Home | Setup | Run | Result | Settings
  renderer/src/components/ TileGrid, GridOverlay, CompareSlider, ProviderStatus, AutoDetectCard
  renderer/src/ipc.ts -> typed IPC client
  e2e/

## Code Style
```tsx
export function ProviderStatus({ provider }: { provider: ProviderId }) {
  const status = useSessionStatus(provider);          // "ready" | "logged-out" | "challenge" | ...
  return (
    <button onClick={() => ipc.sessions.open(provider, { visible: true })} aria-label={`${provider} login: ${status}`}>
      {label(status)}
    </button>
  );
}
```
Conventions: function components, no business logic in components (call IPC), all long actions show progress and are cancellable.

## Testing Strategy
- Component tests for GridOverlay math, TileGrid states, banners, prompt prefill/reset, and AutoDetectCard
  (confidence, low-confidence warning, override).
- E2E with fake provider: import -> setup -> run with injected captcha pause -> resume -> result -> export.
- Accessibility: keyboard-operable controls, focus order, contrast checked with automated audit.

## Boundaries
- Always: show the ToS/account-risk notice on first run; show a cost preview before any provider call; make pauses obvious; prefill the prompt from the category and keep it editable.
- Ask first: adding telemetry of any kind; adding new screens.
- Never: start a job without explicit user action; hide the provider window when user attention is required; launch the system default browser; auto-start a job from an Auto-detect suggestion.

## Success Criteria
- A new user completes import -> export on the fake provider in under 2 minutes without documentation.
- Pause banners appear within 1 second of a captcha/quota/logged-out event and offer a single action that resolves it.
- Per-tile re-run updates the result view without restarting the job.
- Export writes a file whose dimensions match the plan's output size.
- No renderer code imports provider or session packages directly (IPC only).
- Selecting a category prefills the prompt with its default; the user can edit it and reset it.
- Auto-detect shows the suggested category, confidence, and top alternatives; the user can override, and
  no job starts automatically.
- Settings states that provider windows use the built-in browser; the app never launches the system default.

## Open Questions
None.
