import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { compareWithSource, extractTiles, planTiles, reassembleCores, type Rgba } from '../src';
import { noisePng } from './helpers';

let dir: string;
const file = (name: string): string => path.join(dir, name);

const FIXTURES = [
  { name: '1001x777', width: 1001, height: 777 },
  { name: '4000x500', width: 4000, height: 500 },
  { name: '512x512', width: 512, height: 512 },
] as const;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ie-roundtrip-'));
  for (const [i, f] of FIXTURES.entries()) writeFileSync(file(`${f.name}.png`), await noisePng(f.width, f.height, 100 + i));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function roundTrip(name: string, options: Parameters<typeof planTiles>[0], label: string) {
  const plan = planTiles(options);
  const tiles = await extractTiles(file(`${name}.png`), plan, file(`out-${label}`));
  const rebuilt = await reassembleCores(plan, tiles.tiles);
  return { plan, tiles, rebuilt, result: await compareWithSource(file(`${name}.png`), rebuilt) };
}

describe('slice then unchanged stitch is pixel-identical', () => {
  for (const f of FIXTURES) {
    describe(f.name, () => {
      const grids = [
        { rows: 2, cols: 3 },
        { rows: 2, cols: 4 },
        { rows: 3, cols: 2 },
        { rows: 6, cols: 6 },
        { rows: 1, cols: 1 },
        { rows: 1, cols: 6 },
        { rows: 6, cols: 1 },
      ];

      it.each(grids)('%o with overlap', async (grid) => {
        const { result } = await roundTrip(f.name, { width: f.width, height: f.height, ...grid, overlapPct: 15 }, `${f.name}-${grid.rows}x${grid.cols}`);
        expect(result).toEqual({ differentPixels: 0, identical: true });
      });

      it('with 40% overlap and wrap mode', async () => {
        const { result } = await roundTrip(f.name, { width: f.width, height: f.height, rows: 2, cols: 3, overlapPct: 40, wrap: true }, `${f.name}-wrap`);
        expect(result.identical).toBe(true);
      });

      it('with no overlap and a custom aspect list', async () => {
        const { result } = await roundTrip(f.name, { width: f.width, height: f.height, rows: 3, cols: 3, overlapPct: 0, aspects: [[16, 9]] }, `${f.name}-aspect`);
        expect(result.identical).toBe(true);
      });
    });
  }
});

describe('the round-trip helper detects damage', () => {
  it('reports differing pixels when a tile changes, and counts them', async () => {
    const { plan, tiles } = await roundTrip('512x512', { width: 512, height: 512, rows: 2, cols: 2, overlapPct: 10 }, 'tamper');

    // Overwrite tile 0 with a solid colour: its whole core (256x256) must now differ.
    const t = tiles.tiles[0]!;
    await sharp({ create: { width: t.width, height: t.height, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toFile(`${t.path}.new`);
    const { renameSync } = await import('node:fs');
    renameSync(`${t.path}.new`, t.path);

    const rebuilt = await reassembleCores(plan, tiles.tiles);
    const result = await compareWithSource(file('512x512.png'), rebuilt);
    expect(result.identical).toBe(false);
    expect(result.differentPixels).toBeGreaterThan(256 * 256 * 0.99);
    expect(result.differentPixels).toBeLessThanOrEqual(256 * 256);
  });

  it('reports a size mismatch as not identical', async () => {
    const wrong: Rgba = { data: Buffer.alloc(10 * 10 * 4), width: 10, height: 10 };
    const result = await compareWithSource(file('512x512.png'), wrong);
    expect(result.identical).toBe(false);
    expect(result.differentPixels).toBe(512 * 512);
  });

  it('fails clearly when a tile file is missing from the list', async () => {
    const { plan, tiles } = await roundTrip('512x512', { width: 512, height: 512, rows: 2, cols: 2, overlapPct: 0 }, 'missing');
    await expect(reassembleCores(plan, tiles.tiles.slice(1))).rejects.toThrow(/Missing tile file for index 0/);
  });
});
