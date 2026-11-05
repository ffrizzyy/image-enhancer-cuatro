import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Rect, TilePlan } from '@ie/contracts';
import sharp from 'sharp';

import { CHANNELS, extractRegion, loadRgba } from './pixels';

export type TilePadding = 'none' | 'reflected' | 'wrapped';

export interface TileFile {
  index: number;
  /** File name inside the output directory, stable for a given index. */
  file: string;
  path: string;
  width: number;
  height: number;
  /** Where the tile's core and crop sit inside this tile image (the stitcher cuts the core out here). */
  coreInTile: Rect;
  cropInTile: Rect;
  /** Whether any part of the tile image is not a real source pixel. */
  padding: TilePadding;
}

export interface TilesMetadata {
  version: 1;
  plan: TilePlan;
  tiles: TileFile[];
}

export interface ExtractedTiles extends TilesMetadata {
  dir: string;
  metadataPath: string;
}

export class ExtractError extends Error {
  readonly code = 'size-mismatch';

  constructor(message: string) {
    super(message);
    this.name = 'ExtractError';
  }
}

export const METADATA_FILE = 'tiles.json';
export const tileFileName = (index: number): string => `tile-${String(index).padStart(3, '0')}.png`;

const PARALLEL_WRITES = 4;

function paddingOf(send: Rect, source: TilePlan['source'], wrap: boolean): TilePadding {
  const outside = send.x < 0 || send.y < 0 || send.x + send.width > source.width || send.y + send.height > source.height;
  if (!outside) return 'none';
  return wrap ? 'wrapped' : 'reflected';
}

/**
 * Writes one lossless PNG per tile into `outDir`: exactly the pixels of the tile's `send` rect, with
 * no resampling. Padding outside the image is mirrored at the border, or wrapped from the opposite
 * edge when the plan says so. Also writes `tiles.json` describing where each core sits. The source
 * file is only read.
 */
export async function extractTiles(sourcePath: string, plan: TilePlan, outDir: string): Promise<ExtractedTiles> {
  const source = await loadRgba(sourcePath);
  if (source.width !== plan.source.width || source.height !== plan.source.height) {
    throw new ExtractError(
      `The image is ${source.width}x${source.height} but the plan is for ${plan.source.width}x${plan.source.height}.`,
    );
  }

  mkdirSync(outDir, { recursive: true });
  const tiles: TileFile[] = plan.tiles.map((tile) => {
    const file = tileFileName(tile.index);
    return {
      index: tile.index,
      file,
      path: path.join(outDir, file),
      width: tile.send.width,
      height: tile.send.height,
      coreInTile: { ...tile.core, x: tile.core.x - tile.send.x, y: tile.core.y - tile.send.y },
      cropInTile: { ...tile.crop, x: tile.crop.x - tile.send.x, y: tile.crop.y - tile.send.y },
      padding: paddingOf(tile.send, plan.source, plan.wrap),
    };
  });

  for (let i = 0; i < plan.tiles.length; i += PARALLEL_WRITES) {
    await Promise.all(
      plan.tiles.slice(i, i + PARALLEL_WRITES).map(async (tile) => {
        const pixels = extractRegion(source, tile.send, plan.wrap);
        await sharp(pixels, { raw: { width: tile.send.width, height: tile.send.height, channels: CHANNELS } })
          .png()
          .toFile(tiles[tile.index]!.path);
      }),
    );
  }

  const metadata: TilesMetadata = { version: 1, plan, tiles };
  const metadataPath = path.join(outDir, METADATA_FILE);
  const temp = `${metadataPath}.tmp`;
  writeFileSync(temp, JSON.stringify(metadata, null, 2));
  renameSync(temp, metadataPath);

  return { ...metadata, dir: outDir, metadataPath };
}
