# Task List: Local Image Enhancer

**Plan:** `tasks/plan.md` (v1, 2026-11-05)
**Status:** Approved 2026-11-05 — Tasks 1–5 complete; Checkpoint A human review next.
**Scope:** 38 tasks (T1–T36 plus T13a/T13b), 6 checkpoints.
**How to use:** check a task off only when its acceptance criteria and verification steps in
`tasks/plan.md` pass. Work top to bottom within a phase; parallel tracks are noted.

## Phase 0 — Walking Skeleton

- [x] **T1** Monorepo and toolchain baseline — deps: none
- [x] **T2** Shared contracts package (`@ie/contracts`) — deps: T1
- [x] **T3** Electron main, preload, typed IPC ping — deps: T2
- [x] **T4** Renderer shell, routes, typed IPC client — deps: T3
- [x] **T5** Packaging and CI smoke — deps: T4 (workflow written; first green CI run still unverified — repo has no remote yet)

### Checkpoint A — after T1–T5
- [x] typecheck, lint, test, build pass; app launches; IPC ping works; packaged build launches (re-verified clean 2026-11-05)
- [ ] CI green — N/A for now: project is not under git, so the workflow in `.github/` has never run
- [x] Human review before Phase 1 (done 2026-11-05)

## Phase 1 — Inputs (sessions, presets, intake)

Tracks after T5: sessions (T6–T8), presets (T9–T10), intake (T11–T13b, waits on T10).

- [x] **T6** Sessions: partitions and SessionManager — deps: T2
- [x] **T7** Sessions: health detection and provider config — deps: T6
- [x] **T8** Settings: provider login path, built-in-browser note, first-run risk notice — deps: T7, T4
- [x] **T9** Presets: schema, prompt builder, four representative categories — deps: T2
- [x] **T10** Presets: complete 19-category catalog and validation — deps: T9
- [x] **T11** Intake: validation, ImageAsset, immutable Job — deps: T10, T2
- [x] **T12** Home: import path to Setup (ImageAsset) — deps: T11, T4
- [x] **T13** Setup: category, prompt defaults, provider, grid — deps: T10, T12, T8
- [x] **T13a** Auto-detect engine: image features and category suggestion — deps: T10, T11 (accuracy measured on synthetic fixtures only; <200 ms met for JPEG, not for noisy PNG/WebP at 8192 px; manual run on real images still open)
- [x] **T13b** Setup: Auto-detect UI and override — deps: T13a, T13

### Checkpoint B — after T6–T13b
- [x] Login persists across restart; 19 prompt categories + auto validate; import creates an ImageAsset; Start creates a Job
- [x] Prompt box prefills from the category default, stays editable, and preserves edits across category switches
- [x] Auto-detect returns confidence + alternatives; low-confidence and override paths work; no provider call
- [x] Settings states provider windows use the built-in browser; no system default
- [x] No provider generation triggered
- [x] Human review before Phase 2 (manual checks done by the user)

## Phase 2 — Tile Pipeline (slicer, providers, stitcher)

Parallel tracks: slicer (T14–T16), providers (T17–T19), stitcher (T20–T22).

- [x] **T14** Slicer: pure tile planning — deps: T2
- [x] **T15** Slicer: tile extraction and round-trip proof — deps: T14
- [x] **T16** Setup: grid overlay and plan preview — deps: T14, T13
- [x] **T17** Providers: interface, config schema, WebAdapter skeleton, fake adapter — deps: T2
- [x] **T18** GPT: config, fixtures, health, contract tests — deps: T17 (states are simulated pages built from the config, in `test/support/chatPageSim.ts`; only the idle/attach/send/result structure was verified live)
- [x] **T19** GPT: enhance path and live smoke — deps: T18, T8  **[RISK GATE]** (live smoke passed 2026-11-05: 768x512 in, 1536x1024 out)
- [x] **T20** Stitcher: normalize and align — deps: T15
- [x] **T21** Stitcher: color matching and blending — deps: T20
- [x] **T22** Stitcher: harmonization, metrics, performance gate — deps: T21

### Checkpoint C — after T14–T22 (RISK GATE)
- [x] Slice → unchanged stitch pixel-identical; GPT live smoke ≥1024 px; stitcher <20 s at 8192×4096
- [x] **If GPT live smoke fails, stop and reassess** (it passed: 1536x1024)
- [x] Human review before Phase 3

## Phase 3 — Orchestration and Run UI

- [x] **T23** Orchestrator: SQLite store — deps: T2
- [x] **T24** Orchestrator: job state machine and resume — deps: T23
- [x] **T25** Orchestrator: full job runner and simulation CLI — deps: T24, T17, T14, T15, T10, T11
- [x] **T26** Orchestrator: pauses, backoff, cancel, crash recovery — deps: T25, T8
- [x] **T27** Run screen: tile grid and live progress — deps: T4, T25
- [x] **T28** Run screen: controls, banners, cost preview — deps: T27, T26

### Checkpoint D — after T23–T28
- [x] 8-tile fake job with 20% failures completes; kill/restart does not re-run accepted tiles
- [x] Pause banners <1 s; preflight blocks non-ready sessions
- [ ] Human review before Phase 4

## Phase 4 — Result and Export

- [x] **T29** Result screen: compare, zoom, seam overlay, quality badge — deps: T22, T4
- [x] **T30** Export (PNG/JPEG/WebP, correct dimensions) — deps: T22, T29
- [x] **T31** Per-tile actions: backend — deps: T25, T24 (a re-run restitches the whole picture; partial-region restitch not implemented)
- [x] **T32** Per-tile actions: Result UI — deps: T31, T29

### Checkpoint E — after T29–T32
- [x] Full fake flow import → export <2 min; dimensions match; per-tile re-run updates result (manual check done by the user, 2026-11-06)
- [x] Human review before Phase 5 (done by the user, 2026-11-06)

## Phase 5 — Remaining Providers and Polish

- [x] **T33** Gemini adapter — deps: T19, T17 (live check done by the user, 2026-11-06)
- [x] **T34** Grok adapter — deps: T19, T17 (live check done by the user, 2026-11-06)
- [x] **T35** Settings: template overrides, pacing presets, data folder, browser note — deps: T10, T8 (manual check done by the user)
- [x] **T36** E2E, accessibility, and release hardening — deps: T28, T30, T32, T33, T34, T35 (done: Playwright drives the real Electron window through import → setup → injected captcha pause → resume → result → PNG/JPEG/WebP export; renderer isolation test; axe audit; packaged Windows build runs a fake job and exports all three formats in `package-smoke`; E2E added to CI)

### Checkpoint F — after T33–T36
- [x] All adapters pass contract tests; Gemini/Grok live smokes pass
- [x] E2E with injected captcha passes; a11y audit clean; packaged app runs and exports
- [ ] All spec success criteria checked; release candidate approved (awaiting human sign-off)

## Parallelization Summary

- After T5: run sessions (T6–T8), presets (T9–T10), and intake (T11–T13b) concurrently; intake waits on T10.
- After T13b: run slicer (T14–T16), providers (T17–T19), and stitcher (T20–T22) concurrently.
- After T25: Run UI (T27) can proceed alongside pause handling (T26).
- Gemini (T33) and Grok (T34) can run concurrently after T19.
- T36 is last and depends on every user-facing track.

## Notes

- No existing `tasks/plan.md` or `tasks/todo.md` was overwritten; `tasks/` did not exist before this plan.
- Full acceptance criteria, verification steps, file lists, and scope estimates are in `tasks/plan.md`.
- All plan-level decisions are resolved; see "Resolved Decisions" in `tasks/plan.md`.
- New requests recorded in the plan: Auto-detect category (T13a/T13b), category-default prompts
  (T9, T13, T35), and built-in-browser-only behavior (T8, T35).
