import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type { Job, JobMode, JobState, PauseReason, ProviderId, TilePlan, TileState } from '@ie/contracts';

import { MIGRATIONS } from './migrations.ts';

export type StoreErrorCode = 'newer-schema' | 'not-found' | 'exists' | 'invalid';

export class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export interface JobRecord {
  job: Job;
  mode: JobMode;
  plan: TilePlan;
  state: JobState;
  pauseReason: PauseReason | null;
  /** ISO time after which a quota pause may be resumed. */
  resumeAfter: string | null;
  /** Why the job failed. */
  error: string | null;
  updatedAt: string;
}

export interface TileRecord {
  jobId: string;
  index: number;
  state: TileState;
  attempts: number;
  outputPath: string | null;
  promptOverride: string | null;
  note: string | null;
  updatedAt: string;
}

export type AttemptOutcome = 'ok' | 'error' | 'rejected' | 'interrupted';

export interface AttemptRecord {
  id: number;
  jobId: string;
  tileIndex: number;
  /** 1 for the first try of a tile. */
  n: number;
  startedAt: string;
  finishedAt: string | null;
  /** Null while the attempt is still running (or was cut off by a crash). */
  outcome: AttemptOutcome | null;
  errorKind: string | null;
  message: string | null;
  outputPath: string | null;
  elapsedMs: number | null;
}

export type EventLevel = 'info' | 'warn' | 'error';

export interface EventRecord {
  id: number;
  jobId: string;
  at: string;
  level: EventLevel;
  message: string;
  data: unknown;
}

export interface JobStateChange {
  pauseReason?: PauseReason | null;
  resumeAfter?: string | null;
  error?: string | null;
}

export interface TilePatch {
  state?: TileState;
  outputPath?: string | null;
  promptOverride?: string | null;
  note?: string | null;
}

export interface AttemptResult {
  outcome: AttemptOutcome;
  errorKind?: string | null;
  message?: string | null;
  outputPath?: string | null;
  elapsedMs?: number | null;
}

export interface StoreOptions {
  /** How long a writer waits for another connection's write to finish before failing. */
  busyTimeoutMs?: number;
  now?: () => Date;
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

type Row = Record<string, unknown>;

export interface Store {
  readonly path: string;
  /** Runs `fn` as one atomic unit: everything in it commits together or not at all. Nested calls join the outer one. */
  transaction<T>(fn: () => T): T;
  createJob(input: { job: Job; plan: TilePlan; mode: JobMode }): JobRecord;
  getJob(id: string): JobRecord | null;
  /** Newest first. */
  listJobs(filter?: { states?: readonly JobState[]; limit?: number }): JobRecord[];
  /** Sets the state, clearing the pause reason, resume time and error unless given, and logs the change. */
  setJobState(id: string, state: JobState, change?: JobStateChange): JobRecord;
  listTiles(jobId: string): TileRecord[];
  getTile(jobId: string, index: number): TileRecord | null;
  updateTile(jobId: string, index: number, patch: TilePatch): TileRecord;
  /** Records the start of a try and marks the tile `running`, in one step. Returns the attempt. */
  startAttempt(jobId: string, index: number): AttemptRecord;
  finishAttempt(attemptId: number, result: AttemptResult): AttemptRecord;
  listAttempts(jobId: string, index?: number): AttemptRecord[];
  addEvent(jobId: string, level: EventLevel, message: string, data?: unknown): EventRecord;
  /** Oldest first; `afterId` continues from a previous read. */
  listEvents(jobId: string, options?: { afterId?: number; limit?: number }): EventRecord[];
  /** Deletes a job with its tiles, attempts and events. */
  deleteJob(id: string): void;
  close(): void;
}

const asString = (v: unknown): string => String(v);
const asNullableString = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const asNullableNumber = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toJobRecord(row: Row): JobRecord {
  const confidence = asNullableNumber(row.category_confidence);
  const job: Job = {
    id: asString(row.id),
    createdAt: asString(row.created_at),
    source: {
      path: asString(row.source_path),
      width: Number(row.source_width),
      height: Number(row.source_height),
      sha256: asString(row.source_sha256),
    },
    prompt: asString(row.prompt),
    promptSource: row.prompt_source as Job['promptSource'],
    categoryId: asString(row.category_id),
    categorySource: row.category_source as Job['categorySource'],
    ...(confidence !== null ? { categoryConfidence: confidence } : {}),
    grid: {
      rows: Number(row.grid_rows),
      cols: Number(row.grid_cols),
      overlapPct: Number(row.overlap_pct),
      ...(Number(row.wrap) === 1 ? { wrap: true } : {}),
    },
    providerId: row.provider_id as ProviderId,
  };
  return {
    job,
    mode: row.mode as JobMode,
    plan: JSON.parse(asString(row.plan_json)) as TilePlan,
    state: row.state as JobState,
    pauseReason: (row.pause_reason as PauseReason | null) ?? null,
    resumeAfter: asNullableString(row.resume_after),
    error: asNullableString(row.error),
    updatedAt: asString(row.updated_at),
  };
}

const toTileRecord = (row: Row): TileRecord => ({
  jobId: asString(row.job_id),
  index: Number(row.idx),
  state: row.state as TileState,
  attempts: Number(row.attempts),
  outputPath: asNullableString(row.output_path),
  promptOverride: asNullableString(row.prompt_override),
  note: asNullableString(row.note),
  updatedAt: asString(row.updated_at),
});

const toAttemptRecord = (row: Row): AttemptRecord => ({
  id: Number(row.id),
  jobId: asString(row.job_id),
  tileIndex: Number(row.tile_idx),
  n: Number(row.n),
  startedAt: asString(row.started_at),
  finishedAt: asNullableString(row.finished_at),
  outcome: (row.outcome as AttemptOutcome | null) ?? null,
  errorKind: asNullableString(row.error_kind),
  message: asNullableString(row.message),
  outputPath: asNullableString(row.output_path),
  elapsedMs: asNullableNumber(row.elapsed_ms),
});

const toEventRecord = (row: Row): EventRecord => ({
  id: Number(row.id),
  jobId: asString(row.job_id),
  at: asString(row.at),
  level: row.level as EventLevel,
  message: asString(row.message),
  data: row.data_json === null || row.data_json === undefined ? undefined : JSON.parse(asString(row.data_json)),
});

/** Brings the database up to the latest schema, once, inside a transaction. */
function migrate(db: DatabaseSync): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as Row).user_version);
  const latest = MIGRATIONS[MIGRATIONS.length - 1]!.version;
  if (current > latest) {
    throw new StoreError('newer-schema', `This database is from a newer version of the app (schema ${current}; this one understands ${latest}).`);
  }
  for (const migration of MIGRATIONS.filter((m) => m.version > current)) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

/**
 * Opens (creating if needed) the job database at `path`. Write-ahead logging keeps readers from blocking the writer and
 * survives a crash mid-write; `synchronous = FULL` makes a committed change durable before the call returns, so
 * progress is never held only in memory. Pass `:memory:` for tests.
 */
export function openStore(path: string, options: StoreOptions = {}): Store {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const now = options.now ?? (() => new Date());
  const stamp = (): string => now().toISOString();

  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS))}`);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
  } catch (error) {
    db.close(); // never leave the file open (and locked on Windows) after a failed open
    throw error;
  }

  const get = (sql: string, ...params: SQLInputValue[]): Row | undefined => db.prepare(sql).get(...params) as Row | undefined;
  const all = (sql: string, ...params: SQLInputValue[]): Row[] => db.prepare(sql).all(...params) as Row[];
  const run = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params);

  let depth = 0;
  function transaction<T>(fn: () => T): T {
    if (depth > 0) return fn();
    db.exec('BEGIN IMMEDIATE');
    depth = 1;
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      depth = 0;
    }
  }

  const requireJob = (id: string): JobRecord => {
    const row = get('SELECT * FROM jobs WHERE id = ?', id);
    if (!row) throw new StoreError('not-found', `No job "${id}".`);
    return toJobRecord(row);
  };
  const requireTile = (jobId: string, index: number): TileRecord => {
    const row = get('SELECT * FROM tiles WHERE job_id = ? AND idx = ?', jobId, index);
    if (!row) throw new StoreError('not-found', `No tile ${index} in job "${jobId}".`);
    return toTileRecord(row);
  };
  const requireAttempt = (id: number): AttemptRecord => {
    const row = get('SELECT * FROM attempts WHERE id = ?', id);
    if (!row) throw new StoreError('not-found', `No attempt ${id}.`);
    return toAttemptRecord(row);
  };

  function addEvent(jobId: string, level: EventLevel, message: string, data?: unknown): EventRecord {
    const result = run('INSERT INTO events (job_id, at, level, message, data_json) VALUES (?, ?, ?, ?, ?)', jobId, stamp(), level, message, data === undefined ? null : JSON.stringify(data));
    return toEventRecord(get('SELECT * FROM events WHERE id = ?', Number(result.lastInsertRowid))!);
  }

  return {
    path,
    transaction,

    createJob({ job, plan, mode }) {
      return transaction(() => {
        if (get('SELECT 1 AS found FROM jobs WHERE id = ?', job.id)) throw new StoreError('exists', `Job "${job.id}" already exists.`);
        if (plan.tiles.length === 0) throw new StoreError('invalid', 'A job needs at least one tile.');
        const at = stamp();
        run(
          `INSERT INTO jobs (id, created_at, updated_at, state, mode, provider_id, category_id, category_source, category_confidence,
             prompt, prompt_source, source_path, source_width, source_height, source_sha256, grid_rows, grid_cols, overlap_pct, wrap, plan_json)
           VALUES (?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          job.id, job.createdAt, at, mode, job.providerId, job.categoryId, job.categorySource, job.categoryConfidence ?? null,
          job.prompt, job.promptSource, job.source.path, job.source.width, job.source.height, job.source.sha256,
          job.grid.rows, job.grid.cols, job.grid.overlapPct, job.grid.wrap ? 1 : 0, JSON.stringify(plan),
        );
        for (const tile of plan.tiles) run("INSERT INTO tiles (job_id, idx, state, updated_at) VALUES (?, ?, 'pending', ?)", job.id, tile.index, at);
        addEvent(job.id, 'info', `Job created with ${plan.tiles.length} tiles (${mode}).`);
        return requireJob(job.id);
      });
    },

    getJob: (id) => {
      const row = get('SELECT * FROM jobs WHERE id = ?', id);
      return row ? toJobRecord(row) : null;
    },

    listJobs({ states, limit } = {}) {
      const where = states && states.length > 0 ? `WHERE state IN (${states.map(() => '?').join(',')})` : '';
      const rows = all(`SELECT * FROM jobs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`, ...(states ?? []), limit ?? -1);
      return rows.map(toJobRecord);
    },

    setJobState(id, state, change = {}) {
      return transaction(() => {
        const before = requireJob(id);
        run('UPDATE jobs SET state = ?, pause_reason = ?, resume_after = ?, error = ?, updated_at = ? WHERE id = ?', state, change.pauseReason ?? null, change.resumeAfter ?? null, change.error ?? null, stamp(), id);
        const detail = change.pauseReason ? ` (${change.pauseReason})` : '';
        addEvent(id, state === 'failed' ? 'error' : 'info', `Job ${before.state} → ${state}${detail}`, change.error ? { error: change.error } : undefined);
        return requireJob(id);
      });
    },

    listTiles: (jobId) => all('SELECT * FROM tiles WHERE job_id = ? ORDER BY idx', jobId).map(toTileRecord),

    getTile: (jobId, index) => {
      const row = get('SELECT * FROM tiles WHERE job_id = ? AND idx = ?', jobId, index);
      return row ? toTileRecord(row) : null;
    },

    updateTile(jobId, index, patch) {
      return transaction(() => {
        const before = requireTile(jobId, index);
        const next = {
          state: patch.state ?? before.state,
          outputPath: patch.outputPath === undefined ? before.outputPath : patch.outputPath,
          promptOverride: patch.promptOverride === undefined ? before.promptOverride : patch.promptOverride,
          note: patch.note === undefined ? before.note : patch.note,
        };
        run('UPDATE tiles SET state = ?, output_path = ?, prompt_override = ?, note = ?, updated_at = ? WHERE job_id = ? AND idx = ?', next.state, next.outputPath, next.promptOverride, next.note, stamp(), jobId, index);
        if (next.state !== before.state) addEvent(jobId, 'info', `Tile ${index + 1}: ${before.state} → ${next.state}`);
        return requireTile(jobId, index);
      });
    },

    startAttempt(jobId, index) {
      return transaction(() => {
        const tile = requireTile(jobId, index);
        const n = tile.attempts + 1;
        const result = run('INSERT INTO attempts (job_id, tile_idx, n, started_at) VALUES (?, ?, ?, ?)', jobId, index, n, stamp());
        run("UPDATE tiles SET attempts = ?, state = 'running', updated_at = ? WHERE job_id = ? AND idx = ?", n, stamp(), jobId, index);
        if (tile.state !== 'running') addEvent(jobId, 'info', `Tile ${index + 1}: ${tile.state} → running (attempt ${n})`);
        return requireAttempt(Number(result.lastInsertRowid));
      });
    },

    finishAttempt(attemptId, result) {
      return transaction(() => {
        requireAttempt(attemptId);
        run('UPDATE attempts SET finished_at = ?, outcome = ?, error_kind = ?, message = ?, output_path = ?, elapsed_ms = ? WHERE id = ?', stamp(), result.outcome, result.errorKind ?? null, result.message ?? null, result.outputPath ?? null, result.elapsedMs ?? null, attemptId);
        return requireAttempt(attemptId);
      });
    },

    listAttempts: (jobId, index) =>
      (index === undefined
        ? all('SELECT * FROM attempts WHERE job_id = ? ORDER BY tile_idx, n', jobId)
        : all('SELECT * FROM attempts WHERE job_id = ? AND tile_idx = ? ORDER BY n', jobId, index)
      ).map(toAttemptRecord),

    addEvent: (jobId, level, message, data) => transaction(() => addEvent(jobId, level, message, data)),

    listEvents: (jobId, { afterId, limit } = {}) => all('SELECT * FROM events WHERE job_id = ? AND id > ? ORDER BY id LIMIT ?', jobId, afterId ?? 0, limit ?? -1).map(toEventRecord),

    deleteJob(id) {
      transaction(() => {
        requireJob(id);
        run('DELETE FROM jobs WHERE id = ?', id);
      });
    },

    close() {
      db.close();
    },
  };
}
