import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { JobMode } from '@ie/contracts';

import { runSimulation } from '../sim.ts';

const USAGE = 'Usage: sim [--tiles <1-36, default 8>] [--fail-rate <0-1, default 0.2>] [--seed <n>] [--mode chained|independent] [--out <folder>]';

function parse(argv: readonly string[]) {
  const options = { tiles: 8, failRate: 0.2, seed: 1, mode: 'chained' as JobMode, out: '' };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`Missing a value after ${flag}.\n${USAGE}`);
    switch (flag) {
      case '--tiles':
        options.tiles = Number(value);
        break;
      case '--fail-rate':
        options.failRate = Number(value);
        break;
      case '--seed':
        options.seed = Number(value);
        break;
      case '--mode':
        if (value !== 'chained' && value !== 'independent') throw new Error(`--mode must be chained or independent.\n${USAGE}`);
        options.mode = value;
        break;
      case '--out':
        options.out = value;
        break;
      default:
        throw new Error(`Unknown option ${flag}.\n${USAGE}`);
    }
  }
  if (!(options.failRate >= 0 && options.failRate <= 1)) throw new Error(`--fail-rate must be from 0 to 1.\n${USAGE}`);
  return options;
}

/** The simulated run: a whole job through the fake provider, printed as a short report. Exit 0 when every tile settled. */
async function main(): Promise<number> {
  // `pnpm sim -- --tiles 8` hands the lone `--` on to us.
  const args = parse(process.argv.slice(2).filter((arg) => arg !== '--'));
  const outDir = args.out || mkdtempSync(path.join(tmpdir(), 'ie-sim-'));
  const result = await runSimulation({ tiles: args.tiles, failRate: args.failRate, seed: args.seed, mode: args.mode, outDir });

  const count = (state: string) => result.tiles.filter((t) => t.state === state).length;
  console.log(`Simulated job: ${args.tiles} tiles, ${args.mode}, fail rate ${args.failRate}, seed ${args.seed}`);
  console.log(`Result: ${result.state}${result.message ? ` (${result.message})` : ''}`);
  console.log(`Tiles: ${count('accepted')} accepted, ${count('needs-review')} need review, ${count('failed')} failed, ${result.tiles.length - count('accepted') - count('needs-review') - count('failed')} unfinished`);
  console.log(`Provider calls: ${result.providerCalls} (${result.providerCalls - result.tiles.length} more than one per tile), pauses resumed: ${result.pauses}`);
  for (const tile of result.tiles) console.log(`  tile ${tile.index + 1}: ${tile.state}, ${tile.attempts} attempt${tile.attempts === 1 ? '' : 's'}`);
  if (result.stitched) console.log(`Stitched: ${result.stitched.imagePath} (seam score ${result.stitched.metrics.seamScore.toFixed(2)}, max delta E ${result.stitched.metrics.maxDeltaE.toFixed(2)})`);
  console.log(`Files: ${outDir}`);

  const settled = result.tiles.every((t) => t.state === 'accepted' || t.state === 'needs-review');
  const finished = result.state === 'done' || result.state === 'needs-review';
  return settled && finished ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  },
);
