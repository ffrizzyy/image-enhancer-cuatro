// Bundles src/validateCatalog.ts and validates every file in src/catalog; exits non-zero on any error.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(pkgRoot, 'dist-test', 'validate.mjs');

await build({
  stdin: {
    contents: `
      import { validateCatalogDir } from ${JSON.stringify(path.join(pkgRoot, 'src', 'validateCatalog.ts'))};
      const dir = process.argv[2];
      const { categories, errors } = validateCatalogDir(dir);
      for (const e of errors) console.error('ERROR ' + e);
      console.log(categories.length + ' categories, ' + errors.length + ' errors');
      process.exit(errors.length === 0 ? 0 : 1);
    `,
    resolveDir: pkgRoot,
    loader: 'ts',
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'warning',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});

const dir = process.argv[2] ?? path.join(pkgRoot, 'src', 'catalog');
const result = spawnSync(process.execPath, [outfile, dir], { stdio: 'inherit' });
process.exit(result.status ?? 1);
