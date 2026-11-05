# Spec: presets

## Objective
Own the catalog of enhancement categories. A category turns a user's short prompt into a reliable
per-tile instruction set and supplies sane defaults (fidelity, grid, overlap). Success: choosing a
category measurably changes the prompt sent to the provider and the default job settings, with no
other module needing category-specific logic.

### Category catalog (v1)
Original four are kept as families; others added because they behave differently when tiled.

| id | Name | Family | Default fidelity | Notes |
|----|------|--------|------------------|-------|
| auto | Auto-detect | smart | (detected) | analyzes the source image + prompt and suggests the best category; user can override |
| env-realistic | Realistic environment | environment | preserve | photoreal materials, lighting, atmosphere |
| env-stylized | Stylized environment | environment | balanced | painterly / toon / low-poly look, clean shapes |
| props-realistic | Realistic props | props | preserve | PBR-like surface detail, wear, scale cues |
| props-stylized | Stylized props | props | balanced | readable silhouettes, hand-painted textures |
| char-realistic | Realistic character | character | strict | identity + proportion lock; see character rules |
| char-stylized | Stylized character | character | strict | keep design/palette; clean line + shading |
| creature-realistic | Realistic creature | character | preserve | skin/fur/scale detail |
| creature-stylized | Stylized creature | character | balanced | |
| vehicle-hardsurface | Vehicle / hard-surface / mech | props | preserve | panel lines, metals, decals, symmetry |
| architecture-interior | Architecture & interiors | environment | preserve | straight lines, perspective integrity |
| landscape-matte | Landscape / matte painting | environment | balanced | cinematic depth, atmospheric perspective |
| texture-material | Texture / seamless material | texture | strict | edges must remain tileable; overlap wraps |
| photo-restore | Photo restoration / upscale | restore | strict | denoise, deblur, no new content |
| lineart-to-render | Sketch / lineart to render | stylize | balanced | keeps linework, adds color and shading |
| pixel-art | Pixel art cleanup / upscale | stylize | strict | preserve grid, palette, no anti-aliasing |
| product-still | Product / still life | props | preserve | clean highlights, accurate logos untouched |
| isometric-asset | Isometric game asset | props | preserve | fixed camera angle, clean edges, consistent light direction |
| icon-ui | Icon / UI element | stylize | strict | crisp edges, flat or glossy style, transparent-friendly |
| custom | Custom | custom | balanced | user-authored template |

Fidelity levels: strict (change almost nothing but quality), preserve (same content, richer detail),
balanced (allowed to restyle surfaces), reimagine (free reinterpretation, off by default).

### Character rules (apply to char-* and creature-*)
- Faces and hands are split across tiles poorly. Preset recommends a grid that avoids cutting through
  faces (warns in UI) and adds an identity-lock clause to the prompt.
- Orchestrator passes a downscaled full image as context where the provider allows it.

### Auto-detect (`auto`)
- `auto` is a meta-category (`kind: "auto"`, family `smart`). It has no prompt template of its own;
  selecting it resolves to one of the 19 prompt categories before the job is created.
- Detection is local, offline, and deterministic: `intake` extracts `ImageFeatures` from a 256 px
  EXIF-corrected downscale (saturation, colorfulness, edge density, high-frequency energy, palette size,
  blockiness, blur/noise, transparency, luminance bimodality) and `presets.suggestCategory(features,
  prompt)` returns `{ categoryId, confidence, alternatives, signals }`.
- It never returns `auto` or `custom`, never calls a provider, and never starts a job.
- Confidence below 0.55 is shown as low confidence with the top 3 alternatives. The UI always displays
  the detected category and allows a one-click override; the resolved category's defaults and
  `defaultPrompt` apply.
- If the user keeps the suggestion, the Job records `categorySource: "auto"` and the confidence.
- v1 uses explainable heuristics, not a learned model. A model-based classifier is post-v1.

### Default prompts
- Every prompt-kind category carries a `defaultPrompt` (1–2000 chars). Setup prefills the prompt box
  with it; the user may edit the text. An empty prompt resolves to the category default at job creation.
- Switching categories replaces the prompt only when it is empty or still equals the previous default;
  otherwise the edit is preserved and a "Reset to category default" action is offered.

## Tech Stack
TypeScript strict, Zod for schema validation, JSON preset files, Vitest.

## Commands
Build: pnpm --filter presets build
Test: pnpm --filter presets test -- --coverage
Lint: pnpm lint --fix
Validate catalog: pnpm --filter presets run validate-catalog

## Project Structure
packages/presets/
  src/schema.ts          -> Zod schema for Category
  src/catalog/*.json     -> one file per category
  src/buildPrompt.ts     -> (category, userPrompt, tileInfo) => TilePrompt
  src/index.ts           -> public API: listCategories, getCategory, buildPrompt
  test/                  -> unit + golden prompt snapshots

## Code Style
```ts
export const CategorySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  kind: z.enum(["prompt", "auto"]).default("prompt"),
  family: z.enum(["environment", "props", "character", "texture", "restore", "stylize", "custom", "smart"]),
  fidelity: z.enum(["strict", "preserve", "balanced", "reimagine"]),
  template: z.string().optional(),            // required when kind = "prompt"; supports {{userPrompt}} {{tileRole}} {{fidelityClause}}
  defaultPrompt: z.string().min(1).max(2000).optional(), // required when kind = "prompt"; prefills Setup, editable
  negative: z.array(z.string()),
  defaults: z.object({ grid: z.tuple([z.number(), z.number()]), overlapPct: z.number().min(0).max(40) }),
  warnings: z.array(z.string()).default([]),
});
```
Conventions: kebab-case ids, ids never renamed once shipped, no provider-specific wording in templates.

## Testing Strategy
- Unit: every catalog file passes the schema; ids unique; `auto` is the only `kind: "auto"` entry.
- Golden snapshots: buildPrompt output for each category x tileRole (corner, edge, center).
- Property: output always contains the user prompt verbatim and the fidelity clause.
- Auto-detect: labeled fixture set (>=20 images); top-1 family >=70%; synthetic pixel-art, line-art,
  texture, and low-contrast/restore cases pass; no fixture returns an invalid category.
- Coverage >= 90% for src/.

## Boundaries
- Always: validate catalog against schema in CI; keep templates provider-neutral; show the detected
  category and confidence when `auto` is used.
- Ask first: adding/removing a category id; changing a default grid/overlap.
- Never: embed account, key, or provider selector data; rename a shipped id; auto-start a job from a
  detection; call a provider to classify an image.

## Success Criteria
- 20 categories load and validate (19 prompt categories + `auto`); `custom` accepts a user template and rejects ones missing {{userPrompt}}.
- buildPrompt is deterministic (same input, same output).
- Tile role changes the prompt (corner vs center) and character presets include the identity-lock clause.
- Texture preset sets wrap-around overlap flag consumed by slicer/stitcher.
- `auto` returns a valid prompt-kind category with confidence, top-3 alternatives, and signals; it is
  deterministic, makes no network call, and never auto-starts a job.
- Every prompt category has a non-empty `defaultPrompt`; Setup prefills from it and the user can edit it.

## Decisions (resolved)
- Every category template is user-editable. Edits are stored as overrides in the user data folder; shipped files are never modified, and "Reset to default" removes the override.
- Added `isometric-asset` and `icon-ui`. Comic panels deferred.
- Added `auto` (20th entry) as a local heuristic meta-category; no learned model in v1.
- Added `defaultPrompt` to every prompt category; Setup prefills it and the user may edit it.

## Open Questions
None.
