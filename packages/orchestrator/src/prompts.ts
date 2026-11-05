import type { Category, EnhanceAttachment, TilePlan } from '@ie/contracts';
import { buildPrompt } from '@ie/presets';

/** Said when the whole-picture reference is attached: context for layout and tone, never a source of detail. */
export const REFERENCE_NOTE =
  'The second attached image shows the WHOLE picture at low resolution. It is only there so you know where this tile sits and what the picture looks like overall. Use it for context only: never copy its blur, and never add content from it that is not in the tile.';

export const NEIGHBOR_NOTE =
  'The third attached image is the already-enhanced strip of the neighbouring tile that overlaps this one. Match its style, rendering, texture scale and colour exactly along the shared edge. Do not copy it into the output.';

/** Added from the second try on. */
export const PRESERVE_COMPOSITION_CLAUSE =
  'RETRY: the previous attempt drifted from the original. Preserve the composition strictly: every edge, object, line and proportion must stay exactly where it is in the attached tile, and no new element may appear.';

/** Replaces the user's text after a refusal, in case its wording was what the provider objected to. */
export const SOFTENED_USER_PROMPT = 'Restore and upscale this image: improve its sharpness and detail without changing what it shows.';

export interface TilePromptOptions {
  category: Category;
  /** The user's prompt, or a per-tile override. */
  userPrompt: string;
  plan: TilePlan;
  tileIndex: number;
  attachments: readonly EnhanceAttachment[];
  /** 1 for the first try. From 2 the preserve-composition clause is added. */
  tryNumber: number;
  /** A refusal came earlier: use the softened wording. */
  softened: boolean;
}

/** The text for one tile call: the category's prompt for this tile, then a note for each extra attachment, then any retry clause. */
export function buildTilePrompt({ category, userPrompt, plan, tileIndex, attachments, tryNumber, softened }: TilePromptOptions): string {
  const tile = plan.tiles[tileIndex]!;
  const base = buildPrompt(category, softened ? SOFTENED_USER_PROMPT : userPrompt, { role: tile.role, row: tile.row, col: tile.col, grid: plan.grid }).text;
  const notes: string[] = [];
  if (attachments.some((a) => a.role === 'global-reference')) notes.push(REFERENCE_NOTE);
  if (attachments.some((a) => a.role === 'neighbor')) notes.push(NEIGHBOR_NOTE);
  if (tryNumber > 1) notes.push(PRESERVE_COMPOSITION_CLAUSE);
  return [base, ...notes].join('\n\n');
}
