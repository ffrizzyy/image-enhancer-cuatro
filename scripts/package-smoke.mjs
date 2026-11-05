// Launches the packaged Windows build in smoke mode and requires the IPC ping to render.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, 'apps', 'desktop', 'release', 'win-unpacked', 'Image Enhancer.exe');

if (!existsSync(exe)) {
  console.error(`Packaged app not found: ${exe}\nRun "pnpm package" first.`);
  process.exit(1);
}

const result = spawnSync(exe, ['--smoke'], { encoding: 'utf8', timeout: 60_000 });
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

if (result.status === 0 && output.includes('SMOKE_OK')) {
  console.log('package smoke: OK');
} else {
  const spawnError = result.error ? `\nCould not launch the exe: ${result.error.message}` : '';
  const hint = result.error
    ? '\nIf Windows blocked it (Smart App Control / App Control policy), the exe is unsigned: sign it, or run this check on a machine or CI runner without that policy.'
    : '';
  console.error(`package smoke: FAILED (status ${result.status}, signal ${result.signal})${spawnError}${hint}\n${output}`);
  process.exit(1);
}
