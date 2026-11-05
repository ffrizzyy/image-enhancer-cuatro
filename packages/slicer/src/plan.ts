import type { Grid, Rect, Tile, TilePlan, TileRole } from '@ie/contracts';

import { DEFAULT_ASPECTS, PlanError, type AspectPair, type PlanOptions } from './types';

const MAX_GRID_AXIS = 6;
const MAX_OVERLAP_PCT = 40;

/**
 * The 6 (3x2) and 8 (4x2) presets, written columns x rows and oriented by the image:
 * landscape and square images get two rows, portrait images get two columns.
 */
export function presetGrid(count: 6 | 8, width: number, height: number): Grid {
  const long = count / 2;
  return width >= height ? { rows: 2, cols: long } : { rows: long, cols: 2 };
}

interface Span {
  start: number;
  len: number;
}

/** Splits `length` into `parts` runs of equal size; the remainder goes to the last run. */
function splitAxis(length: number, parts: number): Span[] {
  const base = Math.floor(length / parts);
  return Array.from({ length: parts }, (_, i) => ({
    start: i * base,
    len: i === parts - 1 ? length - base * (parts - 1) : base,
  }));
}

/**
 * Core plus overlap on both sides. Without `wrap` the crop stops at the image border; with `wrap`
 * it continues past the border (reading from the opposite edge), limited so the crop never
 * exceeds the image size.
 */
function cropAxis(core: Span, sourceLen: number, overlap: number, wrap: boolean): Span {
  if (wrap) {
    const margin = Math.min(overlap, Math.floor((sourceLen - core.len) / 2));
    return { start: core.start - margin, len: core.len + 2 * margin };
  }
  const start = Math.max(0, core.start - overlap);
  const end = Math.min(sourceLen, core.start + core.len + overlap);
  return { start, len: end - start };
}

/** Smallest send size, a whole multiple of `aspect`, that contains a crop of `cropW` x `cropH`. */
function sendSize(cropW: number, cropH: number, [a, b]: AspectPair): { width: number; height: number } {
  const k = Math.max(Math.ceil(cropW / a), Math.ceil(cropH / b));
  return { width: a * k, height: b * k };
}

/** The supported aspect nearest the crop's (by log ratio); ties prefer the smaller padded area. */
function nearestAspect(cropW: number, cropH: number, aspects: readonly AspectPair[]): AspectPair {
  const target = Math.log(cropW / cropH);
  let best = aspects[0]!;
  let bestDiff = Infinity;
  let bestArea = Infinity;
  for (const pair of aspects) {
    const diff = Math.abs(target - Math.log(pair[0] / pair[1]));
    const size = sendSize(cropW, cropH, pair);
    const area = size.width * size.height;
    if (diff < bestDiff - 1e-12 || (Math.abs(diff - bestDiff) <= 1e-12 && area < bestArea)) {
      best = pair;
      bestDiff = diff;
      bestArea = area;
    }
  }
  return best;
}

/**
 * Centres the padded `send` span on the crop. When it fits inside the image (and we are not
 * wrapping) it is shifted to stay inside, so padding uses real neighbouring pixels rather than
 * reflected ones. When it cannot fit, it extends past the border and the extra is reflected
 * (or, with `wrap`, read from the opposite edge).
 */
function placeSend(crop: Span, sendLen: number, sourceLen: number, wrap: boolean): number {
  const start = crop.start - Math.floor((sendLen - crop.len) / 2);
  if (wrap || sendLen > sourceLen) return start;
  return Math.min(Math.max(start, 0), sourceLen - sendLen);
}

function roleOf(row: number, col: number, rows: number, cols: number): TileRole {
  const rowEdge = rows > 1 && (row === 0 || row === rows - 1);
  const colEdge = cols > 1 && (col === 0 || col === cols - 1);
  if (rowEdge && colEdge) return 'corner';
  return rowEdge || colEdge ? 'edge' : 'center';
}

function validate(o: PlanOptions, aspects: readonly AspectPair[]): void {
  if (!Number.isInteger(o.width) || !Number.isInteger(o.height) || o.width < 1 || o.height < 1) {
    throw new PlanError('invalid-size', 'Width and height must be whole numbers of at least 1.');
  }
  for (const [name, value] of [['rows', o.rows], ['cols', o.cols]] as const) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_GRID_AXIS) {
      throw new PlanError('invalid-grid', `Grid ${name} must be a whole number from 1 to ${MAX_GRID_AXIS}.`);
    }
  }
  if (!Number.isFinite(o.overlapPct) || o.overlapPct < 0 || o.overlapPct > MAX_OVERLAP_PCT) {
    throw new PlanError('invalid-overlap', `Overlap must be from 0 to ${MAX_OVERLAP_PCT} percent.`);
  }
  if (aspects.length === 0 || aspects.some(([a, b]) => !Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1)) {
    throw new PlanError('invalid-aspects', 'Aspects must be a non-empty list of positive whole-number pairs.');
  }
  if (o.rows > o.height || o.cols > o.width) {
    throw new PlanError('grid-too-fine', `A ${o.cols}x${o.rows} grid needs an image at least that many pixels wide and tall.`);
  }
}

/**
 * Pure, deterministic tile plan. Tile cores are disjoint and exactly cover the source (the last
 * row and column take any remainder). Each tile then grows by `overlapPx` into its neighbours
 * (`crop`) and is padded to a supported aspect ratio (`send`). Integer pixel rects only.
 */
export function planTiles(options: PlanOptions): TilePlan {
  const aspects = options.aspects ?? DEFAULT_ASPECTS;
  validate(options, aspects);

  const { width, height, rows, cols, overlapPct } = options;
  const wrap = options.wrap ?? false;
  const columns = splitAxis(width, cols);
  const lines = splitAxis(height, rows);
  const baseCore = Math.min(Math.floor(width / cols), Math.floor(height / rows));
  const overlapPx = Math.round((overlapPct / 100) * baseCore);

  const tiles: Tile[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cx = columns[col]!;
      const cy = lines[row]!;
      const core: Rect = { x: cx.start, y: cy.start, width: cx.len, height: cy.len };

      const cropX = cropAxis(cx, width, overlapPx, wrap);
      const cropY = cropAxis(cy, height, overlapPx, wrap);
      const crop: Rect = { x: cropX.start, y: cropY.start, width: cropX.len, height: cropY.len };

      const size = sendSize(crop.width, crop.height, nearestAspect(crop.width, crop.height, aspects));
      const send: Rect = {
        x: placeSend(cropX, size.width, width, wrap),
        y: placeSend(cropY, size.height, height, wrap),
        width: size.width,
        height: size.height,
      };

      tiles.push({
        index: row * cols + col,
        row,
        col,
        core,
        crop,
        send,
        edges: { top: row === 0, right: col === cols - 1, bottom: row === rows - 1, left: col === 0 },
        role: roleOf(row, col, rows, cols),
      });
    }
  }

  return { source: { width, height }, grid: { rows, cols }, overlapPx, wrap, tiles };
}
