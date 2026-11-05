# Spec: orchestrator

## Objective
Run a Job end to end through a provider: build each tile's prompt and attachments, dispatch tiles at
safe pace, validate results, and survive interruptions. Success: a job started once finishes with every
tile accepted, even across captchas, quota pauses, retries and app restarts, without redoing finished tiles.

## Consistency strategy (key to a seamless single image)
Each tile call (new chat per tile) attaches:
1. the tile itself (`send` rect),
2. a downscaled whole-image reference with the tile's position described in words in the prompt
   ("this is the top-right part of the attached full image"), no drawn boxes,
3. in `chained` mode, the already-enhanced overlap strip from the nearest finished neighbor.
Modes: `chained` (default; raster order, concurrency 1) and `independent` (faster, order-free, more seam risk).
Prompt text comes from `presets.buildPrompt(category, userPrompt, tile)`.

## Quality gate per tile
Accept an output only if: it decodes; dimensions are plausible; it is not a refusal or blank frame; a
low-frequency structural similarity against the source tile is above the fidelity-level threshold
(strict 0.90, preserve 0.80, balanced 0.65, reimagine 0.40). Failing tiles retry up to 2 times with a
stronger "preserve composition" clause, then are marked `needs-review` rather than silently accepted.

## Tech Stack
TypeScript strict, better-sqlite3 (job/tile state), XState (job state machine), sharp, Vitest.

## Commands
Build: pnpm --filter orchestrator build
Test: pnpm --filter orchestrator test -- --coverage
Simulated run (fake provider, no accounts): pnpm --filter orchestrator sim -- --tiles 8 --fail-rate 0.2

## Project Structure
packages/orchestrator/
  src/jobMachine.ts   -> job states
  src/tileRunner.ts   -> prompt/attachments -> provider call -> quality gate
  src/pacing.ts       -> delays, concurrency, backoff
  src/store.ts        -> SQLite persistence, atomic updates
  src/quality.ts      -> similarity + sanity checks
  test/fakeProvider.ts

## Code Style
```ts
type JobState = "idle" | "preflight" | "running" | "paused" | "needs-review" | "stitching" | "done" | "failed" | "cancelled";
type TileState = "pending" | "running" | "accepted" | "retrying" | "needs-review" | "failed";
type PauseReason = "challenge" | "logged-out" | "quota" | "user";

export interface Pacing { concurrency: 1 | 2; minDelayMs: number; maxDelayMs: number } // defaults 1, 8000, 25000
```
Conventions: every state change is written to SQLite before the next action; no in-memory-only progress.

## Behavior
- Preflight: provider health(), session status "ready", cost preview (tile count, rough time, quota note).
- Pacing: randomized delay between tiles; exponential backoff on `timeout`/`ui-changed` retries.
- ProviderError handling: `challenge`/`logged-out` pause + show window; `quota` pause with a "resume after" time;
  `refusal` retries once with a softened prompt, then `needs-review`; `ui-changed` fails the job with the missing selector.
- Resume: on startup, jobs in `running`/`paused` are restorable; accepted tiles are never re-run.
- Per-tile actions: re-run a single tile, accept as-is, or swap its source/prompt override, then restitch.

## Testing Strategy
- Unit: state machine transitions; pacing bounds; quality gate thresholds with fixture images.
- Integration with fake provider: random failures, quota mid-job, kill process mid-run, then resume.
- Property: accepted tile count never decreases; no tile runs twice unless retried or manually re-run.

## Boundaries
- Always: persist state first; respect pacing; pause (never loop) on challenge or quota.
- Ask first: raising concurrency above 2; changing quality thresholds.
- Never: auto-accept a tile that failed the gate; solve captchas; run without a successful preflight.

## Success Criteria
- 8-tile simulated job with 20% random failures completes with all tiles accepted or explicitly `needs-review`.
- Kill and restart mid-job: finished tiles are not re-run; job continues from the first unfinished tile.
- Quota pause surfaces a reason and resumes on user command without losing state.
- Preflight blocks a run when the session is not `ready`.

## Open Questions
None.
