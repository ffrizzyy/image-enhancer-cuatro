import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TilePlanSchema } from '@ie/contracts';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ExtractError, extractTiles, loadRgba, mapIndex, METADATA_FILE, planTiles, tileFileName } from '../src';
import { noisePng } from './helpers';

let dir: string;
const file = (name: string): string => path.join(dir, name);

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ie-extract-'));
  writeFileSync(file('wide.png'), await noisePng(4000, 500, 1));
  writeFileSync(file('small.png'), await noisePng(600, 400, 2));
  writeFileSync(file('alpha.png'), await noisePng(300, 200, 3, true));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const pixel = (rgba: { data: Buffer; width: number }, x: number, y: number): number[] =>
  [...rgba.data.subarray((y * rgba.width + x) * 4, (y * rgba.width + x) * 4 + 4)];

describe('extractTiles', () => {
  it('writes one PNG per tile with stable names, sized to the send rect', async () => {
    const plan = planTiles({ width: 600, height: 400, rows: 2, cols: 3, overlapPct: 10 });
    const out = await extractTiles(file('small.png'), plan, file('out-a'));

    expect(readdirSync(file('out-a')).sort()).toEqual([METADATA_FILE, ...plan.tiles.map((t) => tileFileName(t.index))].sort());
    expect(tileFileName(7)).toBe('tile-007.png');
    for (const tile of out.tiles) {
      const planned = plan.tiles[tile.index]!;
      const meta = await sharp(tile.path).metadata();
      expect([meta.width, meta.height]).toEqual([planned.send.width, planned.send.height]);
      expect([tile.width, tile.height]).toEqual([planned.send.width, planned.send.height]);
      expect(tile.file).toBe(`tile-${String(tile.index).padStart(3, '0')}.png`);
    }
  });

  it('is a pure crop: tile pixels equal the source pixels of the send rect', async () => {
    const plan = planTiles({ width: 600, height: 400, rows: 2, cols: 3, overlapPct: 10 });
    const source = await loadRgba(file('small.png'));
    const out = await extractTiles(file('small.png'), plan, file('out-b'));

    const t = plan.tiles[1]!;
    const image = await loadRgba(out.tiles[1]!.path);
    for (const [x, y] of [[0, 0], [5, 7], [t.send.width - 1, t.send.height - 1], [100, 3]] as const) {
      expect(pixel(image, x, y)).toEqual(pixel(source, t.send.x + x, t.send.y + y));
    }
  });

  it('mirrors padding that cannot fit inside the image (4000x500 strip)', async () => {
    const plan = planTiles({ width: 4000, height: 500, rows: 1, cols: 6, overlapPct: 10 });
    const t = plan.tiles[2]!;
    expect(t.send.y).toBe(-6);

    const source = await loadRgba(file('wide.png'));
    const out = await extractTiles(file('wide.png'), plan, file('out-c'));
    const image = await loadRgba(out.tiles[2]!.path);

    expect(out.tiles[2]!.padding).toBe('reflected');
    for (let j = 0; j < t.send.height; j++) {
      const sourceRow = mapIndex(t.send.y + j, 500, false);
      expect(pixel(image, 10, j)).toEqual(pixel(source, t.send.x + 10, sourceRow));
    }
    // Rows 0..5 are source rows 5..0 (mirrored), then the image continues unchanged.
    expect(pixel(image, 0, 0)).toEqual(pixel(source, t.send.x, 5));
    expect(pixel(image, 0, 5)).toEqual(pixel(source, t.send.x, 0));
    expect(pixel(image, 0, 6)).toEqual(pixel(source, t.send.x, 0));
  });

  it('reads padding from the opposite edge in wrap mode', async () => {
    const plan = planTiles({ width: 600, height: 400, rows: 2, cols: 3, overlapPct: 10, wrap: true });
    const source = await loadRgba(file('small.png'));
    const out = await extractTiles(file('small.png'), plan, file('out-d'));
    const image = await loadRgba(out.tiles[0]!.path);

    expect(plan.tiles[0]!.send).toMatchObject({ x: -20, y: -20 });
    expect(out.tiles[0]!.padding).toBe('wrapped');
    expect(pixel(image, 0, 0)).toEqual(pixel(source, 580, 380));
    expect(pixel(image, 20, 20)).toEqual(pixel(source, 0, 0));
    expect(pixel(image, 0, 25)).toEqual(pixel(source, 580, 5));
  });

  it('records where each core and crop sit inside its tile image, and the padding kind', async () => {
    const plan = planTiles({ width: 600, height: 400, rows: 2, cols: 3, overlapPct: 10 });
    const out = await extractTiles(file('small.png'), plan, file('out-e'));

    for (const tile of out.tiles) {
      const planned = plan.tiles[tile.index]!;
      expect(tile.coreInTile).toEqual({
        x: planned.core.x - planned.send.x,
        y: planned.core.y - planned.send.y,
        width: planned.core.width,
        height: planned.core.height,
      });
      expect(tile.cropInTile.x).toBe(planned.crop.x - planned.send.x);
      expect(tile.padding).toBe('none'); // every send rect fits inside this 600x400 image
    }
  });

  it('writes tiles.json with the plan and tile list', async () => {
    const plan = planTiles({ width: 600, height: 400, rows: 2, cols: 3, overlapPct: 10 });
    const out = await extractTiles(file('small.png'), plan, file('out-f'));
    const metadata = JSON.parse(readFileSync(out.metadataPath, 'utf8'));

    expect(out.metadataPath).toBe(path.join(file('out-f'), METADATA_FILE));
    expect(metadata.version).toBe(1);
    expect(TilePlanSchema.safeParse(metadata.plan).success).toBe(true);
    expect(metadata.tiles).toHaveLength(6);
    expect(metadata.tiles[3]).toMatchObject({ index: 3, file: 'tile-003.png' });
    expect(readdirSync(file('out-f')).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('is reproducible: the same plan twice gives byte-identical files', async () => {
    const plan = planTiles({ width: 600, height: 400, rows: 2, cols: 3, overlapPct: 10 });
    const a = await extractTiles(file('small.png'), plan, file('out-g1'));
    const b = await extractTiles(file('small.png'), plan, file('out-g2'));
    for (const t of a.tiles) {
      expect(readFileSync(t.path).equals(readFileSync(b.tiles[t.index]!.path))).toBe(true);
    }
  });

  it('keeps alpha, including fully transparent pixels, exactly', async () => {
    const plan = planTiles({ width: 300, height: 200, rows: 2, cols: 2, overlapPct: 0 });
    const source = await loadRgba(file('alpha.png'));
    const out = await extractTiles(file('alpha.png'), plan, file('out-h'));
    const image = await loadRgba(out.tiles[3]!.path);
    const t = plan.tiles[3]!;
    for (let i = 0; i < 200; i++) {
      const x = (i * 7) % t.send.width;
      const y = (i * 13) % t.send.height;
      expect(pixel(image, x, y)).toEqual(pixel(source, t.send.x + x, t.send.y + y));
    }
  });

  it('never modifies the original file', async () => {
    const before = { hash: createHash('sha256').update(readFileSync(file('small.png'))).digest('hex'), mtime: statSync(file('small.png')).mtimeMs };
    await extractTiles(file('small.png'), planTiles({ width: 600, height: 400, rows: 3, cols: 3, overlapPct: 20 }), file('out-i'));
    expect(createHash('sha256').update(readFileSync(file('small.png'))).digest('hex')).toBe(before.hash);
    expect(statSync(file('small.png')).mtimeMs).toBe(before.mtime);
  });

  it('refuses a plan made for a different image size', async () => {
    const plan = planTiles({ width: 601, height: 400, rows: 2, cols: 3, overlapPct: 0 });
    await expect(extractTiles(file('small.png'), plan, file('out-j'))).rejects.toThrow(ExtractError);
    await expect(extractTiles(file('small.png'), plan, file('out-j'))).rejects.toThrow(/601x400/);
    expect(() => readdirSync(file('out-j'))).toThrow(); // nothing was written
  });

  it('applies EXIF orientation, so tiles follow the displayed image', async () => {
    // 120x60 stored, orientation 6 = rotate 90 degrees clockwise: displayed 60x120, left half becomes the top.
    const raw = Buffer.alloc(120 * 60 * 3);
    for (let y = 0; y < 60; y++) for (let x = 0; x < 120; x++) raw.set(x < 60 ? [255, 0, 0] : [0, 0, 255], (y * 120 + x) * 3);
    writeFileSync(file('rotated.jpg'), await sharp(raw, { raw: { width: 120, height: 60, channels: 3 } }).jpeg({ quality: 100 }).withMetadata({ orientation: 6 }).toBuffer());

    const plan = planTiles({ width: 60, height: 120, rows: 2, cols: 1, overlapPct: 0 });
    const out = await extractTiles(file('rotated.jpg'), plan, file('out-k'));
    const top = await loadRgba(out.tiles[0]!.path);
    const bottom = await loadRgba(out.tiles[1]!.path);

    expect(pixel(top, 30, 30)[0]).toBeGreaterThan(200);
    expect(pixel(top, 30, 30)[2]).toBeLessThan(60);
    expect(pixel(bottom, 30, 30)[2]).toBeGreaterThan(200);
    expect(pixel(bottom, 30, 30)[0]).toBeLessThan(60);
  });
});
