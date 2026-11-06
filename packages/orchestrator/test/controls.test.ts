import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  applyJobEvent,
  backoffDelayMs,
  cancelJob,
  DEFAULT_BACKOFF,
  IllegalTransitionError,
  openStore,
  pacingDelayMs,
  pauseJob,
  restoreJobs,
  resumeInfo,
  runJob,
  validatePacing,
  type PauseNotice,
  type RunJobOptions,
  type Store,
} from '../src';
import { ScriptedAdapter, setupJob, type JobSetup, type Step } from './support/scripted';

const here = path.dirname(fileURLToPath(import.meta.url));
let root: string;
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ie-orch-controls-'));
});
afterAll(() => {
  // A killed child can keep a handle on the temp folder for a moment on Windows; cleanup must not fail the suite.
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* the OS will clean up the temporary folder */
  }
});

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));

let n = 0;
async function setup(options: Parameters<typeof setupJob>[1] = {}): Promise<JobSetup> {
  const s = await setupJob(path.join(root, `t-${++n}`), options);
  stores.push(s.store);
  return s;
}
const adapterFor = (s: JobSetup, script?: readonly Step[]) => new ScriptedAdapter({ outputDir: path.join(s.dir, 'provider'), ...(script ? { script } : {}) });
const base = (s: JobSetup, adapter: ScriptedAdapter, extra: Partial<RunJobOptions> = {}): RunJobOptions => ({
  store: s.store,
  jobId: s.job.id,
  adapter,
  workDir: s.workDir,
  getSessionStatus: async () => 'ready',
  sleep: async () => {},
  ...extra,
});
const states = (s: JobSetup) => s.store.listTiles(s.job.id).map((t) => t.state);

describe('pacing', () => {
  const seq = (...values: number[]) => {
    let i = 0;
    return () => values[i++ % values.length]!;
  };

  it('picks a delay from the minimum to the maximum, whatever the random number', () => {
    const pacing = { concurrency: 1 as const, minDelayMs: 8000, maxDelayMs: 25_000 };
    expect(pacingDelayMs(pacing, () => 0)).toBe(8000);
    expect(pacingDelayMs(pacing, () => 0.5)).toBe(16_500);
    expect(pacingDelayMs(pacing, () => 0.999999)).toBeLessThanOrEqual(25_000);
    for (let i = 0; i < 200; i++) {
      const d = pacingDelayMs(pacing, Math.random);
      expect(d).toBeGreaterThanOrEqual(8000);
      expect(d).toBeLessThanOrEqual(25_000);
    }
  });

  it('accepts concurrency 1 or 2 and sane delays, and refuses anything else before a run starts', () => {
    expect(validatePacing({ concurrency: 2, minDelayMs: 0, maxDelayMs: 0 })).toEqual({ concurrency: 2, minDelayMs: 0, maxDelayMs: 0 });
    expect(() => validatePacing({ concurrency: 3 as never, minDelayMs: 1, maxDelayMs: 2 })).toThrow(/Concurrency must be 1 or 2/);
    expect(() => validatePacing({ concurrency: 1, minDelayMs: -1, maxDelayMs: 2 })).toThrow(RangeError);
    expect(() => validatePacing({ concurrency: 1, minDelayMs: 10, maxDelayMs: 5 })).toThrow(/maximum delay/);
    expect(() => validatePacing({ concurrency: 1, minDelayMs: Number.NaN, maxDelayMs: 5 })).toThrow(RangeError);
  });

  it('runJob refuses bad pacing without touching the job', async () => {
    const s = await setup({ cols: 1 });
    await expect(runJob(base(s, adapterFor(s), { pacing: { concurrency: 3 as never, minDelayMs: 0, maxDelayMs: 0 } }))).rejects.toThrow(RangeError);
    expect(s.store.getJob('J1')!.state).toBe('idle');
  });

  describe('backoff', () => {
    it('doubles from the base up to the cap, spread by at most 25%', () => {
      const none = () => 0.5; // no spread
      expect([1, 2, 3, 4, 5, 6, 7].map((r) => backoffDelayMs(r, DEFAULT_BACKOFF, none))).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
      expect(backoffDelayMs(2, DEFAULT_BACKOFF, () => 0)).toBe(22_500); // -25%
      expect(backoffDelayMs(2, DEFAULT_BACKOFF, () => 1)).toBe(37_500); // +25%
      for (let r = 1; r <= 12; r++) expect(backoffDelayMs(r, DEFAULT_BACKOFF, Math.random)).toBeLessThanOrEqual(DEFAULT_BACKOFF.maxMs);
    });

    it('is used between retries after a timeout or failed download, and grows with each one', async () => {
      const s = await setup({ cols: 2 });
      const sleep = vi.fn(async () => {});
      const adapter = adapterFor(s, [{ do: 'error', kind: 'timeout' }, { do: 'error', kind: 'download-failed' }, { do: 'ok' }, { do: 'ok' }]);
      const result = await runJob(base(s, adapter, { sleep, random: seq(0.5), backoff: { baseMs: 1000, maxMs: 60_000 }, pacing: { concurrency: 1, minDelayMs: 100, maxDelayMs: 100 } }));

      expect(result.state).toBe('done');
      // tile 0: timeout (backoff 1s), download failed (backoff 2s), ok -> then the usual pause before tile 1.
      expect(sleep.mock.calls.map((c) => (c as unknown as number[])[0])).toEqual([1000, 2000, 100]);
    });

    it('is not used after a quality rejection or a refusal, which are not passing problems', async () => {
      const s = await setup({ cols: 1 });
      const sleep = vi.fn(async () => {});
      await runJob(base(s, adapterFor(s, [{ do: 'bad' }, { do: 'error', kind: 'refusal' }, { do: 'ok' }]), { sleep, random: seq(0.5), backoff: { baseMs: 1000, maxMs: 1000 }, pacing: { concurrency: 1, minDelayMs: 7, maxDelayMs: 7 } }));
      expect(sleep.mock.calls.map((c) => (c as unknown as number[])[0])).toEqual([7, 7]);
    });
  });
});

describe('when the provider needs the user', () => {
  it.each([['challenge'], ['logged-out'], ['quota']] as const)('tells the app to show the provider window on %s, after the pause is saved', async (kind) => {
    const s = await setup({ cols: 3 });
    const notices: PauseNotice[] = [];
    const stateWhenTold: string[] = [];
    const result = await runJob(
      base(s, adapterFor(s, [{ do: 'ok' }, { do: 'error', kind }]), {
        onPause: (notice) => {
          notices.push(notice);
          stateWhenTold.push(s.store.getJob('J1')!.state);
        },
      }),
    );

    expect(result.state).toBe('paused');
    expect(notices).toEqual([{ jobId: 'J1', providerId: 'gemini', reason: kind, resumeAfter: kind === 'quota' ? expect.any(String) : null, message: expect.any(String) }]);
    expect(stateWhenTold).toEqual(['paused']); // already saved
  });

  it('does not loop: a pause stops the run with no further provider calls', async () => {
    const s = await setup({ cols: 4 });
    const adapter = adapterFor(s, [{ do: 'error', kind: 'challenge' }]);
    const sleep = vi.fn(async () => {});
    await runJob(base(s, adapter, { sleep }));
    expect(adapter.calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    // Calling run again while still blocked pauses again at once rather than spinning.
    const again = adapterFor(s, [{ do: 'error', kind: 'challenge' }]);
    expect((await runJob(base(s, again, { sleep }))).state).toBe('paused');
    expect(again.calls).toHaveLength(1);
  });

  it('the failing tile is queued again without losing a try, so pausing never drives a tile to review', async () => {
    const s = await setup({ cols: 1 });
    for (let i = 0; i < 6; i++) {
      expect((await runJob(base(s, adapterFor(s, [{ do: 'error', kind: 'quota' }])))).state).toBe('paused');
    }
    const tile = s.store.getTile('J1', 0)!;
    expect(tile.state).toBe('pending');
    expect(tile.attempts).toBe(6); // six calls were made...
    expect((await runJob(base(s, adapterFor(s)))).state).toBe('done'); // ...and it still ran normally afterwards
  });

  it('explains a pause in plain words, and how long a usage limit may last', async () => {
    const s = await setup({ cols: 2 });
    const at = new Date('2026-11-05T12:00:00.000Z');
    await runJob(base(s, adapterFor(s, [{ do: 'error', kind: 'quota' }]), { now: () => at }));
    const record = s.store.getJob('J1')!;

    expect(resumeInfo(record, at)).toMatchObject({ resumable: true, waitMs: 3_600_000, message: expect.stringMatching(/usage limit.*about 60 minutes/) });
    expect(resumeInfo(record, new Date(at.getTime() + 2 * 3_600_000))).toMatchObject({ waitMs: 0, message: expect.stringMatching(/probably reset by now/) });
    expect(resumeInfo({ ...record, pauseReason: 'challenge', resumeAfter: null })).toMatchObject({ message: expect.stringMatching(/human check/) });
    expect(resumeInfo({ ...record, pauseReason: 'logged-out', resumeAfter: null }).message).toMatch(/logged out/);
    expect(resumeInfo({ ...record, pauseReason: 'user', resumeAfter: null }).message).toMatch(/You paused/);
    expect(resumeInfo({ ...record, state: 'running', pauseReason: null })).toMatchObject({ resumable: false });
  });
});

describe('the user pauses, resumes and cancels', () => {
  it('a pause during a run stops it after the current tile, with everything saved, and it resumes where it left off', async () => {
    const s = await setup({ cols: 5 });
    const first = adapterFor(s);
    const result = await runJob(base(s, first, { onTile: (index) => index === 1 && pauseJob(s.store, 'J1') }));

    expect(result.state).toBe('paused');
    expect(s.store.getJob('J1')).toMatchObject({ state: 'paused', pauseReason: 'user' });
    expect(first.calls.map((c) => c.tile)).toEqual([0, 1]); // stopped after the tile being worked on
    expect(states(s)).toEqual(['accepted', 'accepted', 'pending', 'pending', 'pending']);

    const second = adapterFor(s);
    expect((await runJob(base(s, second))).state).toBe('done');
    expect(second.calls.map((c) => c.tile)).toEqual([2, 3, 4]);
  });

  it('pausing twice is harmless, and a job that is not running cannot be paused', async () => {
    const s = await setup({ cols: 2 });
    expect(() => pauseJob(s.store, 'J1')).toThrow(IllegalTransitionError); // idle
    applyJobEvent(s.store, 'J1', { type: 'START' });
    applyJobEvent(s.store, 'J1', { type: 'PREFLIGHT_PASSED' });
    pauseJob(s.store, 'J1');
    const events = s.store.listEvents('J1').length;
    expect(pauseJob(s.store, 'J1').state).toBe('paused');
    expect(s.store.listEvents('J1')).toHaveLength(events);
    expect(() => pauseJob(s.store, 'nope')).toThrow(IllegalTransitionError);
  });

  it('cancelling a running job stops it and is final', async () => {
    const s = await setup({ cols: 5 });
    const adapter = adapterFor(s);
    const result = await runJob(base(s, adapter, { onTile: (index) => index === 0 && cancelJob(s.store, 'J1') }));
    expect(result.state).toBe('cancelled');
    expect(adapter.calls).toHaveLength(1);
    expect(s.store.getTile('J1', 0)!.state).toBe('accepted'); // finished work is kept
    for (const type of ['START', 'RESUME', 'PREFLIGHT_PASSED'] as const) expect(() => applyJobEvent(s.store, 'J1', { type })).toThrow(IllegalTransitionError);
    expect(() => cancelJob(s.store, 'J1')).toThrow(IllegalTransitionError); // already final
    expect((await runJob(base(s, adapterFor(s)))).state).toBe('cancelled');
  });

  it('cancels from every state that can still change', async () => {
    const reach: Record<string, (s: JobSetup) => Promise<void> | void> = {
      idle: () => {},
      preflight: (s) => void applyJobEvent(s.store, 'J1', { type: 'START' }),
      running: (s) => {
        applyJobEvent(s.store, 'J1', { type: 'START' });
        applyJobEvent(s.store, 'J1', { type: 'PREFLIGHT_PASSED' });
      },
      paused: async (s) => void (await runJob(base(s, adapterFor(s, [{ do: 'error', kind: 'challenge' }])))),
      'needs-review': () => {}, // reached below: one tile that always fails the quality gate
      stitching: async (s) => {
        applyJobEvent(s.store, 'J1', { type: 'START' });
        applyJobEvent(s.store, 'J1', { type: 'PREFLIGHT_PASSED' });
        applyJobEvent(s.store, 'J1', { type: 'TILES_DONE' });
      },
    };
    for (const [state, getThere] of Object.entries(reach)) {
      const s = await setup({ cols: 1 });
      if (state === 'needs-review') {
        // One tile that always fails the quality gate.
        await runJob(base(s, new ScriptedAdapter({ outputDir: path.join(s.dir, 'provider'), script: () => ({ do: 'bad' }) })));
      } else {
        await getThere(s);
      }
      expect(s.store.getJob('J1')!.state, `reached ${state}`).toBe(state);
      expect(cancelJob(s.store, 'J1').state, `cancel from ${state}`).toBe('cancelled');
    }
  });

  it('refuses to cancel a job that is already done or failed', async () => {
    const done = await setup({ cols: 1 });
    await runJob(base(done, adapterFor(done)));
    expect(() => cancelJob(done.store, 'J1')).toThrow(IllegalTransitionError);
    const failed = await setup({ cols: 1 });
    await runJob(base(failed, adapterFor(failed, [{ do: 'error', kind: 'ui-changed' }])));
    expect(() => cancelJob(failed.store, 'J1')).toThrow(IllegalTransitionError);
  });

  it('a cancelled job is not restored on the next start', async () => {
    const s = await setup({ cols: 3 });
    await runJob(base(s, adapterFor(s), { onTile: (i) => i === 0 && cancelJob(s.store, 'J1') }));
    expect(restoreJobs(s.store)).toEqual([]);
  });
});

describe('kill the process mid-run, then restart (a real process)', () => {
  const bundle = path.join(here, '..', '.test-build', 'crashRun.mjs');

  beforeAll(async () => {
    await build({
      entryPoints: [path.join(here, 'support', 'crashRun.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      logLevel: 'error',
      external: ['sharp'],
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    });
  });
  afterAll(() => {
    try {
      rmSync(path.dirname(bundle), { recursive: true, force: true });
    } catch {
      /* the OS will clean up the temporary folder */
    }
  });

  it('keeps finished tiles, queues the cut-off one again, and finishes without redoing any accepted tile', async () => {
    const dir = path.join(root, 'kill');
    const dbPath = path.join(dir, 'jobs.sqlite');
    const child = spawn(process.execPath, [bundle, dir], { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));

    // Wait until it has finished a couple of tiles and is partway through the next, then kill it.
    const deadline = Date.now() + 60_000;
    let reader: Store | null = null;
    let acceptedAtKill: Array<[number, string | null, number]> = [];
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (!existsSync(dbPath)) continue;
      reader ??= openStore(dbPath);
      const tiles = reader.listTiles('J1');
      if (tiles.filter((t) => t.state === 'accepted').length >= 2) {
        acceptedAtKill = tiles.filter((t) => t.state === 'accepted').map((t) => [t.index, t.outputPath, t.attempts]);
        break;
      }
    }
    expect(acceptedAtKill.length).toBeGreaterThanOrEqual(2);
    child.kill('SIGKILL');
    await exited;
    reader?.close();
    expect(stdout).toContain('STARTED');
    expect(stdout).not.toContain('FINISHED'); // it really was killed mid-job

    // Restart.
    const store = openStore(dbPath);
    stores.push(store);
    expect(store.getJob('J1')!.state).toBe('running'); // it never got to finish
    const acceptedBefore = store.listTiles('J1').filter((t) => t.state === 'accepted').map((t) => t.index);
    const restored = restoreJobs(store);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.accepted).toBeGreaterThanOrEqual(acceptedAtKill.length);
    expect(restored[0]!.interruptedTiles.length).toBeLessThanOrEqual(1);

    const adapter = new ScriptedAdapter({ outputDir: path.join(dir, 'provider-2') });
    const result = await runJob({ store, jobId: 'J1', adapter, workDir: path.join(dir, 'J1-work'), getSessionStatus: async () => 'ready', sleep: async () => {} });

    expect(result.state).toBe('done');
    // Nothing that was accepted before the kill was run again...
    for (const index of acceptedBefore) expect(adapter.calls.map((c) => c.tile)).not.toContain(index);
    // ...and its output is exactly what it was.
    for (const [index, output, attempts] of acceptedAtKill) expect(store.getTile('J1', index)).toMatchObject({ state: 'accepted', outputPath: output, attempts });
    // Every tile has exactly one successful attempt: none was done twice.
    for (const tile of store.listTiles('J1')) expect(store.listAttempts('J1', tile.index).filter((a) => a.outcome === 'ok')).toHaveLength(1);
    // A cut-off attempt, if there was one, is on record as interrupted.
    expect(store.listAttempts('J1').some((a) => a.outcome === null)).toBe(false);
  }, 120_000);
});
