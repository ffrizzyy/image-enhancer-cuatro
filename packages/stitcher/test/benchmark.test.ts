import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { extractRegion, loadRgba, planTiles, type Rgba } from '@ie/slicer';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { findOverlaps, seamScore, stitch } from '../src';
import { castLab } from './support/synth';

/**
 * The performance gate: 8 tiles at 8192x4096 must stitch in under 20 s. It builds a 134 MB image and runs for
 * a while, so it only runs on request: `IE_BENCH=1 pnpm --filter @ie/stitcher test benchmark`.
 */
const BUDGET_MS = 20_000;
const enabled = process.env.IE_BENCH === '1';

/** Per-pixel noise in 0..1 from the coordinates (a sequential generator leaves stripes at power-of-two widths). */
function hash(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A fast photographic-ish image: smooth gradients, mid-frequency waves and per-pixel noise, in the safe gamut. */
function bigImage(width: number, height: number): Rgba {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const noise = hash(x, y) - 0.5;
      const i = (y * width + x) * 4;
      data[i] = 110 + 60 * Math.sin(x / 97) * Math.cos(y / 131) + 40 * (x / width) + 14 * noise;
      data[i + 1] = 110 + 60 * Math.sin(x / 61 + y / 211) + 30 * (y / height) + 14 * noise;
      data[i + 2] = 110 + 55 * Math.cos(x / 149 - y / 77) + 25 * ((x + y) / (width + height)) + 14 * noise;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

describe.skipIf(!enabled)('stitcher performance gate (IE_BENCH=1)', () => {
  it('stitches 8 tiles at 8192x4096 in under 20 s', { timeout: 600_000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ie-bench-'));
    try {
      const width = 8192;
      const height = 4096;
      const source = bigImage(width, height);
      const sourcePath = path.join(dir, 'source.png');
      await sharp(source.data, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 1 }).toFile(sourcePath);

      const plan = planTiles({ width, height, rows: 2, cols: 4, overlapPct: 15 });
      const tilesDir = path.join(dir, 'tiles');
      mkdirSync(tilesDir);

      // What a provider returns: the tile at about 1536 px on its long side, with a colour cast. Untimed setup.
      const tiles: Array<{ index: number; path: string }> = [];
      for (const tile of plan.tiles) {
        const region: Rgba = { data: extractRegion(source, tile.send, plan.wrap), width: tile.send.width, height: tile.send.height };
        const scale = 1536 / Math.max(region.width, region.height);
        const resized = await sharp(region.data, { raw: { width: region.width, height: region.height, channels: 4 } })
          .resize(Math.round(region.width * scale), Math.round(region.height * scale))
          .raw()
          .toBuffer({ resolveWithObject: true });
        const cast = castLab({ data: resized.data, width: resized.info.width, height: resized.info.height }, { dL: ((tile.index % 3) - 1) * 3, da: (tile.index % 2) * 2 });
        const file = path.join(tilesDir, `tile-${tile.index}.png`);
        await sharp(cast.data, { raw: { width: cast.width, height: cast.height, channels: 4 } }).png({ compressionLevel: 1 }).toFile(file);
        tiles.push({ index: tile.index, path: file });
      }

      const result = await stitch({ plan, tiles, options: { blend: 'multiband', maxShiftPx: 8, harmonize: true } }, { sourcePath, outDir: path.join(dir, 'out') });
      console.log('BENCHMARK', JSON.stringify({ totalMs: Math.round(result.timingsMs.total), ...Object.fromEntries(Object.entries(result.timingsMs).map(([k, v]) => [k, Math.round(v)])), metrics: result.metrics, flagged: result.flagged, peakRssMb: Math.round(process.memoryUsage().rss / 1e6) }));
      const worst = seamScore(plan, await loadRgba(result.imagePath), source).perOverlap.sort((a, b) => b.score - a.score).slice(0, 5);
      console.log('WORST OVERLAPS', worst.map((o) => `${o.a}-${o.b}:${o.score.toFixed(2)}`).join(' '), '| overlaps:', JSON.stringify(findOverlaps(plan).filter((o) => worst.some((w) => w.a === o.a && w.b === o.b)).map((o) => ({ a: o.a, b: o.b, rect: o.rect }))));
      expect(result.timingsMs.total).toBeLessThan(BUDGET_MS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
