import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { EnhanceAttachment, Rect, Tile, TilePlan } from '@ie/contracts';
import { extractRegion, extractTiles, loadRgba, tileFileName } from '@ie/slicer';
import { normalizeTile } from '@ie/stitcher';
import sharp from 'sharp';

import type { JobRecord } from './store.ts';

/** The whole-picture reference is shrunk to this on its longer side: enough to show layout, too small to copy detail from. */
export const REFERENCE_MAX_PX = 768;
/** A strip thinner than this carries no useful context. */
const MIN_STRIP_PX = 8;

export interface JobFiles {
  dir: string;
  tilesDir: string;
  outputsDir: string;
  stripsDir: string;
  referencePath: string;
  tilePath(index: number): string;
}

/**
 * Everything a job needs on disk, made once and reused after a restart: each tile cut from the source at its `send`
 * size, and the downscaled whole-picture reference. The source file is only read.
 */
export async function prepareJobFiles(record: JobRecord, workDir: string): Promise<JobFiles> {
  const files: JobFiles = {
    dir: workDir,
    tilesDir: path.join(workDir, 'tiles'),
    outputsDir: path.join(workDir, 'outputs'),
    stripsDir: path.join(workDir, 'strips'),
    referencePath: path.join(workDir, 'reference.png'),
    tilePath: (index) => path.join(workDir, 'tiles', tileFileName(index)),
  };
  for (const dir of [files.outputsDir, files.stripsDir]) mkdirSync(dir, { recursive: true });

  if (!record.plan.tiles.every((t) => existsSync(files.tilePath(t.index)))) {
    await extractTiles(record.job.source.path, record.plan, files.tilesDir);
  }
  if (!existsSync(files.referencePath)) {
    await sharp(record.job.source.path)
      .resize({ width: REFERENCE_MAX_PX, height: REFERENCE_MAX_PX, fit: 'inside', withoutEnlargement: true })
      .png()
      .toFile(files.referencePath);
  }
  return files;
}

const intersect = (a: Rect, b: Rect): Rect | null => {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
};

/** Neighbours to take context from, nearest first: the ones already passed in raster order (left, above), then the rest. */
function neighbourOrder(plan: TilePlan, tile: Tile): Tile[] {
  const at = (row: number, col: number): Tile | undefined => plan.tiles.find((t) => t.row === row && t.col === col);
  return [at(tile.row, tile.col - 1), at(tile.row - 1, tile.col), at(tile.row, tile.col + 1), at(tile.row + 1, tile.col)].filter((t): t is Tile => t !== undefined);
}

/**
 * In chained mode: the already-enhanced strip of the nearest finished neighbour that overlaps this tile, cut out of
 * its accepted output. Gives the provider the style and texture scale it must continue across the shared edge.
 * Returns null when no neighbour is finished yet, or none overlaps.
 */
export async function neighbourStrip(plan: TilePlan, files: JobFiles, tileIndex: number, acceptedOutputs: ReadonlyMap<number, string>): Promise<string | null> {
  const tile = plan.tiles[tileIndex]!;
  for (const neighbour of neighbourOrder(plan, tile)) {
    const output = acceptedOutputs.get(neighbour.index);
    if (!output) continue;
    const shared = intersect(neighbour.crop, tile.crop);
    if (!shared || Math.min(shared.width, shared.height) < MIN_STRIP_PX) continue;

    // The accepted output, brought to its tile's `send` size, then the shared region cut out of it.
    const { image } = await normalizeTile(await loadRgba(output), neighbour.send);
    const region: Rect = { x: shared.x - neighbour.send.x, y: shared.y - neighbour.send.y, width: shared.width, height: shared.height };
    const data = extractRegion(image, region, false);
    const file = path.join(files.stripsDir, `strip-${String(tileIndex).padStart(3, '0')}-from-${String(neighbour.index).padStart(3, '0')}.png`);
    writeFileSync(file, await sharp(data, { raw: { width: region.width, height: region.height, channels: 4 } }).png().toBuffer());
    return file;
  }
  return null;
}

/**
 * The attachments for one call, in the spec's order: the tile, the whole-picture reference, then the neighbour strip.
 * When the provider takes fewer, the strip goes first, then the reference; the tile always stays.
 */
export function buildAttachments(parts: { tilePath: string; referencePath: string; stripPath: string | null }, maxAttachments: number): EnhanceAttachment[] {
  const all: EnhanceAttachment[] = [{ role: 'tile', path: parts.tilePath }, { role: 'global-reference', path: parts.referencePath }];
  if (parts.stripPath) all.push({ role: 'neighbor', path: parts.stripPath });
  return all.slice(0, Math.max(1, maxAttachments));
}
