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

/** Shared frame, first half. `tile` says where this tile sits in the full picture. */
const frameStart = (tile: string): string => `Restore and upscale the attached image. This is an edit of the same picture, not a new one: return one image with identical composition, at higher resolution and with real fine detail.

The attached image is one tile of a larger picture (${tile}). Neighbouring tiles are enhanced separately and stitched back, so the result must register with the attached image pixel for pixel:
- Every edge, contour, object and feature stays at the same position, size and proportion. Nothing is moved, scaled, rotated, bent or reshaped; straight lines stay straight.
- Same framing and aspect ratio: no zoom, no crop, no extra border, no outpainting. Anything cut by the tile edge stays cut at the same place.
- Do not add, remove or replace any object, person, mark, logo or text.
- Keep the original colours, white balance, contrast, light direction and shadows. Do not brighten, warm, saturate or dramatise.

Make it look like a genuinely high-resolution capture of the same scene, not a processed one:
- Recover the detail that is implied by the pixels (fibres, grain, pores, bricks, hair, bark, scratches) at its true physical scale, the same scale in every tile.
- Keep natural imperfections: fine grain, slight irregularity, wear, uneven surfaces. Surfaces must not turn smooth, waxy or plastic.
- Where the original is ambiguous, stay close to it rather than inventing detail.
- Render it in the original's own medium, with no illustrated, painterly, HDR or "AI art" finish.`;

/** Shared frame, second half. */
const FRAME_END = `Technical: clean edges with no halos or ringing, no over-sharpening, no banding, no repeating or tiled texture patterns, no compression artifacts. Output a single high-resolution image of the same aspect ratio (2048 px or more on the long side), with no text, border, collage, watermark or before/after.

If rules conflict, priority is: 1) exact geometry, 2) fidelity to the attached image and the guide above, 3) natural, believable detail.`;
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
