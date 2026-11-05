import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Fidelity } from '@ie/contracts';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { evaluateOutput, FIDELITY_THRESHOLDS, structuralSimilarity } from '../src/quality.ts';
import { mix, picture, resized, solid, writePng } from './support/images.ts';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ie-orch-quality-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const source = picture(1);
const other = picture(99);
const send = { width: 300, height: 200 };
let n = 0;
const file = async (image: typeof source) => writePng(image, path.join(dir, `o-${++n}.png`));
const judge = async (output: typeof source, fidelity: Fidelity) => evaluateOutput({ outputPath: await file(output), sourceTile: source, send, fidelity });

describe('structural similarity', () => {
  it('is 1 for the same picture and about 0 for an unrelated one', async () => {
    expect(await structuralSimilarity(source, source)).toBeCloseTo(1, 5);
    expect(await structuralSimilarity(source, other)).toBeLessThan(0.15);
  });

  it('falls steadily as the picture drifts from the source', async () => {
    const scores: number[] = [];
    for (const t of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) scores.push(await structuralSimilarity(source, mix(source, other, t)));
    for (let i = 1; i < scores.length; i++) expect(scores[i]!).toBeLessThan(scores[i - 1]!);
  });

  it('ignores fine detail: a sharper, larger, more detailed version still matches', async () => {
    const big = await resized(source, 900, 600);
    expect(await structuralSimilarity(source, big)).toBeGreaterThan(0.97);
    // Add per-pixel texture on top of the structure: detail, not a different picture.
    const noisy = Buffer.from(big.data);
    for (let i = 0; i < noisy.length; i += 4) {
      const wiggle = ((i * 2654435761) >>> 24) % 21 - 10;
      for (let c = 0; c < 3; c++) noisy[i + c] = Math.max(0, Math.min(255, noisy[i + c]! + wiggle));
    }
    expect(await structuralSimilarity(source, { ...big, data: noisy })).toBeGreaterThan(0.9);
  });
});

describe('thresholds', () => {
  it('are the spec values', () => {
    expect(FIDELITY_THRESHOLDS).toEqual({ strict: 0.9, preserve: 0.8, balanced: 0.65, reimagine: 0.4 });
  });

  // Each output sits between two thresholds, so exactly the fidelity levels at or below its score accept it.
  const bands: Array<{ name: string; mixWith: number; between: [number, number]; accepts: Fidelity[] }> = [
    { name: 'close to the source', mixWith: 0.1, between: [0.9, 1], accepts: ['strict', 'preserve', 'balanced', 'reimagine'] },
    { name: 'a little changed', mixWith: 0.25, between: [0.8, 0.9], accepts: ['preserve', 'balanced', 'reimagine'] },
    { name: 'noticeably changed', mixWith: 0.35, between: [0.65, 0.8], accepts: ['balanced', 'reimagine'] },
    { name: 'heavily changed', mixWith: 0.45, between: [0.4, 0.65], accepts: ['reimagine'] },
    { name: 'a different picture', mixWith: 0.6, between: [0, 0.4], accepts: [] },
  ];

  for (const band of bands) {
    describe(band.name, () => {
      it(`scores between ${band.between[0]} and ${band.between[1]}`, async () => {
        const score = await structuralSimilarity(source, mix(source, other, band.mixWith));
        expect(score).toBeGreaterThanOrEqual(band.between[0]);
        expect(score).toBeLessThan(band.between[1]);
      });

      for (const fidelity of ['strict', 'preserve', 'balanced', 'reimagine'] as const) {
        const accepted = band.accepts.includes(fidelity);
        it(`${accepted ? 'is accepted' : 'is rejected'} at ${fidelity} fidelity`, async () => {
          const verdict = await judge(mix(source, other, band.mixWith), fidelity);
          expect(verdict.accepted).toBe(accepted);
          expect(verdict.threshold).toBe(FIDELITY_THRESHOLDS[fidelity]);
          expect(verdict.reasons.length === 0).toBe(accepted);
          if (!accepted) expect(verdict.reasons[0]).toMatch(/no longer matches the source tile.*similarity \d\.\d\d, needs \d\.\d\d for \w+ fidelity/);
        });
      }
    });
  }
});

describe('sanity checks', () => {
  it('accepts a normal enhancement: the tile enlarged', async () => {
    const verdict = await judge(await resized(source, 900, 600), 'strict');
    expect(verdict).toMatchObject({ accepted: true, width: 900, height: 600 });
    expect(verdict.score).toBeGreaterThan(0.97);
  });

  it('rejects a file that is not an image', async () => {
    const bad = path.join(dir, 'bad.png');
    writeFileSync(bad, 'this is not a png');
    const verdict = await evaluateOutput({ outputPath: bad, sourceTile: source, send, fidelity: 'reimagine' });
    expect(verdict).toMatchObject({ accepted: false, score: null, reasons: ['The output is not a readable image.'] });
  });

  it('rejects a missing file', async () => {
    expect((await evaluateOutput({ outputPath: path.join(dir, 'gone.png'), sourceTile: source, send, fidelity: 'reimagine' })).accepted).toBe(false);
  });

  it('rejects an output too small to use', async () => {
    const verdict = await judge(await resized(source, 120, 80), 'reimagine');
    expect(verdict).toMatchObject({ accepted: false, width: 120, height: 80 });
    expect(verdict.reasons[0]).toMatch(/only 120x80 px/);
  });

  it('rejects an output reframed to a different shape, but allows rounding differences', async () => {
    expect((await judge(await resized(source, 600, 600), 'reimagine')).reasons[0]).toMatch(/different shape/);
    expect((await judge(await resized(source, 900, 604), 'strict')).accepted).toBe(true); // 0.7% off: rounding
  });

  it('rejects a blank frame, white or black', async () => {
    for (const value of [255, 0, 128]) {
      const verdict = await judge(solid(600, 400, value), 'reimagine');
      expect(verdict.accepted, `blank ${value}`).toBe(false);
      expect(verdict.reasons[0]).toMatch(/blank frame/);
    }
  });

  it('does not call a flat output blank when the source is flat too', async () => {
    const flat = solid(300, 200, 120);
    const verdict = await evaluateOutput({ outputPath: await file(flat), sourceTile: flat, send, fidelity: 'strict' });
    expect(verdict.accepted).toBe(true);
  });

  it('judges the output at the tile size, whatever size the provider returned', async () => {
    const small = await judge(await resized(source, 450, 300), 'strict');
    const large = await judge(await resized(source, 1800, 1200), 'strict');
    expect(small.accepted && large.accepted).toBe(true);
    expect(Math.abs((small.score ?? 0) - (large.score ?? 0))).toBeLessThan(0.02);
  });

  it('reads the real file format, not the extension', async () => {
    const jpeg = path.join(dir, 'real.jpg');
    writeFileSync(jpeg, await sharp(source.data, { raw: { width: 300, height: 200, channels: 4 } }).jpeg({ quality: 95 }).toBuffer());
    expect((await evaluateOutput({ outputPath: jpeg, sourceTile: source, send, fidelity: 'strict' })).accepted).toBe(true);
  });
});
