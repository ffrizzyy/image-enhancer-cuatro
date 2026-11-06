import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const RENDERER = path.join(__dirname, '..', 'renderer', 'src');
// Only the typed contracts (and the preset *types* via contracts) may reach the renderer; everything else lives in the main process.
const FORBIDDEN = ['@ie/providers', '@ie/sessions', '@ie/orchestrator', '@ie/stitcher', '@ie/slicer', '@ie/intake', '@ie/presets', 'electron', 'node:'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe('renderer isolation', () => {
  it('imports no provider, session, orchestrator, stitcher, slicer, intake, presets, electron or node module', () => {
    const offenders: string[] = [];
    for (const file of files(RENDERER)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const spec = match[1]!;
        if (FORBIDDEN.some((bad) => spec === bad || spec.startsWith(`${bad}/`) || (bad.endsWith(':') && spec.startsWith(bad)))) {
          offenders.push(`${path.relative(RENDERER, file)} imports ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
