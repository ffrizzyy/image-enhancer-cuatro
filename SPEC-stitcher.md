# Spec: stitcher

## Objective
Merge accepted tiles into one image that looks like a single coherent enhancement, not a collage.
Success: no visible seams or per-tile color shifts at normal viewing, and the output matches the source geometry.

## Pipeline
1. Normalize: resize each provider output back to its `send` rect size; crop to `crop` rect (drop context padding).
2. Align: estimate small translation (phase correlation) between a tile's overlap and its neighbor's/source
   overlap; shift within +/- 8 px; reject larger shifts as `needs-review`.
3. Color match: per tile, match mean/variance (Lab) in the overlap to the reference, solved globally across
   tiles so corrections do not drift.
4. Blend: multi-band (Laplacian pyramid) blending across overlaps, feathered along seams, seam path chosen
   by minimum-error cut rather than a straight line.
5. Harmonize: build a low-frequency (heavily blurred) version of the source, compare with the stitched
   result, and correct large-scale brightness/color drift. Optional `global-pass`: a single provider call
   on a downscaled whole image used ONLY as a low-frequency reference, never as detail.
6. Export at source resolution (or an integer upscale factor when tiles came back larger than their cores).

## Tech Stack
TypeScript strict, sharp, a small native/WASM compute layer for pyramid blending and phase correlation
(OpenCV via opencv4nodejs-compatible binding or opencv.js; decision recorded in the plan phase), Vitest.

## Commands
Build: pnpm --filter stitcher build
Test: pnpm --filter stitcher test -- --coverage
Seam metrics report: pnpm --filter stitcher metrics -- --job <jobId>

## Project Structure
packages/stitcher/
  src/normalize.ts | align.ts | colorMatch.ts | blend.ts | harmonize.ts
  src/metrics.ts      -> seam and color metrics used by tests and UI "quality" badge
  src/stitch.ts       -> orchestrates the pipeline
  test/fixtures/      -> synthetic tiles with known offsets and color casts

## Code Style
```ts
export interface StitchInput { plan: TilePlan; tiles: { index: number; path: string }[]; options: StitchOptions }
export interface StitchOptions { blend: "multiband" | "feather"; maxShiftPx: number; harmonize: boolean }
export interface StitchResult { imagePath: string; metrics: { seamScore: number; maxDeltaE: number }; flagged: number[] }
export function stitch(input: StitchInput): Promise<StitchResult>;
```
Conventions: pure image-in/image-out steps, each independently testable; work in linear or Lab space, never gamma-mixed.

## Testing Strategy
- Round trip: unchanged tiles -> pixel-identical to source (shared with slicer).
- Synthetic: tiles with injected +/- 6 px shifts and Lab color casts are corrected below thresholds.
- Metrics: seamScore (gradient energy across seam / interior baseline) and maxDeltaE in overlaps.
- Golden images for 3 real fixtures (reviewed once by a human, then locked).
- Failure: shift beyond maxShiftPx flags the tile instead of forcing a bad blend.

## Boundaries
- Always: report metrics and flagged tiles to the UI; keep intermediate files for debugging in a job temp dir.
- Ask first: adding generative inpainting at seams (extra provider calls); changing default blend method.
- Never: overwrite accepted tile files; stretch tiles non-uniformly; silently drop a flagged tile.

## Success Criteria
- Unchanged-tile round trip is pixel-identical.
- On synthetic tests: seamScore <= 1.2 and maxDeltaE <= 3 after correction.
- Stitching 8 tiles at 8192x4096 completes in under 20 s on a typical laptop.
- Texture jobs with `wrap` produce an image whose left/right and top/bottom edges tile with seamScore <= 1.2.

## Open Questions
None.
