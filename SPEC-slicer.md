# Spec: slicer

## Objective
Split the source image into a grid of overlapping tiles shaped for provider limits, and record the
geometry needed to put the result back together exactly. Success: slicing then stitching the UNCHANGED
tiles reproduces the source image with no visible or measurable difference.

## Design notes
- Providers return fixed aspect ratios (roughly 1:1, 2:3, 3:2). A tile is therefore prepared as:
  core region (what will be kept) + overlap margin + optional context padding to reach the nearest
  supported aspect ratio. Padding is real neighboring pixels where available, and edge-reflected pixels at image borders.
- Presets of 6 (3x2) and 8 (4x2) are oriented by image aspect (landscape = cols >= rows, portrait = transposed).
- Custom grids up to 6x6. UI warns when a tile core is under 384 px or over provider output size.
- `wrap` flag (from texture-material preset) makes overlap wrap around image edges so the result tiles seamlessly.

## Tech Stack
TypeScript strict, sharp, Vitest, fast-check (property tests).

## Commands
Build: pnpm --filter slicer build
Test: pnpm --filter slicer test -- --coverage
Property tests: pnpm --filter slicer test:prop

## Project Structure
packages/slicer/
  src/plan.ts       -> (width, height, grid, overlapPct, aspects, wrap) => TilePlan
  src/extract.ts    -> TilePlan + image => tile files (PNG)
  src/types.ts
  test/

## Code Style
```ts
export interface Tile {
  index: number; row: number; col: number;
  core:   Rect;   // region this tile owns in the source
  crop:   Rect;   // core + overlap actually cut from source
  send:   Rect;   // crop + context padding sent to provider (matches a supported aspect)
  edges:  { top: boolean; right: boolean; bottom: boolean; left: boolean }; // true = image border
  role: "corner" | "edge" | "center";
}
export interface TilePlan { source: Size; grid: Grid; overlapPx: number; wrap: boolean; tiles: Tile[] }
```
Conventions: pure functions for planning (no I/O); integer pixel rects only; rounding remainders go to the last row/col.

## Testing Strategy
- Property: cores are disjoint and cover the source exactly; each crop stays within bounds (or wraps if `wrap`).
- Property: every `send` rect has aspect within 2% of a supported ratio.
- Round trip: extract tiles, stitch unchanged (via stitcher test helper), result is pixel-identical to source.
- Fixtures: odd sizes (1001x777), extreme aspect (4000x500), tiny (512x512).

## Boundaries
- Always: keep plan generation pure and deterministic; store the plan in the job.
- Ask first: changing supported aspect list; adding non-grid slicing (e.g. content-aware).
- Never: resample the source when extracting (crop only); modify the original file.

## Success Criteria
- 6 and 8 presets plus any rows x cols up to 6x6 produce valid plans for sizes 512 to 8192 px.
- Slice + unchanged stitch round trip is pixel-identical.
- Planning 6x6 on 8192x8192 completes in under 100 ms (plan only).
- Wrap mode produces tiles whose outer overlap comes from the opposite image edge.

## Open Questions
None.
