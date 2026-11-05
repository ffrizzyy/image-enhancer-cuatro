import type { ProviderId, Rect, Tile, TilePlan } from '@ie/contracts';

/** A tile core shorter than this on either side is too small to carry enough context for a good enhancement. */
export const MIN_CORE_PX = 384;

/**
 * Longest side of an image each provider returns, in pixels. Mirrors `capabilities.approxOutputPx` in
 * `packages/providers/config/*.json`; a test keeps the two in step.
 */
export const PROVIDER_OUTPUT_PX: Record<ProviderId, number> = { gpt: 1536, gemini: 1024, grok: 1024 };

const area = (r: Rect): number => Math.max(0, r.width) * Math.max(0, r.height);

const intersect = (a: Rect, b: Rect): Rect | null => {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
};

export interface OverlapRegion {
  /** The two tiles whose crops share this region. */
  a: number;
  b: number;
  /** In source pixels, inside the image. */
  rect: Rect;
  /** True when the overlap reaches across the image border (wrap mode), drawn at the border it continues from. */
  wrapped: boolean;
}

/** Splits a rect that may hang over the image border into the pieces that lie inside it, wrapping around (wrap mode). */
function foldIntoImage(rect: Rect, width: number, height: number): Rect[] {
  const xs = splitAxis(rect.x, rect.width, width);
  const ys = splitAxis(rect.y, rect.height, height);
  return ys.flatMap((y) => xs.map((x): Rect => ({ x: x.start, y: y.start, width: x.len, height: y.len })));
}

function splitAxis(start: number, length: number, size: number): Array<{ start: number; len: number }> {
  const from = ((start % size) + size) % size;
  const first = Math.min(length, size - from);
  const parts = [{ start: from, len: first }];
  if (length > first) parts.push({ start: 0, len: length - first });
  return parts;
}

/**
 * Every region where two tiles' crops overlap. These are the bands the stitcher blends. With `wrap`, crops that run
 * past the border also meet the tiles on the opposite side, and those overlaps are folded back into the image.
 */
export function overlapRegions(plan: TilePlan): OverlapRegion[] {
  const { width, height } = plan.source;
  const shifts: Array<[number, number]> = [[0, 0]];
  if (plan.wrap) {
    for (const oy of [-height, 0, height]) for (const ox of [-width, 0, width]) if (ox !== 0 || oy !== 0) shifts.push([ox, oy]);
  }

  const regions: OverlapRegion[] = [];
  for (let i = 0; i < plan.tiles.length; i++) {
    for (let j = i + 1; j < plan.tiles.length; j++) {
      const A = plan.tiles[i]!.crop;
      const B = plan.tiles[j]!.crop;
      for (const [ox, oy] of shifts) {
        const hit = intersect(A, { x: B.x + ox, y: B.y + oy, width: B.width, height: B.height });
        if (!hit) continue;
        const inside = hit.x >= 0 && hit.y >= 0 && hit.x + hit.width <= width && hit.y + hit.height <= height;
        const pieces = inside ? [hit] : plan.wrap ? foldIntoImage(hit, width, height) : [intersect(hit, { x: 0, y: 0, width, height })].filter((r): r is Rect => r !== null);
        for (const rect of pieces) regions.push({ a: plan.tiles[i]!.index, b: plan.tiles[j]!.index, rect, wrapped: !inside });
      }
    }
  }
  return regions;
}

export type PlanWarningKind = 'core-small' | 'send-exceeds-output';

export interface PlanWarning {
  kind: PlanWarningKind;
  /** Tile indexes, 0-based as in the plan. */
  tiles: number[];
  message: string;
}

/** Human numbering: tiles are shown from 1. */
export const tileNumber = (index: number): number => index + 1;

const listTiles = (indexes: readonly number[]): string => {
  const numbers = indexes.map(tileNumber);
  return numbers.length === 1 ? `Tile ${numbers[0]}` : `Tiles ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;
};

const shortSide = (r: Rect): number => Math.min(r.width, r.height);
const longSide = (r: Rect): number => Math.max(r.width, r.height);

/**
 * Problems worth knowing before starting:
 * - a core under `MIN_CORE_PX` on a side, which gives the provider too little to work with;
 * - a tile whose padded image is larger than the provider returns, so the result comes back at a lower resolution
 *   than what was sent and cannot add real detail.
 * `outputPx` is the selected provider's output size, or null when none is chosen yet.
 */
export function planWarnings(plan: TilePlan, outputPx: number | null): PlanWarning[] {
  const warnings: PlanWarning[] = [];

  const small = plan.tiles.filter((t) => shortSide(t.core) < MIN_CORE_PX).map((t) => t.index);
  if (small.length > 0) {
    warnings.push({
      kind: 'core-small',
      tiles: small,
      message: `${listTiles(small)} ${small.length === 1 ? 'is' : 'are'} under ${MIN_CORE_PX} px on a side. Use fewer rows or columns, or a larger image, for better results.`,
    });
  }

  if (outputPx !== null) {
    const large = plan.tiles.filter((t) => longSide(t.send) > outputPx).map((t) => t.index);
    if (large.length > 0) {
      warnings.push({
        kind: 'send-exceeds-output',
        tiles: large,
        message: `${listTiles(large)} ${large.length === 1 ? 'is' : 'are'} larger than the ${outputPx} px the provider returns, so ${large.length === 1 ? 'it' : 'they'} will come back at a lower resolution than sent. Use more rows or columns.`,
      });
    }
  }
  return warnings;
}

/** One line per tile for people who cannot see the picture: where it is and how big. */
export function describeTile(tile: Tile): string {
  const { core, send } = tile;
  return `Tile ${tileNumber(tile.index)} (row ${tile.row + 1}, column ${tile.col + 1}): core ${core.width}×${core.height} px at ${core.x}, ${core.y}; sent as ${send.width}×${send.height} px.`;
}

/** Total area of the cores: equals the image area for any valid plan, which the tests rely on. */
export const coreArea = (plan: TilePlan): number => plan.tiles.reduce((sum, t) => sum + area(t.core), 0);
