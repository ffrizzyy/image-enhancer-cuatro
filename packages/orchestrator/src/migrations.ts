/**
 * Schema migrations, applied in order. The database's `user_version` is the number of the last one applied, so a
 * migration runs exactly once. Add a new entry at the end for every schema change; never edit an old one.
 * (They live in code rather than `.sql` files so the bundled app needs no extra files.)
 */
export interface Migration {
  version: number;
  sql: string;
}

const JOB_STATES = "'idle','preflight','running','paused','needs-review','stitching','done','failed','cancelled'";
const TILE_STATES = "'pending','running','accepted','retrying','needs-review','failed'";
const PAUSE_REASONS = "'challenge','logged-out','quota','user'";

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (${JOB_STATES})),
  pause_reason TEXT CHECK (pause_reason IS NULL OR pause_reason IN (${PAUSE_REASONS})),
  resume_after TEXT,
  error TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('chained','independent')),
  provider_id TEXT NOT NULL CHECK (provider_id IN ('gpt','gemini','grok')),
  category_id TEXT NOT NULL,
  category_source TEXT NOT NULL CHECK (category_source IN ('user','auto')),
  category_confidence REAL,
  prompt TEXT NOT NULL,
  prompt_source TEXT NOT NULL CHECK (prompt_source IN ('user','category-default')),
  source_path TEXT NOT NULL,
  source_width INTEGER NOT NULL CHECK (source_width > 0),
  source_height INTEGER NOT NULL CHECK (source_height > 0),
  source_sha256 TEXT NOT NULL,
  grid_rows INTEGER NOT NULL CHECK (grid_rows BETWEEN 1 AND 6),
  grid_cols INTEGER NOT NULL CHECK (grid_cols BETWEEN 1 AND 6),
  overlap_pct REAL NOT NULL CHECK (overlap_pct BETWEEN 0 AND 40),
  wrap INTEGER NOT NULL DEFAULT 0 CHECK (wrap IN (0,1)),
  plan_json TEXT NOT NULL
);
CREATE INDEX jobs_state ON jobs (state);
CREATE INDEX jobs_created ON jobs (created_at DESC);

CREATE TABLE tiles (
  job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  idx INTEGER NOT NULL CHECK (idx >= 0),
  state TEXT NOT NULL CHECK (state IN (${TILE_STATES})),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  output_path TEXT,
  prompt_override TEXT,
  note TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, idx)
) WITHOUT ROWID;

CREATE TABLE attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  tile_idx INTEGER NOT NULL,
  n INTEGER NOT NULL CHECK (n >= 1),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('ok','error','rejected','interrupted')),
  error_kind TEXT,
  message TEXT,
  output_path TEXT,
  elapsed_ms INTEGER,
  FOREIGN KEY (job_id, tile_idx) REFERENCES tiles (job_id, idx) ON DELETE CASCADE,
  UNIQUE (job_id, tile_idx, n)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  message TEXT NOT NULL,
  data_json TEXT
);
CREATE INDEX events_job ON events (job_id, id);
`,
  },
  {
    version: 2,
    // A manual re-run gives a tile a fresh set of automatic retries: tries are counted from this attempt number.
    sql: `ALTER TABLE tiles ADD COLUMN attempt_base INTEGER NOT NULL DEFAULT 0 CHECK (attempt_base >= 0);`,
  },
  {
    version: 3,
    // A tile can use its own picture, and a finished job keeps the stitched picture and its metrics for the Result screen.
    sql: `
ALTER TABLE tiles ADD COLUMN source_override TEXT;
ALTER TABLE jobs ADD COLUMN stitched_path TEXT;
ALTER TABLE jobs ADD COLUMN seam_score REAL;
ALTER TABLE jobs ADD COLUMN max_delta_e REAL;
ALTER TABLE jobs ADD COLUMN flagged_json TEXT;
ALTER TABLE jobs ADD COLUMN stitched_at TEXT;
`,
  },
];
