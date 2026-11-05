import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { build as viteBuild } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(root, '..');
const dist = path.join(appRoot, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
  // Native modules stay external and ship in node_modules (see electron-builder.yml).
  external: ['electron', 'sharp'],
};

await build({
  ...shared,
  entryPoints: [path.join(appRoot, 'main/index.ts')],
  outfile: path.join(dist, 'main.mjs'),
  format: 'esm',
});

await build({
  ...shared,
  entryPoints: [path.join(appRoot, 'preload/index.ts')],
  outfile: path.join(dist, 'preload.cjs'),
  format: 'cjs',
});

await viteBuild({ configFile: path.join(appRoot, 'vite.config.ts') });
