import type { Category, Fidelity, Grid, TileRole } from '@ie/contracts';

export const PLACEHOLDERS = ['userPrompt', 'tileRole', 'fidelityClause'] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

/** Raised when a prompt is requested for the auto meta-category, which resolves to a prompt category first. */
export class AutoCategoryError extends Error {
  readonly code = 'auto-category';

  constructor() {
    super('The auto category has no prompt of its own; resolve it to a prompt category first.');
    this.name = 'AutoCategoryError';
  }
}

/** Where a tile sits in the plan; enough to describe its position in words. */
export interface TileInfo {
  role: TileRole;
  row: number;
  col: number;
  grid: Grid;
}

export interface TilePrompt {
  text: string;
  /** Mirrors the category flag so the orchestrator needs no category lookup. */
  wrap: boolean;
}

export const FIDELITY_CLAUSES: Record<Fidelity, string> = {
  strict:
    'FIDELITY: STRICT. Change nothing except image quality: remove noise and blur and recover fine detail while every shape, colour and element stays exactly where it is.',
  preserve:
    'FIDELITY: PRESERVE. Same content and composition; enrich it with finer, more convincing detail without adding or removing anything.',
  balanced:
    'FIDELITY: BALANCED. Keep the subject and composition; surfaces and textures may be redrawn in more detail while staying faithful to the original design.',
  reimagine: 'FIDELITY: REIMAGINE. You may reinterpret the image while keeping its general subject and layout.',
};

/** Shared frame, sections 1-3. `tile` says where this tile sits in the full picture. */
const frameStart = (tile: string): string => `Edit the attached image: image-to-image enhancement. Do NOT create a new picture and do NOT reimagine anything. Return the SAME picture, restored and upscaled into a far more detailed, high-resolution version. Output exactly ONE image.

1. EXACT GEOMETRY AND PROPORTIONS (HIGHEST PRIORITY)
- IMPORTANT: this image is ONE TILE cut from a larger picture. Many neighbouring tiles are enhanced separately and then stitched back together, so ANY shift, stretch, warp or change of proportion creates a visible mismatch. The enhanced image must line up with the attached image pixel for pixel.
- POSITION: this tile is ${tile}.
- Treat the attached image as a locked reference layer: if the result were placed exactly on top of it, every edge, contour, line, object, body part and facial feature must sit in the same position, with the same size and the same proportions.
- Do not move, resize, rotate, bend, stretch, squash, slim, widen, lengthen or reshape anything. Straight lines must stay perfectly straight (window grids, building edges, poles, panel lines, text); curves keep their exact curvature; angles and perspective stay identical.
- Keep the exact field of view and scale: no zoom, no crop, no reframing, no outpainting, no borders, the exact same aspect ratio.
- Anything cut by an edge of the image stays cut at exactly the same place and angle. Do not complete or close objects at the border.
- Do not add, remove, move, duplicate or replace any object, person, mark, sign, logo or text.

2. COLOR AND LIGHT (NON-NEGOTIABLE)
- Keep the original colour palette, hue, saturation, white balance, tonal balance, light direction, shadows, highlights and reflections. Do not make it brighter, darker, warmer, cooler, more saturated or more dramatic. No new light sources.

3. CONSISTENCY ACROSS ALL TILES (VERY IMPORTANT)
- Every tile of this picture must look as if it was enhanced in ONE pass by the same artist: the same style, the same rendering approach, the same density of added detail, the same texture scale and the same texture contrast.
- The size of every texture and detail is set by the real (or painted) scale of the subject in the WHOLE picture, never by the size of this crop. A leaf, brick, pore, hair strand, brush stroke or fabric thread keeps the same size whether the tile shows a lot or only a little of it.
- Add detail only INSIDE what already exists; where a detail is ambiguous, stay faithful to the original.`;

/** Shared frame, sections 4-6 and the final priority. */
const FRAME_END = `4. QUALITY
- Clean edges without halos, ringing or over-sharpening; less compression noise and artifacts; smooth gradients without banding; no artificial detail patterns.

5. OUTPUT RESOLUTION (REQUIRED)
- Generate a HIGH-RESOLUTION image: at least 2K (2048 px on the longest side; higher is better, for example 4096 px if possible), with exactly the same aspect ratio as the attached image so the result can be placed back exactly over it.

6. OUTPUT
- Return the image itself, no text. No collage, no before/after, no borders, no labels, no watermark, no added text.

FINAL PRIORITY: 1) EXACT GEOMETRY AND PROPORTIONS, 2) FIDELITY TO THE ATTACHED IMAGE AND THE MASTER GUIDE, 3) CONSISTENT, CONTENT-TYPE-CORRECT REGENERATED DETAIL.`;
const PLACEHOLDER_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;

/** Placeholder names used in a template that are not supported. */
export function unknownPlaceholders(template: string): string[] {
  const known: readonly string[] = PLACEHOLDERS;
  return [...template.matchAll(PLACEHOLDER_PATTERN)]
    .map((m) => m[1] ?? '')
    .filter((name) => !known.includes(name));
}

/** Returns an error message, or null when the template is usable. */
export function validateTemplate(template: string): string | null {
  const used = new Set([...template.matchAll(PLACEHOLDER_PATTERN)].map((m) => m[1]));
  if (!used.has('userPrompt')) return 'template must contain {{userPrompt}}';
  if (!used.has('fidelityClause')) return 'template must contain {{fidelityClause}}';
  const unknown = unknownPlaceholders(template);
  if (unknown.length > 0) return `template has unknown placeholders: ${unknown.join(', ')}`;
  return null;
}

/** Position in words, e.g. "the top-left corner of the full image". */
export function describeTile({ role, row, col, grid }: TileInfo): string {
  const vertical = row === 0 ? 'top' : row === grid.rows - 1 ? 'bottom' : null;
  const horizontal = col === 0 ? 'left' : col === grid.cols - 1 ? 'right' : null;
  const sides = [vertical, horizontal].filter((s): s is string => s !== null);

  switch (role) {
    case 'corner':
      return `the ${sides.length > 0 ? `${sides.join('-')} ` : ''}corner of the full image`;
    case 'edge':
      return `the ${sides.length > 0 ? `${sides.join('/')} ` : ''}edge of the full image`;
    case 'center':
      return 'a central area of the full image';
  }
}

/**
 * Deterministic per-tile prompt. `userPrompt` is the effective prompt (the user's
 * text or the category default); it is inserted verbatim, exactly once per
 * placeholder, and is never re-scanned for placeholders.
 */
export function buildPrompt(category: Category, userPrompt: string, tile: TileInfo): TilePrompt {
  if (category.kind === 'auto') throw new AutoCategoryError();
  if (category.kind !== 'prompt' || !category.template) {
    throw new Error(`category "${category.id}" has no prompt template`);
  }

  const values: Record<Placeholder, string> = {
    userPrompt,
    tileRole: describeTile(tile),
    fidelityClause: FIDELITY_CLAUSES[category.fidelity],
  };

  const body = category.template.replace(PLACEHOLDER_PATTERN, (match, name: string) =>
    Object.hasOwn(values, name) ? values[name as Placeholder] : match,
  );

  // The category template renders the MASTER GUIDE and CONTENT-TYPE RULES, which sit between
  // the two halves of the shared frame.
  const parts = [frameStart(values.tileRole), body.trim()];
  if (category.negative.length > 0) parts.push(`Avoid: ${category.negative.join(', ')}.`);
  parts.push(FRAME_END);

  return { text: parts.join('\n\n'), wrap: category.wrap ?? false };
}
