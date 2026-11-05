/**
 * Run as its own process by the kill-mid-run test: runs a 6-tile job with a slow provider and is killed from outside
 * while it works. Bundled by the test (it imports workspace packages that are TypeScript).
 *   node crashRun.mjs <folder>
 */
import path from 'node:path';

import { runJob } from '../../src/runner.ts';
import { ScriptedAdapter, setupJob } from './scripted.ts';

const dir = process.argv[2]!;
const s = await setupJob(dir, { cols: 6 });
const adapter = new ScriptedAdapter({ outputDir: path.join(dir, 'provider'), delayMs: 250 });
console.log('STARTED');
await runJob({ store: s.store, jobId: s.job.id, adapter, workDir: s.workDir, getSessionStatus: async () => 'ready', sleep: async () => {} });
console.log('FINISHED'); // never reached when the test kills the process first
s.store.close();
