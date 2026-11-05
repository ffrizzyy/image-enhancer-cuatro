// Runs the simulated job: bundles src/cli/sim.ts (it imports workspace packages that are TypeScript) and runs it.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Inside the package, so Node finds sharp in its node_modules.
const out = path.join(root, '.sim-build');
mkdirSync(out, { recursive: true });
const bundle = path.join(out, 'sim.mjs');

try {
  await build({
    entryPoints: [path.join(root, 'src', 'cli', 'sim.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    logLevel: 'error',
    // Native, and the built-in SQLite, stay outside the bundle.
    external: ['sharp'],
    // Some bundled dependencies still use require().
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  const result = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: 'inherit', cwd: root, env: process.env });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
