# Spec: intake

## Objective
Accept one image, validate it into an immutable `ImageAsset`, then accept prompt/category/grid/provider
and produce an immutable Job record that downstream modules consume. Success: any valid import yields an
`ImageAsset`; any complete configuration yields a Job; any invalid one yields a clear error.

## Tech Stack
Electron main + renderer IPC, TypeScript strict, sharp for decode/metadata, Zod, Vitest.

## Commands
Build: pnpm --filter intake build
Test: pnpm --filter intake test -- --coverage
Lint: pnpm lint --fix

## Project Structure
packages/intake/
  src/importImage.ts     -> file picker / drag-drop / path -> ImageAsset
  src/validate.ts        -> type, size, dimension, orientation (EXIF) checks
  src/createJob.ts       -> Job
  src/types.ts
  test/fixtures/         -> valid and invalid sample images

## Code Style
```ts
export interface ImageAsset {
  id: string;                 // ulid
  path: string;               // original file, never modified
  width: number;
  height: number;
  sha256: string;
  featuresPath?: string;      // cached ImageFeatures for auto-detect
}

export interface Job {
  id: string;                 // ulid
  createdAt: string;          // ISO-8601
  source: { path: string; width: number; height: number; sha256: string };
  prompt: string;             // effective prompt, 1..2000 chars
  promptSource: "user" | "category-default";
  categoryId: string;         // resolved id; must exist in presets
  categorySource: "user" | "auto";
  categoryConfidence?: number;
  grid: { rows: number; cols: number; overlapPct: number };
  providerId: "gpt" | "gemini" | "grok";
}
```
Conventions: `ImageAsset` is created at import; `Job` is created only at Start after the user chooses
prompt, category, grid, and provider. Both are frozen after creation; changes create a new version.
An empty prompt resolves to the category's `defaultPrompt` and sets `promptSource: "category-default"`.

## Testing Strategy
- Unit: validation matrix (png/jpg/webp ok; gif/svg/corrupt rejected; size and dimension limits; EXIF rotation applied).
- Integration: import -> ImageAsset against real fixture files; ImageAsset + configuration -> Job.
- Prompt: empty resolves to the category default; edited text is preserved with `promptSource: "user"`.
- Auto: `categorySource: "auto"` and confidence are recorded when the user keeps a suggestion.
- Coverage >= 90%.

## Boundaries
- Always: normalize EXIF orientation; hash the source; keep the original file untouched; separate
  `ImageAsset` (import) from `Job` (Start).
- Ask first: raising size limits; supporting new formats.
- Never: upload or transmit the image anywhere; overwrite the user's original; create a Job before the
  user explicitly starts.

## Success Criteria
- Accepts PNG/JPEG/WebP up to 50 MB and 8192 px per side; rejects others with specific messages.
- Import returns an `ImageAsset`; no Job exists until Start.
- Grid presets 6 (3x2) and 8 (4x2) plus custom rows x cols (max 6x6) validate; overlapPct 0 to 40.
- Job references a real categoryId from presets and a provider with status "ready" (checked at run time, not import).
- An empty prompt resolves to the category `defaultPrompt`; an edited prompt is stored with `promptSource: "user"`.
- An auto-detected category is stored with `categorySource: "auto"` and its confidence.

## Decisions (resolved)
- Limits confirmed: 50 MB, 8192 px per side.
- Batch import is out of scope for v1. `Job` is single-image by design; a future `batch` module would wrap many Jobs.
- Import and Job creation are separate: `ImageAsset` at import, `Job` at Start after the user chooses prompt/category/grid/provider.
- Prompt defaults come from the category; the user may edit them. Auto-detected categories are recorded with their confidence.

## Open Questions
None.
