// The task board's tables in the memory database and their migrations. The board keeps its own version table,
// `board_schema_version`, beside the memory's `schema_version`, and src/memory/db/open.js runs `migrateBoard` after
// the memory migrations in a transaction of its own, so a failing board migration leaves her memory open and the
// board down. The tables are internal-only: no graph projection, recall, export or sync reads them.

// The connection the board needs: node:sqlite's DatabaseSync has every method named here.
export type BoardDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: Array<unknown>): Record<string, unknown> | undefined;
    all(...params: Array<unknown>): Array<Record<string, unknown>>;
    run(...params: Array<unknown>): { changes: number | bigint };
  };
};

// Board v1: the tables of the task ledger's schema v3, each renamed board_*, its approvals as board_reviews.
const V1 = `
CREATE TABLE board_tasks (
  id TEXT PRIMARY KEY,
  lane TEXT CHECK (lane IN ('dev','errand')),
  project TEXT,
  title TEXT NOT NULL, description TEXT, acceptance TEXT,
  requester TEXT NOT NULL,
  priority INTEGER CHECK (priority BETWEEN 0 AND 4) DEFAULT 2,
  risk TEXT CHECK (risk IN ('low','normal','high')) DEFAULT 'normal',
  role TEXT,
  budget_usd REAL, step_cap INTEGER, estimate_minutes INTEGER,
  status TEXT NOT NULL CHECK (status IN ('proposed','triaged','approved','rejected','in_progress','needs_answer','needs_validation','done','failed','cancelled')),
  close_reason TEXT, defer_until TEXT,
  is_blocked INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  lease_owner TEXT, lease_expires_at TEXT, heartbeat_at TEXT,
  subscriber TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  metadata TEXT
);
CREATE INDEX board_tasks_status ON board_tasks(status);
CREATE INDEX board_tasks_lease ON board_tasks(lease_expires_at) WHERE lease_owner IS NOT NULL;
CREATE TABLE board_dependencies (
  task_id TEXT NOT NULL, depends_on_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('blocks','parent-child','discovered-from','related')),
  created_by TEXT, created_at TEXT,
  PRIMARY KEY (task_id, depends_on_id)
);
CREATE INDEX board_dependencies_on ON board_dependencies(depends_on_id);
CREATE TABLE board_attempts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, n INTEGER, principal TEXT, role TEXT, model TEXT, provider_pin TEXT,
  worktree TEXT, branch TEXT, db_path TEXT, started_at TEXT, ended_at TEXT, exit_code INTEGER, finish_reason TEXT,
  steps INTEGER, tokens_in INTEGER, tokens_out INTEGER, tokens_reasoning INTEGER, cache_read INTEGER, cache_write INTEGER,
  cost_est_usd REAL, cost_billed_usd REAL, rejected_asks INTEGER, failed_tools INTEGER,
  loop_signals TEXT, stall_signals TEXT,
  outcome TEXT CHECK (outcome IN ('done','failed','stopped','stalled','over-budget','needs_answer'))
);
CREATE INDEX board_attempts_task ON board_attempts(task_id);
CREATE TABLE board_questions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_id TEXT, asked_by TEXT, text TEXT, to_whom TEXT NOT NULL,
  answer TEXT, answered_by TEXT, answered_at TEXT, created_at TEXT
);
CREATE INDEX board_questions_task ON board_questions(task_id);
CREATE TABLE board_reviews (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, principal TEXT,
  decision TEXT CHECK (decision IN ('approve','reject')),
  scope TEXT CHECK (scope IN ('plan','merge','deploy')),
  note TEXT, created_at TEXT
);
CREATE TABLE board_results (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_id TEXT,
  kind TEXT CHECK (kind IN ('summary','diff','pr','answer','file','prompt','spec')),
  body TEXT, uri TEXT, created_at TEXT
);
CREATE TABLE board_comments (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT, text TEXT, created_at TEXT);
CREATE TABLE board_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, actor TEXT, type TEXT, old TEXT, new TEXT, created_at TEXT
);
CREATE INDEX board_events_task ON board_events(task_id, seq);
CREATE TABLE board_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, to_whom TEXT, kind TEXT, payload TEXT,
  created_at TEXT, delivered_at TEXT
);
CREATE INDEX board_outbox_pending ON board_outbox(to_whom) WHERE delivered_at IS NULL;
CREATE TABLE board_idempotency (key TEXT PRIMARY KEY, principal TEXT, response TEXT, created_at TEXT);
CREATE TABLE board_agent_runs (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT, wave INTEGER, started_at TEXT NOT NULL, ended_at TEXT,
  trigger_seqs TEXT, steps INTEGER, tokens_in INTEGER, tokens_out INTEGER, cache_read INTEGER, cache_write INTEGER,
  cost_est_usd REAL, context_mean INTEGER, context_peak INTEGER, compactions INTEGER, outcome TEXT
);
CREATE INDEX board_agent_runs_agent ON board_agent_runs(agent, started_at);
`;

/** Each entry moves the board one version up. Never edit a shipped entry: append a new one. */
export const BOARD_MIGRATIONS: ReadonlyArray<string> = [V1];

/** The tables board v1 creates, in this order. */
export const BOARD_TABLES: ReadonlyArray<string> = [
  'board_tasks',
  'board_dependencies',
  'board_attempts',
  'board_questions',
  'board_reviews',
  'board_results',
  'board_comments',
  'board_events',
  'board_outbox',
  'board_idempotency',
  'board_agent_runs',
];

/** MAX(version) of `board_schema_version`; 0 when the table does not exist. */
export function boardVersion(db: BoardDb): number {
  const table = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'board_schema_version'")
    .get();
  if (table === undefined) return 0;
  return Number(db.prepare('SELECT MAX(version) AS v FROM board_schema_version').get()?.v ?? 0);
}

export type BoardStatus = { ok: true; version: number } | { ok: false; version: number; error: string };

/**
 * Applies every board migration above `boardVersion(db)` in one BEGIN IMMEDIATE transaction. Never throws: a failing
 * step rolls the whole run back and answers `ok: false` with the version the board stays at.
 */
export function migrateBoard(db: BoardDb, migrations: ReadonlyArray<string> = BOARD_MIGRATIONS): BoardStatus {
  const current = boardVersion(db);
  if (current >= migrations.length) return { ok: true, version: current };
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (error) {
    return { ok: false, version: boardVersion(db), error: error instanceof Error ? error.message : String(error) };
  }
  try {
    db.exec('CREATE TABLE IF NOT EXISTS board_schema_version (version INTEGER NOT NULL)');
    let version = boardVersion(db);
    while (version < migrations.length) {
      db.exec(migrations[version] ?? '');
      version += 1;
      db.prepare('INSERT INTO board_schema_version (version) VALUES (?)').run(version);
    }
    db.exec('COMMIT');
    return { ok: true, version };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // A failed statement may have rolled the transaction back already.
    }
    return { ok: false, version: boardVersion(db), error: error instanceof Error ? error.message : String(error) };
  }
}
