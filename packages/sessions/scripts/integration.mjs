// Bundles test/integration/main.ts and runs it under Electron (needs a real session implementation).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(pkgRoot, 'dist-test', 'main.cjs');

await build({
  entryPoints: [path.join(pkgRoot, 'test', 'integration', 'main.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  logLevel: 'warning',
});

// The `electron` package's main export is the path to the Electron binary.
const electronPath = createRequire(import.meta.url)('electron');
const result = spawnSync(electronPath, [outfile], { encoding: 'utf8', timeout: 60_000 });
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
console.log(output);

if (result.status !== 0 || !output.includes('INTEGRATION_OK')) {
  console.error(`integration failed (status ${result.status}, signal ${result.signal})`);
  process.exit(1);
}
