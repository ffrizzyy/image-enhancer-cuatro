# Implementation Plan: Local Image Enhancer

**Status:** Approved 2026-11-05 — Task 2 complete; Task 3 next.
**Plan version:** 1 (2026-11-05)
**Task list:** `tasks/todo.md`

## Overview

Build a local Electron desktop app that imports one image plus a prompt, slices it into 6/8/custom
overlapping tiles, enhances each tile through the user's manually logged-in consumer web account
(GPT, Gemini, Grok) by automating the provider UI, and stitches the results into one coherent image.

This is a **greenfield build**: the workspace contains only the nine `SPEC-*.md` files and no source,
no `package.json`, and no `tasks/` directory. The plan therefore also defines the repo structure,
toolchain, and verification commands.

## Inputs Read

| File | Contribution |
|---|---|
| `SPEC.md` | Capability map, build order, global stack/security/scope decisions |
| `SPEC-sessions.md` | Partitions, manual login, status detection, first-run notice |
| `SPEC-presets.md` | 19 prompt categories + `auto` meta-category, fidelity levels, prompt building, overrides |
| `SPEC-intake.md` | Import/validation/Job record, limits (50 MB, 8192 px) |
| `SPEC-slicer.md` | Overlapping grid planning, aspect padding, wrap mode, pure planning |
| `SPEC-providers.md` | `ProviderAdapter` interface, web-UI automation, typed errors, config-driven selectors |
| `SPEC-orchestrator.md` | Job state machine, pacing, quality gate, pause/resume, SQLite persistence |
| `SPEC-stitcher.md` | Normalize/align/color-match/blend/harmonize pipeline, seam metrics |
| `SPEC-app-ui.md` | Five screens, React/Zustand/Tailwind, typed IPC, accessibility, e2e |

All specs report **Open Questions: None**. The plan-level decisions (compute approach, platforms, extra
packages) were resolved with the user on 2026-11-05; see Resolved Decisions below.

## Architecture Decisions

1. **pnpm workspace monorepo.** `packages/*` for the eight modules plus a shared contracts package;
   `apps/desktop` holds Electron main, preload, renderer, and e2e. Package names use the `@ie/*` scope.
2. **`@ie/contracts` is the canonical type boundary.** Wire types (`Job`, `Tile`, `TilePlan`,
   `ProviderId`, `SessionStatus`, `JobState`, `TileState`, `PauseReason`, provider request/result/errors)
   and the typed IPC channel map live here. Module packages re-export them so the spec-level imports
   still work. This prevents renderer/main drift and avoids circular dependencies.
   **Confirmed:** add `@ie/contracts` only; no separate `@ie/testing` package.
3. **Contract-first, fake-first.** Define the job event stream and adapter interface before either side
   exists. A runtime fake adapter and fake event emitter let the Run/Result UI and the orchestrator be
   built in parallel, and power all e2e tests without accounts. **Confirmed:** the fake provider is
   available in dev/test builds only, never in packaged production builds.
4. **All privileged work in Electron main.** Sessions, providers, orchestrator, SQLite, and image I/O
   run in main. The renderer gets paths, thumbnails, and typed events only. CPU-heavy stitching runs in
   a worker thread (or `utilityProcess`) so the UI never freezes.
5. **Electron security baseline.** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
   a minimal `contextBridge` API, Zod validation on every IPC payload, denied navigation and
   `window.open`, strict CSP in the renderer. No renderer import of session/provider packages.
6. **Selector/config-driven provider automation.** URLs, ordered selector fallbacks, timeouts, and
   quota/refusal/challenge markers live in versioned JSON validated by Zod. No selectors in code.
7. **Stitcher compute: pure TypeScript + `sharp`, no OpenCV by default.** Alignment uses normalized
   cross-correlation over a small ±8 px search window (downsampled grayscale), color matching works in
   Lab with a global least-squares solve, blending uses a tiled 3-level Laplacian pyramid on Float32
   buffers, and harmonization uses a heavily blurred source reference. Rationale: no native/WASM build
   risk, deterministic tests, one language. A benchmark gate (Task 22) is the only trigger for the
   documented `opencv-wasm` fallback. **Confirmed by human:** pure TS + `sharp`.
8. **SQLite via `better-sqlite3` in main, WAL mode.** Every state transition is committed before the
   next action. Accepted tiles are never re-run. `electron-rebuild` is wired from Phase 0 so native
   module packaging is de-risked early.
9. **Pacing defaults from spec:** concurrency 1, randomized delay 8–25 s, exponential backoff, hard
   pause (never a loop) on challenge/quota/logged-out.
10. **Quality gate is advisory-but-safe:** failing tiles retry at most twice, then become
    `needs-review`; they are never silently accepted. Thresholds are per fidelity level and live in
    config so they can be tuned without code changes.
11. **User data lives under `app.getPath('userData')`** (`%APPDATA%/image-enhancer` on Windows):
    `settings.json`, `jobs.db`, `jobs/<jobId>/` for intermediates and outputs, `overrides/` for preset
    template overrides. Shipped catalog files are never modified. **Confirmed:** keep intermediates and
    outputs until the job is deleted or the user clears job data.
12. **Out of scope for v1** (per spec): batch import, cloud sync, accounts, billing, API-key adapters,
    captcha solving, telemetry.
13. **v1 packaging target is Windows only.** Code stays cross-platform and avoids Windows-only APIs, but
    packaging, CI, and release verification target Windows (the current environment). macOS/Linux are
    post-v1. **Confirmed by human.**

14. **Auto-detect is a local meta-category.** `auto` is the 20th catalog entry (`kind: "auto"`, family
    `smart`). `intake` extracts deterministic `ImageFeatures` from a 256 px downscale;
    `presets.suggestCategory(features, prompt)` returns a ranked prompt-kind category with confidence and
    signals. No provider/network call and no new package. The resolved category's template/defaults are
    used; `buildPrompt` rejects `auto` directly. The UI always shows the suggestion and allows override;
    confidence <0.55 shows the top 3.
15. **Category defaults seed the prompt; the user can edit it.** Each prompt-kind category carries a
    `defaultPrompt`. Setup prefills the prompt box from it, including after Auto-detect resolves a
    category. The effective prompt is the trimmed user text or, if empty, the category default;
    `Job.prompt` stores the effective text and `promptSource`. Switching categories replaces the text
    only when it is empty or still equals the previous category's default; otherwise the edit is kept
    and a “Reset to category default” action is offered.
16. **Provider browser is the built-in Electron Chromium only.** No system-default browser is launched
    and there is no external-browser picker in v1. Settings states this explicitly; external-browser
    automation (Chrome/Edge/Brave via Playwright/CDP) is out of scope. **Confirmed by human.**

## Dependency Graph

```
                         @ie/contracts  (types + IPC channels + Zod)
                                   │
      ┌──────────────┬─────────────┼─────────────┬──────────────┐
      ▼              ▼             ▼             ▼              ▼
  sessions        presets        intake        slicer       providers
      │              │             │             │              │
      │              └──────►      │             │              │
      │                            │             │              │
      └──────────────┬─────────────┴─────────────┴──────────────┘
                     ▼
               orchestrator ─────────────► stitcher
                     │                          │
                     └────────────┬─────────────┘
                                  ▼
                    @ie/desktop  (main + preload + renderer + e2e)
```

Hard edges:

| From | To | Why |
|---|---|---|
| everything | `contracts` | shared types and IPC schemas |
| `intake` | `presets` | `categoryId` must exist in the catalog |
| `providers` | `sessions` | adapters drive the provider's logged-in `WebContentsView` |
| `orchestrator` | `intake`, `presets`, `slicer`, `providers` | Job, prompts, tile geometry, adapter calls |
| `stitcher` | `slicer` | consumes `TilePlan` geometry |
| `@ie/desktop` | all modules | main-process wiring; renderer talks IPC only |

**Critical path:** contracts → sessions → providers → GPT adapter → orchestrator → Run UI → per-tile
actions → e2e. Slicer, stitcher, and presets are parallel branches feeding that path.

## Execution Strategy

Work is sliced **vertically**: every task ends in a path a user (or a headless CLI equivalent) can
exercise through the real boundary — renderer → preload → IPC → main → module → back. Pure enabler
tasks (toolchain, contracts, schema) are deliberately tiny and are the only horizontal work.

Three parallel tracks start after the walking skeleton:

- **Inputs track:** sessions → settings login, presets → catalog, intake → Home/Setup.
- **Tile track:** slicer plan/extract/overlay; providers interface → GPT → Gemini/Grok.
- **Stitch track:** normalize/align → color/blend → harmonize/metrics/benchmark.

The orchestrator starts once the fake adapter and slicer contracts exist. Run/Result UI starts against
the fake event stream, so it is not blocked on real automation.

## Verification Commands

Defined once, referenced by tasks:

```bash
pnpm install
pnpm typecheck                 # tsc -b across all packages
pnpm lint
pnpm test                      # Vitest workspace, all packages
pnpm --filter @ie/<pkg> test
pnpm --filter @ie/<pkg> test -- --coverage
pnpm build
pnpm dev                       # Electron app in dev mode
pnpm package                   # unpacked Windows build smoke
pnpm --filter @ie/desktop e2e  # Playwright Electron, fake provider
pnpm --filter @ie/providers smoke -- --provider gpt   # manual live smoke
pnpm --filter @ie/orchestrator sim -- --tiles 8 --fail-rate 0.2
pnpm --filter @ie/stitcher metrics -- --job <jobId>
```

## Definition of Done (every task)

- [ ] `pnpm typecheck`, `pnpm lint`, and the task's focused tests pass.
- [ ] New behavior has tests; no skipped tests, no new `any`, no new `eslint-disable`/`@ts-ignore`.
- [ ] IPC inputs are Zod-validated; no credentials, cookies, or tokens are logged.
- [ ] The task's manual check is performed and its result noted in the PR/session.
- [ ] User-visible controls are keyboard-operable and have accessible names.
- [ ] Any new decision or deviation is appended to this plan.

## Task Sizing Note

`package.json` and `tsconfig.json` are scaffolding and are not counted against the ~5-file guideline.
Implementation files per task stay at five or fewer. Task 13a is six files plus fixtures because it
also extends the shared contracts; Task 25 is five implementation files plus two test files. Both are
explicitly flagged and may be split during implementation without renumbering.

## Phase 0 — Walking Skeleton

Goal: prove the riskiest platform plumbing (Electron + strict TS + pnpm + typed IPC + packaging) before
any product logic. Every task here ends in something observable.

### Task 1: Monorepo and toolchain baseline

**Outcome:** a clean checkout installs, typechecks, lints, and runs tests with no product code.

**Description:** Create the pnpm workspace, strict TypeScript base, ESLint/Prettier, Vitest workspace,
and root scripts used by every later task.

**Acceptance criteria:**
- [ ] `pnpm-workspace.yaml` includes `apps/*` and `packages/*`; `engines.node >= 20`; `packageManager` pinned.
- [ ] `tsconfig.base.json` enables `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`.
- [ ] Root scripts exist: `typecheck`, `lint`, `test`, `build`, `dev`, `package`.
- [ ] `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test` all exit 0 on the empty workspace.

**Verification:**
- [ ] Run the four commands above.
- [ ] `pnpm lint` fails on a deliberately unused variable (sanity check), then passes after removal.

**Dependencies:** None
**Files likely touched:** `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `tsconfig.json`, `tools/placeholder.ts`, `eslint.config.js`, `.prettierrc`, `vitest.config.ts`, `.gitignore`
**Estimated scope:** S (config-only scaffold exception)

### Task 2: Shared contracts package

**Outcome:** main and renderer compile against one typed source of truth for IPC and domain types.

**Description:** Create `@ie/contracts` with canonical domain types, Zod schemas, typed IPC channel map,
and an `IPC_VERSION` constant. Module packages will re-export these types.

**Acceptance criteria:**
- [ ] Exports `ProviderId`, `SessionStatus`, `Job`, `ImageAsset`, `ImageFeatures`, `CategorySuggestion`, `CategorySource`, `Tile`, `TilePlan`, `JobState`, `TileState`, `PauseReason`, `EnhanceRequest`, `EnhanceResult`, `ProviderErrorKind`, `StitchOptions`, `StitchResult`.
- [ ] Exports a typed IPC map covering app, sessions, presets, intake, slicer, jobs, stitch, export, settings, with request/response Zod schemas.
- [ ] Schemas reject malformed payloads and accept valid fixtures; `IPC_VERSION = 1`.
- [ ] `@ie/contracts` has no dependency on other workspace packages.

**Verification:**
- [ ] `pnpm --filter @ie/contracts test`
- [ ] `pnpm typecheck`
- [ ] Import smoke test in a second package resolves every exported type.

**Dependencies:** Task 1
**Files likely touched:** `packages/contracts/package.json`, `tsconfig.json`, `tsconfig.test.json`, `src/types.ts`, `src/ipc.ts`, `src/index.ts`, `test/ipc.test.ts`, `test/exports.test.ts`
**Estimated scope:** M (6 files)

### Task 3: Electron main, preload, and typed IPC ping

**Outcome:** a launched app can call a real main-process handler and render its response.

**Description:** Create the Electron main process, a sandboxed preload bridge, and one `app.ping`
handler validated by Zod. Apply the security baseline now so later screens inherit it.

**Acceptance criteria:**
- [ ] `pnpm dev` opens a window; the window uses `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- [ ] Preload exposes only `window.ie`; no Node globals leak into the renderer.
- [ ] `app.ping` returns `{ version, ipcVersion }`; a malformed payload returns a typed error, not a crash.
- [ ] Navigation to external URLs and `window.open` are denied; a CSP is set for the renderer.

**Verification:**
- [ ] `pnpm dev` manual check: ping value visible.
- [ ] `pnpm --filter @ie/desktop test` (handler + validation unit tests).
- [ ] `pnpm typecheck`.

**Dependencies:** Task 2
**Files likely touched:** `apps/desktop/package.json`, `main/index.ts`, `main/ipc/app.ts`, `preload/index.ts`, `test/ipc-app.test.ts`
**Estimated scope:** M (5 files)

### Task 4: Renderer shell, routes, and typed IPC client

**Outcome:** a navigable five-screen shell that calls IPC through a typed client.

**Description:** Add React + Vite + Tailwind + Zustand, the five route stubs (Home, Setup, Run, Result,
Settings), keyboard-accessible navigation, and the typed `ipc` client wrapper.

**Acceptance criteria:**
- [ ] All five routes render; navigation works with keyboard only; focus is visible.
- [ ] `ipc.app.ping()` is fully typed and rendered on Home; no `any` in the client.
- [ ] Components contain no business logic; state lives in a Zustand store.
- [ ] Component test renders the shell, navigates, and asserts the ping result.

**Verification:**
- [ ] `pnpm --filter @ie/desktop test`
- [ ] `pnpm dev` manual navigation check.
- [ ] `pnpm lint` and `pnpm typecheck`.

**Dependencies:** Task 3
**Files likely touched:** `apps/desktop/renderer/src/main.tsx`, `App.tsx`, `routes.tsx`, `ipc.ts`, `store.ts`, `components/Nav.tsx`, `test/shell.test.tsx`
**Estimated scope:** M (6 files)

### Task 5: Packaging and CI smoke

**Outcome:** a packaged Windows build launches and pings, and CI enforces the baseline.

**Description:** Configure `electron-builder` for an unpacked Windows build, wire `electron-rebuild`
for future native modules, and add a CI workflow running install/typecheck/lint/test/build/package.

**Acceptance criteria:**
- [ ] `pnpm package` produces an unpacked app that launches and completes the ping.
- [ ] CI runs on `windows-latest` and fails on typecheck, lint, or test errors.
- [ ] Packaging, CI, and release verification target Windows only for v1; macOS/Linux are post-v1.
- [ ] Native-module rebuild configuration is present and documented, even though no native module ships yet.
- [ ] Build artifacts are uploaded from CI.

**Verification:**
- [ ] `pnpm package` then launch the produced executable manually.
- [ ] CI run is green on the scaffold commit.
- [ ] `pnpm build`.

**Dependencies:** Task 4
**Files likely touched:** `electron-builder.yml`, `.github/workflows/ci.yml`, `scripts/package-smoke.mjs`, `apps/desktop/package.json`
**Estimated scope:** S (4 files)

### Checkpoint A — After Tasks 1–5

- [ ] `pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build` pass.
- [ ] `pnpm dev` opens the app; all five routes are reachable; IPC ping works.
- [ ] `pnpm package` produces a launchable unpacked build.
- [ ] CI is green.
- [ ] **Review with human before starting Phase 1.**

## Phase 1 — Inputs (sessions, presets, intake)

Goal: a user can log in to a provider, import an image, pick a category, and configure a job — with no
provider generation yet. Three tracks run in parallel after Task 5.

### Task 6: Sessions — partitions and SessionManager

**Outcome:** each provider has an isolated persistent browser session that can be opened and cleared.

**Description:** Implement `persist:gpt|gemini|grok` partitions, `open()`, `status()` plumbing, and
`clear()`. Windows are created hidden by default.

**Acceptance criteria:**
- [ ] `open(provider)` returns a handle backed by a `WebContentsView` on the correct partition.
- [ ] A cookie set in the GPT partition is not visible in the Gemini partition (integration test).
- [ ] `clear(provider)` removes cookies and storage for that provider only.
- [ ] No cookie values, passwords, or tokens appear in logs; `status()` is read-only.

**Verification:**
- [ ] `pnpm --filter @ie/sessions test`
- [ ] Integration test with two partitions.
- [ ] `pnpm typecheck` and `pnpm lint`.

**Dependencies:** Task 2
**Files likely touched:** `packages/sessions/package.json`, `tsconfig.json`, `src/partitions.ts`, `src/SessionManager.ts`, `src/types.ts`, `test/partitions.test.ts`
**Estimated scope:** M (6 files)

### Task 7: Sessions — health detection and provider config

**Outcome:** the app can say whether a provider is ready, logged out, challenged, or quota-limited.

**Description:** Add `config/providers.json` (login URL, logged-in probe, challenge/quota markers) with
a Zod schema, and implement `health.ts` against saved HTML fixtures.

**Acceptance criteria:**
- [ ] Config validates for all three providers; every required key is present.
- [ ] `status()` maps fixtures to `ready`, `logged-out`, `challenge`, `quota-limited`, `unknown` for each provider.
- [ ] Unknown/missing selectors degrade to `unknown`, never throw.
- [ ] Fixture tests cover at least four states per provider.

**Verification:**
- [ ] `pnpm --filter @ie/sessions test`
- [ ] Config parity test fails when a probe key is removed.
- [ ] `pnpm typecheck`.

**Dependencies:** Task 6
**Files likely touched:** `packages/sessions/src/health.ts`, `config/providers.json`, `src/schema.ts`, `test/health.test.ts`, `test/fixtures/*`
**Estimated scope:** M (5 files + fixtures)

### Task 8: Settings — provider login path and first-run risk notice

**Outcome:** a user opens Settings, logs in manually, sees live status, and acknowledges the risk notice once.

**Description:** Wire session IPC handlers, build `ProviderStatus` cards, auto-show the provider window
on `logged-out`/`challenge`, add clear-with-confirm, and persist the first-run ToS/account-risk
acknowledgement.

**Acceptance criteria:**
- [ ] Settings lists GPT/Gemini/Grok with live status and an "Open login" action.
- [ ] The provider window auto-shows within 1 s when status becomes `logged-out` or `challenge`.
- [ ] The risk notice blocks first use until acknowledged; acknowledgement survives restart.
- [ ] Settings states that provider windows use the app's built-in browser and never launch the system default; no browser picker is shown.
- [ ] Login persists across an app restart for at least one real provider (manual).
- [ ] `clear` requires confirmation and removes the session.

**Verification:**
- [ ] `pnpm --filter @ie/desktop test`
- [ ] Manual: log in to GPT, restart, status stays `ready`.
- [ ] Manual: delete cookies in the provider window, status flips and the window shows.

**Dependencies:** Tasks 7, 4
**Files likely touched:** `apps/desktop/main/ipc/sessions.ts`, `main/settingsStore.ts`, `renderer/src/screens/Settings.tsx`, `components/ProviderStatus.tsx`, `components/RiskNotice.tsx`, `test/settings.test.tsx`
**Estimated scope:** M (6 files)

### Task 9: Presets — schema, prompt builder, and four representative categories

**Outcome:** choosing a category changes the prompt and default job settings deterministically.

**Description:** Implement the Zod `Category` schema, `buildPrompt(category, userPrompt, tile)`, and
four categories spanning the behaviors: `env-realistic`, `char-realistic`, `texture-material`, `custom`.
Each category carries a `defaultPrompt` used to prefill Setup; the user can edit it.

**Acceptance criteria:**
- [ ] Schema requires a 1–2000 char `defaultPrompt` for every prompt-kind category; `buildPrompt` receives the effective prompt.
- [ ] `buildPrompt` substitutes `{{userPrompt}}`, `{{tileRole}}`, `{{fidelityClause}}` and includes the user prompt verbatim.
- [ ] Output is deterministic for identical input; corner vs center produces different text.
- [ ] `char-realistic` includes the identity-lock clause; `texture-material` sets `wrap: true`.
- [ ] Golden snapshots exist for each category × tile role.

**Verification:**
- [ ] `pnpm --filter @ie/presets test -- --coverage` (≥90% for `src/`).
- [ ] `pnpm --filter @ie/presets run validate-catalog`.
- [ ] `pnpm typecheck`.

**Dependencies:** Task 2
**Files likely touched:** `packages/presets/package.json`, `src/schema.ts`, `src/buildPrompt.ts`, `src/index.ts`, `src/catalog/{env-realistic,char-realistic,texture-material,custom}.json`, `test/buildPrompt.test.ts`
**Estimated scope:** M (6 files + data)

### Task 10: Presets — complete 19-category catalog and validation

**Outcome:** all 19 categories load, validate, and enforce catalog rules.

**Description:** Add the remaining 15 category JSON files (`env-stylized`, `props-realistic`,
`props-stylized`, `char-stylized`, `creature-realistic`, `creature-stylized`, `vehicle-hardsurface`,
`architecture-interior`, `landscape-matte`, `photo-restore`, `lineart-to-render`, `pixel-art`,
`product-still`, `isometric-asset`, `icon-ui`), the `validate-catalog` script, id-uniqueness checks,
and `custom` template validation.

**Acceptance criteria:**
- [ ] All 19 prompt-kind ids are unique and schema-valid; `validate-catalog` exits non-zero on a bad file. (The `auto` meta-category is added in Task 13a.)
- [ ] `custom` rejects templates missing `{{userPrompt}}` with a specific error.
- [ ] Character/creature categories carry the identity-lock clause and face-splitting warning.
- [ ] `texture-material` exposes the wrap flag consumed by slicer/stitcher.
- [ ] Every prompt-kind category has a non-empty `defaultPrompt` ≤2000 chars; shipped ids are never renamed; templates contain no provider-specific wording.

**Verification:**
- [ ] `pnpm --filter @ie/presets run validate-catalog`
- [ ] `pnpm --filter @ie/presets test -- --coverage`
- [ ] Deliberately corrupt one JSON and confirm validation fails.

**Dependencies:** Task 9
**Files likely touched:** `packages/presets/src/catalog/*.json` (15 files), `src/validateCatalog.ts`, `test/catalog.test.ts`
**Estimated scope:** M (data-heavy, low logic)

### Task 11: Intake — validation, ImageAsset, and immutable Job

**Outcome:** any valid image becomes a validated `ImageAsset`; any invalid one yields a specific error;
a complete configuration becomes an immutable Job.

**Description:** Implement path/drag input, format/size/dimension validation, EXIF normalization, and
SHA-256 hashing in `importImage` → `ImageAsset`. Add `createJob(asset, config)` with ULID and
catalog/provider checks; it is called at Start, not at import.

**Acceptance criteria:**
- [ ] PNG/JPEG/WebP up to 50 MB and 8192 px per side are accepted; GIF/SVG/corrupt files are rejected with distinct error codes.
- [ ] EXIF orientation is applied; the original file is never modified; SHA-256 is recorded.
- [ ] `importImage` returns a frozen `ImageAsset` (id, path, width, height, sha256); it does not require a category or prompt.
- [ ] `createJob(asset, { prompt, categoryId, grid, providerId })` returns a frozen `Job`; an empty/whitespace prompt resolves to the category's `defaultPrompt`, and `promptSource` records `category-default` or `user`.
- [ ] `categoryId` must exist in the catalog; the stored prompt is 1–2000 chars; grid is 6/8/custom (rows, cols ≤ 6; overlap 0–40).

**Verification:**
- [ ] `pnpm --filter @ie/intake test -- --coverage` (≥90%).
- [ ] Integration test imports real fixtures and creates a Job from an asset.
- [ ] `pnpm typecheck`.

**Dependencies:** Tasks 10, 2
**Files likely touched:** `packages/intake/package.json`, `src/importImage.ts`, `src/validate.ts`, `src/createJob.ts`, `src/types.ts`, `test/intake.test.ts`, `test/fixtures/*`
**Estimated scope:** M (6 files + fixtures)

### Task 12: Home — import path to Setup

**Outcome:** a user drags an image onto Home and lands on Setup with a validated ImageAsset.

**Description:** Wire intake IPC, build the drag-drop/picker UI, show recent jobs, and navigate to
Setup with the created `ImageAsset`. Surface validation errors inline. No Job is created yet.

**Acceptance criteria:**
- [ ] Drag-drop and file picker both produce an `ImageAsset` and navigate to Setup.
- [ ] Invalid files show the specific validation message, not a generic failure.
- [ ] Recent jobs list renders an empty state in Phase 1; full job-store wiring and resume arrive with Task 27.
- [ ] The source file's bytes and mtime are unchanged after import.
- [ ] No Job exists until the user presses Start in Setup.

**Verification:**
- [ ] `pnpm --filter @ie/desktop test`
- [ ] Manual: import PNG/JPEG/WebP and one corrupt file.
- [ ] `pnpm typecheck`.

**Dependencies:** Tasks 11, 4
**Files likely touched:** `apps/desktop/main/ipc/intake.ts`, `renderer/src/screens/Home.tsx`, `components/DropZone.tsx`, `components/RecentJobs.tsx`, `test/home.test.tsx`
**Estimated scope:** M (5 files)

### Task 13: Setup — category, prompt, provider, and grid configuration

**Outcome:** a user configures a complete job draft; Start creates the Job and opens the Run screen.

**Description:** Build the Setup form: category picker grouped by family with descriptions/warnings and
defaults, a prompt box prefilled from the category's `defaultPrompt` and fully editable, a provider
picker with live status, and numeric grid selection. The grid overlay arrives in Task 16. Start calls
`createJob` and navigates to Run; execution wiring arrives in Phase 3.

**Acceptance criteria:**
- [ ] Selecting a category applies its default fidelity, grid, and overlap and shows its warnings.
- [ ] Selecting a category prefills the prompt box with its `defaultPrompt`; if the user has edited the prompt, the edit is kept and a “Reset to category default” action is shown.
- [ ] Prompt input accepts 0–2000 chars; empty resolves to the category default at Start; >2000 shows an accessible error.
- [ ] Provider picker shows live session status; Start is disabled with a visible reason unless status is `ready`.
- [ ] Draft survives navigation to Home and back.
- [ ] Grid accepts 6, 8, and custom rows×cols up to 6×6 with overlap 0–40.
- [ ] Start creates an immutable Job via IPC and navigates to Run; no Job exists before Start.

**Verification:**
- [ ] `pnpm --filter @ie/desktop test`
- [ ] Manual: switch categories and confirm defaults change.
- [ ] Manual: edit the prompt, switch categories, confirm the edit is preserved and Reset works.
- [ ] Keyboard-only run through the form.

**Dependencies:** Tasks 10, 12, 8
**Files likely touched:** `renderer/src/screens/Setup.tsx`, `components/CategoryPicker.tsx`, `components/ProviderPicker.tsx`, `hooks/useJobDraft.ts`, `test/setup.test.tsx`
**Estimated scope:** M (5 files)

### Task 13a: Auto-detect engine — image features and category suggestion

**Outcome:** given an imported image and prompt, the app returns a ranked, explainable category
suggestion entirely offline.

**Description:** Add the `auto` meta-category (`kind: "auto"`, family `smart`), deterministic
`ImageFeatures` extraction in intake using a 256 px downscale, and `suggestCategory(features, prompt)`
in presets. No provider call, no new package, no learned model in v1.

**Acceptance criteria:**
- [ ] `auto` validates as `kind: "auto"`, family `smart`, and is listed first; `buildPrompt("auto", …)` rejects it with a typed `AutoCategoryError`.
- [ ] Schema requires `template` only for `kind: "prompt"`; `auto` may omit it; `defaultPrompt` is required only for prompt-kind categories.
- [ ] `extractFeatures` returns deterministic `ImageFeatures`: dimensions, aspect, saturation, colorfulness, edge density, high-frequency energy, palette size, blockiness, blur variance, noise estimate, transparency ratio, luminance bimodality.
- [ ] Feature extraction completes in <200 ms for a 50 MB / 8192 px input (analysis only) on the reference machine.
- [ ] Features are computed once per ImageAsset and cached; Re-detect reuses the cache unless the image changes.
- [ ] `suggestCategory(features, prompt)` returns `{ categoryId, confidence, alternatives (top 3), signals }`, never `auto` or `custom`, and is deterministic.
- [ ] The resolved category's `defaultPrompt` is available to Setup; `auto` itself never supplies a usable prompt.
- [ ] Confidence <0.55 sets `lowConfidence: true`; the fallback is always a prompt-kind category.
- [ ] On a labeled fixture set (≥20 images), top-1 family matches ≥70%; synthetic pixel-art, line-art, texture, and low-contrast/restore cases pass; no fixture returns an invalid category.

**Verification:**
- [ ] `pnpm --filter @ie/presets test -- --coverage`
- [ ] `pnpm --filter @ie/intake test -- --coverage`
- [ ] `pnpm --filter @ie/presets run validate-catalog`
- [ ] Manual: record suggestions for the labeled fixture set.

**Dependencies:** Tasks 10, 11
**Files likely touched:** `packages/contracts/src/types.ts`, `packages/presets/src/schema.ts`, `src/catalog/auto.json`, `src/suggestCategory.ts`, `packages/intake/src/features.ts`, `test/fixtures/auto/*`, tests
**Estimated scope:** M (6 files + fixtures)

### Task 13b: Setup — Auto-detect UI and override

**Outcome:** selecting Auto shows the detected category, confidence, and alternatives, and lets the
user override before Start.

**Description:** Add the Smart group/pinned Auto card, an `AutoDetectCard`, a `presets.suggestCategory`
IPC handler, and draft wiring. Detection runs on selection and on Re-detect; the resolved category
drives defaults and the prompt.

**Acceptance criteria:**
- [ ] Auto appears first in the picker (Smart group) with a one-line explanation.
- [ ] Selecting Auto runs detection and shows “Detected: <name> (<confidence>%)”, the top 3 alternatives, and a short signal summary.
- [ ] Low confidence (<55%) shows a warning and the top 3; the user can confirm or override with one click.
- [ ] Overriding applies the chosen category's defaults/template/`defaultPrompt`; keeping the suggestion records `categorySource: "auto"` and confidence in the Job.
- [ ] After detection, the prompt box is prefilled with the resolved category's `defaultPrompt` only if it is empty or still equals the previous default; user edits are preserved.
- [ ] Detection is local, never calls a provider, and never starts a job.
- [ ] Re-detect uses the current prompt text and cached image features.
- [ ] Re-detect, loading, and error states work; the card is keyboard-operable.

**Verification:**
- [ ] `pnpm --filter @ie/desktop test`
- [ ] Manual: run Auto on the labeled fixtures, override, and confirm the Job records the source.
- [ ] Assert no provider/session call is made during detection.

**Dependencies:** Tasks 13a, 13
**Files likely touched:** `renderer/src/components/CategoryPicker.tsx`, `components/AutoDetectCard.tsx`, `screens/Setup.tsx`, `hooks/useJobDraft.ts`, `main/ipc/presets.ts`, `test/autoDetect.test.tsx`
**Estimated scope:** M (6 files)

### Checkpoint B — After Tasks 6–13b

- [ ] All package tests and coverage thresholds pass; `pnpm typecheck && pnpm lint` pass.
- [ ] Manual: log in to GPT, restart the app, status remains `ready`.
- [ ] Manual: import a valid image → `ImageAsset`; choose a category; Start creates a Job; no Job exists before Start.
- [ ] All 19 prompt categories plus `auto` validate; every prompt category has a default prompt; invalid imports produce specific errors.
- [ ] Auto-detect returns a suggestion with confidence/alternatives on the fixture set; low-confidence and override paths work; no provider call is made.
- [ ] Prompt box is prefilled from the category default, remains editable, and preserves user edits across category switches.
- [ ] No provider generation has been triggered yet.
- [ ] **Review with human before starting Phase 2.**

## Phase 2 — Tile Pipeline (slicer, providers, stitcher)

Goal: produce correct tiles, drive one real provider call, and stitch tiles back. Three tracks run in
parallel; the GPT live smoke is the project's main risk gate.

### Task 14: Slicer — pure tile planning

**Outcome:** any supported size/grid produces a deterministic, geometrically valid tile plan.

**Description:** Implement `plan.ts` for 6 (3×2) and 8 (4×2) presets oriented by image aspect, custom
grids up to 6×6, overlap, aspect padding, edge/role metadata, and wrap mode.

**Acceptance criteria:**
- [ ] Cores are disjoint and exactly cover the source; remainders go to the last row/column.
- [ ] Every `send` rect is within 2% of a supported aspect ratio; padding uses neighbors or edge reflection.
- [ ] `wrap` makes outer overlap come from the opposite edge.
- [ ] Planning 6×6 on 8192×8192 completes in <100 ms.
- [ ] Property tests cover odd, extreme-aspect, and tiny fixtures.

**Verification:**
- [ ] `pnpm --filter @ie/slicer test:prop`
- [ ] `pnpm --filter @ie/slicer test -- --coverage`
- [ ] `pnpm typecheck`.

**Dependencies:** Task 2
**Files likely touched:** `packages/slicer/package.json`, `src/plan.ts`, `src/types.ts`, `test/plan.prop.test.ts`, `test/plan.test.ts`
**Estimated scope:** M (5 files)

### Task 15: Slicer — tile extraction and round-trip proof

**Outcome:** extracting tiles and stitching them unchanged reproduces the source exactly.

**Description:** Implement crop-only PNG extraction, tile metadata output, and a shared round-trip test
helper used by both slicer and stitcher.

**Acceptance criteria:**
- [ ] Extraction never resamples; each tile is a pure crop plus context padding.
- [ ] Tile files and metadata are written to the job temp directory with stable names.
- [ ] Slice → unchanged stitch is pixel-identical to the source for all fixtures.
- [ ] The original image is never modified.

**Verification:**
- [ ] `pnpm --filter @ie/slicer test`
- [ ] Round-trip pixel diff is zero on 1001×777, 4000×500, and 512×512.
- [ ] `pnpm typecheck`.

**Dependencies:** Task 14
**Files likely touched:** `packages/slicer/src/extract.ts`, `test/extract.test.ts`, `test/roundTrip.test.ts`, `src/index.ts`
**Estimated scope:** S/M (4 files)

### Task 16: Setup — grid overlay and plan preview

**Outcome:** the user sees the actual tile grid and overlap drawn on the image before starting.

**Description:** Expose a slicer IPC preview, render the grid overlay, show overlap, and warn when a
core is under 384 px or above provider output size. Persist the plan into the job draft.

**Acceptance criteria:**
- [ ] Overlay geometry matches the plan exactly at every supported grid.
- [ ] Overlap is visually distinguishable; wrap mode is indicated.
- [ ] Warnings appear for cores <384 px and for tiles above the selected provider's output size.
- [ ] The plan is stored in the draft and reused by the orchestrator.
- [ ] Overlay math has unit tests; the selector is keyboard-operable.

**Verification:**
- [ ] `pnpm --filter @ie/desktop test`
- [ ] Manual: switch 6/8/custom and compare overlay to image edges.
- [ ] `pnpm typecheck`.

**Dependencies:** Tasks 14, 13
**Files likely touched:** `apps/desktop/main/ipc/slicer.ts`, `renderer/src/components/GridOverlay.tsx`, `screens/Setup.tsx`, `test/gridOverlay.test.tsx`
**Estimated scope:** S/M (4 files)

### Task 17: Providers — interface, config schema, WebAdapter skeleton, fake adapter

**Outcome:** the orchestrator can call any adapter identically, and tests can run with no accounts.

**Description:** Implement `ProviderAdapter`, typed `ProviderError`, the config Zod schema, shared
`WebAdapter` step skeleton, and a fake adapter with injectable failure modes.

**Acceptance criteria:**
- [ ] Interface and error kinds match the spec exactly; adapters never throw plain `Error`.
- [ ] Config schema validates URLs, ordered selector fallbacks, timeouts, and state markers.
- [ ] A parity test fails if a selector key required by `WebAdapter` is missing from any provider config.
- [ ] Fake adapter supports `ok`, `timeout`, `quota`, `refusal`, `challenge`, `logged-out`, `download-failed`, with deterministic seeds.
- [ ] The fake adapter is excluded from production builds; it is selectable only in dev/test.
- [ ] Shared contract suite passes against the fake adapter; base coverage ≥85%.

**Verification:**
- [ ] `pnpm --filter @ie/providers test -- --coverage`
- [ ] `pnpm --filter @ie/providers test:contract`
- [ ] `pnpm typecheck`.

**Dependencies:** Task 2
**Files likely touched:** `packages/providers/package.json`, `src/ProviderAdapter.ts`, `src/base/WebAdapter.ts`, `src/config/schema.ts`, `src/adapters/fake.ts`, `test/contract.spec.ts`
**Estimated scope:** M (6 files)

### Task 18: GPT — config, fixtures, health, and contract tests

**Outcome:** GPT's page states and selectors are captured and validated without a live account.

**Description:** Add `config/gpt.json` with ordered selector fallbacks, state markers, and conservative
capability values (3 attachments, 1:1/2:3/3:2 aspects, ~1024 px output), saved DOM fixtures for every
state, `health()`, and the shared contract suite for GPT.

**Acceptance criteria:**
- [ ] `gpt.json` validates; `health()` reports missing selectors without throwing.
- [ ] Fixtures exist for idle, generating, done, quota, refusal, challenge, logged-out.
- [ ] Contract suite passes for GPT on fixtures.
- [ ] Changing a selector in config alone fixes a simulated UI change.

**Verification:**
- [ ] `pnpm --filter @ie/providers test:contract`
- [ ] `pnpm --filter @ie/providers health`
- [ ] Remove a selector key and confirm `ui-changed` names it.

**Dependencies:** Task 17
**Files likely touched:** `packages/providers/config/gpt.json`, `src/adapters/gpt.ts`, `test/fixtures/gpt/*`, `test/gpt.contract.spec.ts`
**Estimated scope:** M (5 files + fixtures)

### Task 19: GPT — enhance path and live smoke (risk gate)

**Outcome:** a real logged-in GPT session returns a full-resolution enhanced image for one tile.

**Description:** Implement the full `enhance()` flow: new chat per call, ordered attachments with
thumbnail verification, clipboard-style prompt insertion, submit, mutation-based wait, in-page download,
and error classification. Run the manual live smoke.

**Acceptance criteria:**
- [ ] Each call opens a new chat and verifies all attachments before submitting.
- [ ] The wait is mutation/observer-based; no fixed sleeps.
- [ ] Every UI wait has an explicit timeout and surfaces `timeout` rather than hanging.
- [ ] The image is downloaded at original resolution via in-page fetch (cookies preserved), never a screenshot.
- [ ] Every failure state maps to exactly one `ProviderErrorKind`.
- [ ] Manual live smoke returns an image ≥1024 px on its longest side.
- [ ] Measured `maxAttachments`, `outputAspects`, and `approxOutputPx` are recorded and written back to `gpt.json`.

**Verification:**
- [ ] `pnpm --filter @ie/providers test:contract`
- [ ] `pnpm --filter @ie/providers smoke -- --provider gpt` (manual, logged-in account)
- [ ] `pnpm --filter @ie/providers test -- --coverage` (base ≥85%).

**Dependencies:** Tasks 18, 8
**Files likely touched:** `packages/providers/src/adapters/gpt.ts`, `src/base/WebAdapter.ts`, `config/gpt.json`, `scripts/smoke.ts`, `test/gpt.enhance.spec.ts`
**Estimated scope:** M/L (5–6 files) — **highest-risk task**

### Task 20: Stitcher — normalize and align

**Outcome:** provider outputs are returned to tile geometry and small offsets are corrected.

**Description:** Resize each output to its `send` rect, crop context padding, estimate translation with
normalized cross-correlation over ±8 px, and flag larger shifts.

**Acceptance criteria:**
- [ ] Normalization never stretches non-uniformly and drops padding correctly.
- [ ] Synthetic ±6 px shifts are corrected; shifts >8 px flag the tile as `needs-review`.
- [ ] Alignment runs on downsampled grayscale for speed and returns integer pixel offsets.
- [ ] Unit tests cover zero, positive, negative, and out-of-range shifts.

**Verification:**
- [ ] `pnpm --filter @ie/stitcher test`
- [ ] Synthetic fixture assertions.
- [ ] `pnpm typecheck`.

**Dependencies:** Task 15
**Files likely touched:** `packages/stitcher/package.json`, `src/normalize.ts`, `src/align.ts`, `test/align.test.ts`, `test/fixtures/*`
**Estimated scope:** M (5 files)

### Task 21: Stitcher — color matching and blending

**Outcome:** tiles blend into a coherent image with no per-tile color shift or hard seam.

**Description:** Implement Lab mean/variance matching solved globally across tiles, multiband Laplacian
blending, feather fallback, and minimum-error seam selection.

**Acceptance criteria:**
- [ ] Synthetic Lab casts are corrected to `maxDeltaE ≤ 3` in overlaps.
- [ ] `multiband` and `feather` modes both work; default remains `multiband`.
- [ ] Unchanged-tile round trip remains pixel-identical.
- [ ] Blending is tiled to bound peak memory on 8192×4096 inputs.

**Verification:**
- [ ] `pnpm --filter @ie/stitcher test`
- [ ] Round-trip pixel diff is zero.
- [ ] Synthetic color-cast assertions.

**Dependencies:** Task 20
**Files likely touched:** `packages/stitcher/src/colorMatch.ts`, `src/blend.ts`, `src/stitch.ts`, `test/colorBlend.test.ts`
**Estimated scope:** M (4–5 files)

### Task 22: Stitcher — harmonization, metrics, and performance gate

**Outcome:** the stitched result has a quality score, and the pipeline meets the performance budget.

**Description:** Add low-frequency harmonization, `seamScore`/`maxDeltaE` metrics, the metrics CLI, the
optional global-pass hook (reference only), and the benchmark.

**Acceptance criteria:**
- [ ] Harmonization reduces large-scale drift without adding detail.
- [ ] `seamScore ≤ 1.2` and `maxDeltaE ≤ 3` on synthetic tests; flagged tiles are reported, never dropped.
- [ ] 8 tiles at 8192×4096 stitch in <20 s on the reference laptop.
- [ ] `wrap` jobs produce seamScore ≤1.2 across opposite edges.
- [ ] If the benchmark fails, the plan records the `opencv-wasm` fallback decision before proceeding.

**Verification:**
- [ ] `pnpm --filter @ie/stitcher test`
- [ ] `pnpm --filter @ie/stitcher metrics -- --job <fixtureJob>`
- [ ] Benchmark recorded in the plan/PR.

**Dependencies:** Task 21
**Files likely touched:** `packages/stitcher/src/harmonize.ts`, `src/metrics.ts`, `src/stitch.ts`, `test/metrics.test.ts`, `scripts/metrics.ts`
**Estimated scope:** M (5 files)

**T22 outcome (2026-11-05):** `stitch()`, `harmonize()` and `seamScore()` are in `packages/stitcher`.
- Benchmark (`IE_BENCH=1 ... test benchmark`, 8 tiles, 8192x4096, tiles returned at 1536 px with colour casts): **~10.5-11 s total** on the dev machine (load 0.4, align 2.6-3.0, compose 5.4, write 1.6, peak RSS ~1.0 GB). Before optimisation it was 19.9 s (compose 14.5 s). Fixes: 32-bit blocked `transpose`, pyramid `reduce`/`expand` computing only kept samples, lookup-table colour correction for images of 65,536+ pixels. **No `opencv-wasm` fallback needed.**
- `seamScore` measures abrupt steps (second differences) of the stitched-over-source luminance ratio along each strip overlap, so noise, texture and content edges average out. Unit thresholds hold (seamScore <= 1.2, maxDeltaE <= 3 on shifted and colour-cast synthetic tiles, also in wrap mode). On the noisiest benchmark image it reads ~1.28 (white noise the blurred tiles do not have): informational, not asserted.
- Harmonization corrects only the *variation* of drift across the image (a smooth 16-cell multiplicative field, wrap-aware), never the overall tone.
- Deferred: the `metrics` CLI (`pnpm --filter @ie/stitcher metrics -- --job`) has nothing to point at until the orchestrator defines jobs (T25); `stitch()` returns the same numbers.
### Checkpoint C — After Tasks 14–22 (RISK GATE)

- [ ] Slice → unchanged stitch is pixel-identical on all fixtures.
- [ ] GPT live smoke returns a real image ≥1024 px (manual).
- [ ] All three tracks' tests pass; provider base coverage ≥85%.
- [ ] Stitcher benchmark meets <20 s at 8192×4096 for 8 tiles.
- [ ] **If the GPT live smoke fails, stop and reassess before investing in orchestrator/UI.**
- [ ] **Review with human before starting Phase 3.**

## Phase 3 — Orchestration and Run UI

Goal: a full job runs, survives pauses and restarts, and the user can watch and control it.

### Task 23: Orchestrator — SQLite store

**Outcome:** job and tile state survive crashes and restarts with no in-memory-only progress.

**Description:** Create the `jobs`, `tiles`, `attempts`, and `events` tables, migrations, WAL mode, and
atomic transactional updates in the user data folder.

**Acceptance criteria:**
- [ ] Schema covers job config, plan, state, pause reason, per-tile state/attempts/output, and events.
- [ ] Every state change is committed in a transaction before the next action.
- [ ] Reopening the DB preserves state; WAL and `busy_timeout` are configured.
- [ ] Concurrent reads during a write do not corrupt or block indefinitely.

**Verification:**
- [ ] `pnpm --filter @ie/orchestrator test`
- [ ] Kill/reopen test preserves rows.
- [ ] `pnpm typecheck`.

**Dependencies:** Task 2
**Files likely touched:** `packages/orchestrator/package.json`, `src/store.ts`, `src/migrations/*.sql`, `test/store.test.ts`
**Estimated scope:** M (4–5 files)

### Task 24: Orchestrator — job state machine and resume

**Outcome:** jobs transition legally and resume from the first unfinished tile after a restart.

**Description:** Implement the XState machine for job/tile states and startup restoration of `running`
and `paused` jobs, skipping accepted tiles.

**Acceptance criteria:**
- [ ] States/transitions match the spec; illegal transitions are rejected.
- [ ] On startup, `running`/`paused` jobs restore; accepted tiles are never re-run.
- [ ] Property test: accepted tile count never decreases; no tile runs twice except retries/manual re-run.
- [ ] Cancelled and failed jobs are terminal and not resumed.

**Verification:**
- [ ] `pnpm --filter @ie/orchestrator test`
- [ ] Property tests with `fast-check`.
- [ ] Simulated restart test.

**Dependencies:** Task 23
**Files likely touched:** `src/jobMachine.ts`, `src/resume.ts`, `test/jobMachine.test.ts`, `test/resume.prop.test.ts`
**Estimated scope:** M (4 files)

### Task 25: Orchestrator — full job runner and simulation CLI

**Outcome:** an 8-tile job completes through the fake adapter with 20% injected failures.

**Description:** Implement preflight, prompt/attachment assembly (tile, downscaled global reference,
neighbor strip in chained mode), chained/independent modes, the quality gate, retries, and `needs-review`.
Add the `sim` CLI.

**Acceptance criteria:**
- [ ] Preflight checks adapter health, session `ready`, and produces a cost preview (tiles, rough time, quota note).
- [ ] `chained` uses raster order and concurrency 1; `independent` may run out of order.
- [ ] Attachments match the spec roles and order; the global reference is downscaled and never used as detail.
- [ ] Failing tiles retry at most twice with the preserve-composition clause, then become `needs-review`.
- [ ] `pnpm --filter @ie/orchestrator sim -- --tiles 8 --fail-rate 0.2` completes with every tile accepted or `needs-review`.

**Verification:**
- [ ] Simulation command above.
- [ ] Quality-gate fixture tests at all four thresholds.
- [ ] `pnpm --filter @ie/orchestrator test -- --coverage`.

**Dependencies:** Tasks 24, 17, 14, 15, 10, 11
**Files likely touched:** `src/tileRunner.ts`, `src/preflight.ts`, `src/quality.ts`, `src/attachments.ts`, `src/cli/sim.ts`, `test/quality.test.ts`, `test/sim.integration.test.ts`
**Estimated scope:** M/L (7 files) — split further if implementation exceeds one session

### Task 26: Orchestrator — pauses, backoff, cancel, and crash recovery

**Outcome:** the job pauses safely on captcha/quota/logout and resumes without losing work.

**Description:** Map `ProviderError` kinds to pause/resume/retry behavior, add randomized pacing and
exponential backoff, user pause/resume/cancel, and a kill-mid-run integration test.

**Acceptance criteria:**
- [ ] `challenge`/`logged-out` pause and surface the provider window; `quota` pauses with a resume-after time; `ui-changed` fails the job with the missing selector.
- [ ] Pacing honors concurrency 1–2 and 8–25 s randomized delays; backoff applies to `timeout`/`ui-changed` retries.
- [ ] Kill the process mid-job, restart: accepted tiles are not re-run and the job continues.
- [ ] User pause/resume/cancel work at any non-terminal state; cancel is terminal.
- [ ] No busy loop on any pause condition.

**Verification:**
- [ ] Integration test kills the child process mid-run and asserts resume.
- [ ] Fake-adapter scenarios for each pause reason.
- [ ] `pnpm --filter @ie/orchestrator test`.

**Dependencies:** Task 25, 8
**Files likely touched:** `src/pacing.ts`, `src/pause.ts`, `src/jobMachine.ts`, `test/pause.integration.test.ts`, `test/pacing.test.ts`
**Estimated scope:** M (5 files)

### Task 27: Run screen — tile grid and live progress

**Outcome:** the user watches each tile move through its states in real time.

**Description:** Build the Run screen's tile grid with states/thumbnails and overall progress, driven by
typed IPC job events. Start against the fake event emitter, then connect the real orchestrator.

**Acceptance criteria:**
- [ ] The grid renders 6/8/custom layouts with per-tile state and thumbnail.
- [ ] Progress updates arrive as typed events; no polling loop in the renderer.
- [ ] Accepted/retrying/needs-review/failed states are visually distinct and accessible (not color-only).
- [ ] The view survives navigation away and back without losing state.
- [ ] The Home recent-jobs list loads from the job store and can resume a paused job.

**Verification:**
- [ ] `pnpm --filter @ie/desktop test`
- [ ] Manual fake-emitter run.
- [ ] Keyboard and screen-reader labels checked.

**Dependencies:** Tasks 4, 25
**Files likely touched:** `renderer/src/screens/Run.tsx`, `components/TileGrid.tsx`, `hooks/useJobEvents.ts`, `test/run.test.tsx`
**Estimated scope:** M (4–5 files)

### Task 28: Run screen — controls, banners, and cost preview

**Outcome:** the user can pause/resume/cancel, watch the provider, and resolve pauses in one click.

**Description:** Add controls, Watch mode, pause banners for captcha/logged-out/quota, and the preflight
cost preview with Start gating.

**Acceptance criteria:**
- [ ] Pause/Resume/Cancel call IPC and reflect state within 1 s.
- [ ] Watch mode keeps provider windows visible; otherwise they auto-show only when attention is required.
- [ ] Banners appear within 1 s of a pause event and offer one action that resolves it.
- [ ] Cost preview shows tile count, rough time, and quota note; Start is blocked when preflight fails.
- [ ] Every control is keyboard-operable and cancellable.

**Verification:**
- [ ] `pnpm --filter @ie/desktop test`
- [ ] Injected captcha scenario shows the banner and resumes after action.
- [ ] Manual keyboard-only control pass.

**Dependencies:** Tasks 27, 26
**Files likely touched:** `renderer/src/screens/Run.tsx`, `components/PauseBanner.tsx`, `components/CostPreview.tsx`, `hooks/useJobControl.ts`, `test/runControls.test.tsx`
**Estimated scope:** M (5 files)

### Checkpoint D — After Tasks 23–28

- [ ] 8-tile simulated job with 20% failures completes; every tile is accepted or explicitly `needs-review`.
- [ ] Kill/restart mid-job does not re-run accepted tiles.
- [ ] Quota/challenge pauses surface a reason and resume on user command without state loss.
- [ ] Preflight blocks a run when the session is not `ready`.
- [ ] Run screen banners appear within 1 s.
- [ ] **Review with human before starting Phase 4.**

## Phase 4 — Result and Export

Goal: accepted tiles become one image the user can inspect, fix, and export.

### Task 29: Result screen — compare, zoom, seam overlay, quality badge

**Outcome:** the user can judge the stitched result against the source.

**Description:** Build the before/after slider, zoom, seam overlay toggle, flagged-tile count, and
quality badge fed by stitcher metrics.

**Acceptance criteria:**
- [ ] Before/after slider works with mouse and keyboard; zoom is bounded and resettable.
- [ ] Seam overlay toggles without re-stitching.
- [ ] Quality badge reflects `seamScore`; flagged tiles are listed and linked to the grid.
- [ ] The screen loads metrics/results from IPC without blocking the UI.

**Verification:**
- [ ] `pnpm --filter @ie/desktop test`
- [ ] Manual compare on a synthetic job.
- [ ] Accessibility labels for slider and toggles.

**Dependencies:** Tasks 22, 4
**Files likely touched:** `renderer/src/screens/Result.tsx`, `components/CompareSlider.tsx`, `components/QualityBadge.tsx`, `test/result.test.tsx`
**Estimated scope:** M (4–5 files)

### Task 30: Export

**Outcome:** the user writes a final image whose dimensions match the plan.

**Description:** Add PNG/JPEG/WebP export via IPC with a save dialog, correct output dimensions, and
integer upscale when tiles came back larger than their cores.

**Acceptance criteria:**
- [ ] PNG, JPEG, and WebP export successfully with sensible quality defaults.
- [ ] Output dimensions match the plan's output size (or the documented integer upscale).
- [ ] Existing files are not overwritten without confirmation; the saved path is shown.
- [ ] Export is cancellable and reports errors without crashing.

**Verification:**
- [ ] `pnpm --filter @ie/desktop test`
- [ ] Manual export in all three formats; verify dimensions with `sharp`.
- [ ] `pnpm typecheck`.

**Dependencies:** Tasks 22, 29
**Files likely touched:** `apps/desktop/main/ipc/export.ts`, `packages/stitcher/src/export.ts`, `renderer/src/components/ExportDialog.tsx`, `test/export.test.ts`
**Estimated scope:** S/M (4 files)

### Task 31: Per-tile actions — backend

**Outcome:** a single problem tile can be fixed without restarting the whole job.

**Description:** Add re-run-single-tile, accept-as-is, and source/prompt override operations, followed
by a targeted restitch of affected regions.

**Acceptance criteria:**
- [ ] Re-running one tile does not change other tiles' state or outputs.
- [ ] Accept-as-is marks the tile accepted and records that it bypassed the gate.
- [ ] Overrides are persisted and used on re-run; restitch updates only affected regions.
- [ ] All operations are transactional and survive restart.
- [ ] Property test: other tiles' accepted outputs are never mutated.

**Verification:**
- [ ] `pnpm --filter @ie/orchestrator test`
- [ ] Integration test re-runs one tile and restitches.
- [ ] `pnpm typecheck`.

**Dependencies:** Tasks 25, 24
**Files likely touched:** `src/tileActions.ts`, `src/restitch.ts`, `src/store.ts`, `test/tileActions.test.ts`
**Estimated scope:** M (4 files)

### Task 32: Per-tile actions — Result UI

**Outcome:** the user fixes flagged tiles from the Result screen and sees the image update.

**Description:** Add the flagged-tile list and per-tile actions (re-run, accept, edit prompt/source) that
call IPC and refresh the result without restarting the job.

**Acceptance criteria:**
- [ ] Flagged tiles are listed with their reason and current state.
- [ ] Actions call IPC and show pending/success/error states.
- [ ] The result view refreshes after restitch without a full job restart.
- [ ] Keyboard users can reach and trigger every action.

**Verification:**
- [ ] `pnpm --filter @ie/desktop test`
- [ ] Manual: force a `needs-review` tile, fix it, confirm the result updates.
- [ ] Accessibility pass.

**Dependencies:** Tasks 31, 29
**Files likely touched:** `renderer/src/components/FlaggedTiles.tsx`, `screens/Result.tsx`, `hooks/useTileActions.ts`, `test/tileActions.test.tsx`
**Estimated scope:** M (4 files)

### Checkpoint E — After Tasks 29–32

- [ ] Full fake flow import → setup → run → stitch → compare → export completes in <2 min.
- [ ] Export dimensions match the plan.
- [ ] Per-tile re-run updates the result without restarting the job.
- [ ] Round-trip and stitch metrics still pass.
- [ ] **Review with human before starting Phase 5.**

## Phase 5 — Remaining Providers and Polish

Goal: all three providers work behind the same contract, settings are complete, and the app is
release-ready.

### Task 33: Gemini adapter

**Outcome:** Gemini works through the same adapter interface with no orchestrator changes.

**Description:** Add `config/gemini.json`, DOM fixtures, the adapter implementation, contract tests, and
a manual live smoke.

**Acceptance criteria:**
- [ ] Gemini passes the shared contract suite on fixtures.
- [ ] Manual live smoke returns an image ≥1024 px on its longest side.
- [ ] Every failure state maps to exactly one `ProviderErrorKind`.
- [ ] No orchestrator or UI code changes were required.

**Verification:**
- [ ] `pnpm --filter @ie/providers test:contract`
- [ ] `pnpm --filter @ie/providers smoke -- --provider gemini` (manual)
- [ ] `pnpm --filter @ie/providers test -- --coverage`.

**Dependencies:** Tasks 19, 17
**Files likely touched:** `config/gemini.json`, `src/adapters/gemini.ts`, `test/fixtures/gemini/*`, `test/gemini.contract.spec.ts`
**Estimated scope:** M (4 files + fixtures)

### Task 34: Grok adapter

**Outcome:** Grok works through the same adapter interface with no orchestrator changes.

**Description:** Add `config/grok.json`, DOM fixtures, the adapter implementation, contract tests, and a
manual live smoke.

**Acceptance criteria:**
- [ ] Grok passes the shared contract suite on fixtures.
- [ ] Manual live smoke returns an image ≥1024 px on its longest side.
- [ ] Every failure state maps to exactly one `ProviderErrorKind`.
- [ ] No orchestrator or UI code changes were required.

**Verification:**
- [ ] `pnpm --filter @ie/providers test:contract`
- [ ] `pnpm --filter @ie/providers smoke -- --provider grok` (manual)
- [ ] `pnpm --filter @ie/providers test -- --coverage`.

**Dependencies:** Tasks 19, 17
**Files likely touched:** `config/grok.json`, `src/adapters/grok.ts`, `test/fixtures/grok/*`, `test/grok.contract.spec.ts`
**Estimated scope:** M (4 files + fixtures)

### Task 35: Settings — template overrides, pacing presets, and data folder

**Outcome:** users can customize prompts and pacing without modifying shipped files.

**Description:** Build the template editor with save/reset overrides in the user data folder, Safe/Normal
pacing presets, the data-folder display/open action, and intermediate-file retention settings.

**Acceptance criteria:**
- [ ] Editing a template stores an override under `userData/overrides/`; shipped catalog files are never modified.
- [ ] `defaultPrompt` is editable in the template editor and reset with the rest of the category override.
- [ ] "Reset to default" removes the override and restores the shipped template.
- [ ] Safe/Normal presets change concurrency and delay bounds and persist.
- [ ] The data folder can be opened from Settings; "clear job data" requires confirmation.
- [ ] Settings documents the built-in-browser behavior; no system-default launch and no browser picker.
- [ ] Intermediates and outputs are retained until the job is deleted or data is cleared; no automatic pruning.
- [ ] The first-run risk notice can be reviewed again from Settings.
- [ ] Overrides are validated against the schema before saving.

**Verification:**
- [ ] `pnpm --filter @ie/desktop test`
- [ ] `pnpm --filter @ie/presets test`
- [ ] Manual: override, restart, confirm persistence, reset, confirm restoration.

**Dependencies:** Tasks 10, 8
**Files likely touched:** `packages/presets/src/overrides.ts`, `renderer/src/screens/Settings.tsx`, `components/TemplateEditor.tsx`, `main/settingsStore.ts`, `test/overrides.test.ts`
**Estimated scope:** M (5 files)

### Task 36: E2E, accessibility, and release hardening

**Outcome:** the complete flow is proven end to end without accounts, and the app is packageable.

**Description:** Add Playwright Electron e2e for import → setup → run with injected captcha → resume →
result → export on the fake provider, run an accessibility audit, verify renderer isolation, and produce
the packaged build.

**Acceptance criteria:**
- [ ] E2E covers the full flow with an injected captcha pause and resume.
- [ ] No renderer module imports provider/session/orchestrator/stitcher packages directly.
- [ ] Automated accessibility audit reports no serious/critical violations; keyboard-only flow passes.
- [ ] Packaged app launches, runs a fake job, and exports on Windows (v1 target).
- [ ] README documents setup, commands, data locations, and the ToS/account-risk notice.
- [ ] No open P0/P1 defects.

**Verification:**
- [ ] `pnpm --filter @ie/desktop e2e`
- [ ] `pnpm package` + manual smoke
- [ ] `pnpm test && pnpm typecheck && pnpm lint && pnpm build`.

**Dependencies:** Tasks 28, 30, 32, 33, 34, 35
**Files likely touched:** `apps/desktop/e2e/fullFlow.spec.ts`, `e2e/fixtures/*`, `playwright.config.ts`, `README.md`, `electron-builder.yml`
**Estimated scope:** M (5 files + fixtures)

### Checkpoint F — After Tasks 33–36

- [ ] All three adapters pass the shared contract suite; Gemini and Grok live smokes pass (manual).
- [ ] E2E full flow passes with an injected captcha.
- [ ] Accessibility audit is clean; keyboard-only flow works.
- [ ] Packaged app runs a fake job and exports.
- [ ] Every spec success criterion is checked off (see matrix below).
- [ ] **Final review with human; release candidate approved.**

## Spec Coverage Matrix

| Spec | Tasks |
|---|---|
| `SPEC.md` (stack, build order, global decisions) | 1–5, all |
| `SPEC-sessions.md` | 6, 7, 8, 26, 28 |
| `SPEC-presets.md` | 9, 10, 13, 13a, 13b, 25, 35 |
| `SPEC-intake.md` | 11, 12, 13, 13a |
| `SPEC-slicer.md` | 14, 15, 16 |
| `SPEC-providers.md` | 17, 18, 19, 33, 34 |
| `SPEC-orchestrator.md` | 23, 24, 25, 26, 31 |
| `SPEC-stitcher.md` | 20, 21, 22, 29, 30 |
| `SPEC-app-ui.md` | 4, 8, 12, 13, 13a, 13b, 16, 27, 28, 29, 30, 32, 35, 36 |

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Consumer web UI automation breaks or triggers captcha/account flags | High | Config-driven selectors with fallbacks; contract fixtures; fake-first; GPT live smoke at Task 19 as a hard gate; typed errors; pause-never-loop; secondary-account advice. |
| Provider ToS/account risk | High | Explicit first-run notice and acknowledgement; manual login only; no credential handling; document the risk in README. |
| Stitcher too slow or memory-heavy at 8192×4096 | Med-High | Benchmark gate at Task 22; tiled Float32 processing; downsampled alignment; documented `opencv-wasm` fallback; fail fast before UI polish. |
| `better-sqlite3` native rebuild/packaging failure | Med | Rebuild wiring and packaging smoke from Phase 0; pin Electron; CI on Windows; fallback to `sql.js` if blocked. |
| Quality gate false accepts or excessive `needs-review` | Med | Fixture corpus per fidelity; configurable thresholds; never auto-accept; per-tile fix loop in Result. |
| Auto-detect misclassifies the image | Med | Show confidence, top 3, and signals; low-confidence warning; one-click override; no auto-start; labeled fixture gate ≥70%; never return an invalid category. |
| Category default overwrites a user-edited prompt | Low-Med | Replace only when the prompt is empty or still equals the previous default; keep edits; explicit “Reset to category default” action. |
| Renderer freezes on large images | Med | All heavy work in main/worker; renderer receives paths/thumbnails/events only. |
| Session partition leakage or login loss | Med | Isolation integration test; persistence E2E; `clear()` scoped per provider. |
| Playwright Electron e2e flakiness | Med | Deterministic fake adapter seeds; injected events; retries only for infrastructure, not assertions. |
| Scope creep (batch, API adapters, telemetry) | Low-Med | Explicit out-of-scope list; "ask first" boundaries from specs. |
| Selector drift between providers | High | Versioned JSON configs; health check names the missing selector; live smoke per provider. |

## Resolved Decisions (2026-11-05)

| Decision | Choice | Where recorded |
|---|---|---|
| Stitcher compute | Pure TypeScript + `sharp`; `opencv-wasm` only if the Task 22 benchmark fails | Decision 7, Task 22 |
| Extra packages | `@ie/contracts` only; no `@ie/testing` package | Decision 2, Tasks 1–2 |
| v1 platforms | Windows only; macOS/Linux post-v1 | Decision 13, Tasks 5, 36 |
| Provider capabilities | Conservative seed, measured and written back during the GPT live smoke | Tasks 18–19 |
| Fake provider | Dev/test builds only; excluded from production | Decision 3, Tasks 17, 36 |
| Data retention | Keep intermediates/outputs until job deletion or explicit clear; `%APPDATA%/image-enhancer` | Decision 11, Task 35 |
| Auto-detect (new request) | Local deterministic heuristics; `auto` meta-category; no model/network call | Decision 14, Tasks 13a–13b |
| Prompt source (new request) | Category default prefilled; user-editable; empty falls back to default | Decision 15, Tasks 9, 13, 35 |
| Browser | Built-in Electron Chromium only; no system default, no external picker | Decision 16, Tasks 8, 35 |

## Open Questions

None. All plan-level decisions are resolved.

## Spec Deltas (applied 2026-11-05)

These requirements were added after the initial plan and should be folded into the specs when approved:

1. `SPEC-presets.md`: add the `auto` meta-category (`kind: "auto"`, family `smart`, `template` optional)
   and a `defaultPrompt` field to `CategorySchema`; `buildPrompt` rejects `auto`.
2. `SPEC-intake.md`: split `ImageAsset` from `Job`; `createJob` resolves an empty prompt to the
   category default and records `promptSource`.
3. `SPEC-app-ui.md`: Setup prompt box is prefilled from the category default and editable with a
   “Reset to category default” action; add the Auto-detect card and confidence/override behavior.
4. Browser selection: resolved — built-in Electron Chromium only; no system default and no picker.

## Out of Scope (v1)

Batch import, cloud sync, accounts, billing, API-key adapters, captcha solving, telemetry, comic-panel
presets, non-grid/content-aware slicing, generative seam inpainting, learned/ML category classifiers
(v1 auto-detect uses explainable heuristics), external-browser automation (Chrome/Edge/Brave via
Playwright/CDP).

## Plan Review Checklist

- [x] Every task has acceptance criteria.
- [x] Every task has a verification step.
- [x] Dependencies are identified and ordered.
- [x] Tasks are recorded in `tasks/todo.md`.
- [x] No pre-existing incomplete plan was overwritten (none existed).
- [x] No task exceeds ~5 files without an explicit note.
- [x] Checkpoints exist between phases.
- [x] Human has reviewed and approved this plan (2026-11-05).

---

**Approved 2026-11-05. Implementation in progress.** Task 2 is complete; see the Progress Log below.

## Progress Log

### 2026-11-05 — Task 1 complete

- `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` all exit 0.
- ESLint sanity check confirmed: an unused variable fails `pnpm lint`; removing it passes.
- Deviations recorded:
  - Used `vitest.config.ts` (with `passWithNoTests`) instead of `vitest.workspace.ts`; the workspace
    file is unnecessary until multiple Vitest projects exist.
  - Added `tsconfig.json` and `tools/placeholder.ts` so the strict base config is typechecked before
    the first package exists. The placeholder can be removed when `@ie/contracts` lands.
  - pnpm 12 blocks dependency build scripts by default; added `onlyBuiltDependencies: [esbuild]` to
    `pnpm-workspace.yaml` and ran `pnpm approve-builds --all` once.
  - `pnpm -r --if-present` prints “No projects matched the filters” until packages exist; it exits 0
    and the message disappears once `packages/*` are added.
  - ESLint 9.39.5 emits a deprecation warning (10.x is available). Kept 9.x for `typescript-eslint`
    compatibility; revisit before release.

### 2026-11-05 — Task 2 complete

- `@ie/contracts` exports the canonical domain types, all Zod schemas, `IPC_VERSION = 1`, the typed
  channel map, and `parseIpcRequest` / `parseIpcResponse` helpers.
- 20 IPC channels and 3 event channels have request/response schemas; the channel list is asserted in
  tests so a missing channel fails CI.
- `pnpm --filter @ie/contracts typecheck`, `pnpm --filter @ie/contracts test` (17 tests), root
  `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` all exit 0.
- Deviations / notes:
  - Added `tsconfig.test.json` so tests are typechecked without emitting them into `dist`.
  - The import smoke test resolves every required type through the package's own `exports` map. The
    first true cross-package import is `@ie/desktop` in Task 3.
  - Renamed the auto-detect channel to `presets.suggestCategory` to match the plan.
  - `CategorySchema` enforces `template` + `defaultPrompt` for `kind: "prompt"` and allows the `auto`
    meta-category to omit both; `CategorySuggestionSchema` rejects `auto`/`custom` results.

