/**
 * Run as a separate process by the tests: it records some progress in the job database and then dies without
 * closing anything, the way a crash or a killed app would.
 *   node crashChild.ts <db> crash | hold <ms>
 */
import { openStore } from '../../src/store.ts';
import { makeJob, rowPlan } from './fixtures.ts';

const [dbPath, mode, arg] = process.argv.slice(2) as [string, string, string | undefined];
const store = openStore(dbPath);

if (mode === 'crash') {
  store.createJob({ job: makeJob('CRASH'), plan: rowPlan(4), mode: 'chained' });
  store.setJobState('CRASH', 'running');
  const first = store.startAttempt('CRASH', 0);
  store.finishAttempt(first.id, { outcome: 'ok', outputPath: 'C:\\out\\0.png', elapsedMs: 1200 });
  store.updateTile('CRASH', 0, { state: 'accepted', outputPath: 'C:\\out\\0.png' });
  store.startAttempt('CRASH', 1); // in flight when the process dies
  console.log('READY');
  process.kill(process.pid, 'SIGKILL');
}

if (mode === 'hold') {
  // Holds the write lock for a while, then lets go.
  store.transaction(() => {
    store.createJob({ job: makeJob('HOLD'), plan: rowPlan(2), mode: 'independent' });
    console.log('LOCKED');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(arg ?? 300));
  });
  store.close();
}

if (mode === 'open') {
  // Only opens the database (running the migrations) and exits, at the same time as other such processes.
  store.close();
  console.log('OPEN');
}
