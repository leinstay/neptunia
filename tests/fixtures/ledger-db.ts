// A `ledger.db` as the task ledger service wrote it, for the tests of tools/board-import.mjs. The schema is the ledger's
// own at its latest version, 3: its three migrations as the service shipped them, each recorded in `schema_version`.
// The rows are one small history: a finished dev task with everything a task can collect (two reviews, a question and
// its answer, three results, a comment, an ended attempt, its events and a delivered outbox row), an approved dev task
// that depends on it, a dev task held by the worker, an errand-lane mirror of one of her errands with its own rows, and
// one turn of the thinker. Every id is the ledger's. Synthetic data only.
import { DatabaseSync } from 'node:sqlite';

/** The ledger's schema v1 to v3 (the service's src/db.js), verbatim but for the indentation. */
const LEDGER_MIGRATIONS: ReadonlyArray<string> = [
  `
CREATE TABLE tasks (
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
CREATE INDEX tasks_status ON tasks(status);
CREATE INDEX tasks_lease ON tasks(lease_expires_at) WHERE lease_owner IS NOT NULL;
CREATE TABLE dependencies (
  task_id TEXT NOT NULL, depends_on_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('blocks','parent-child','discovered-from','related')),
  created_by TEXT, created_at TEXT,
  PRIMARY KEY (task_id, depends_on_id)
);
CREATE INDEX dependencies_on ON dependencies(depends_on_id);
CREATE TABLE attempts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, n INTEGER, principal TEXT, role TEXT, model TEXT, provider_pin TEXT,
  worktree TEXT, branch TEXT, db_path TEXT, started_at TEXT, ended_at TEXT, exit_code INTEGER, finish_reason TEXT,
  steps INTEGER, tokens_in INTEGER, tokens_out INTEGER, tokens_reasoning INTEGER, cache_read INTEGER, cache_write INTEGER,
  cost_est_usd REAL, cost_billed_usd REAL, rejected_asks INTEGER, failed_tools INTEGER,
  loop_signals TEXT, stall_signals TEXT,
  outcome TEXT CHECK (outcome IN ('done','failed','stopped','stalled','over-budget','needs_answer'))
);
CREATE INDEX attempts_task ON attempts(task_id);
CREATE TABLE questions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_id TEXT, asked_by TEXT, text TEXT, to_whom TEXT NOT NULL,
  answer TEXT, answered_by TEXT, answered_at TEXT, created_at TEXT
);
CREATE INDEX questions_task ON questions(task_id);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, principal TEXT,
  decision TEXT CHECK (decision IN ('approve','reject')),
  scope TEXT CHECK (scope IN ('plan','merge','deploy')),
  note TEXT, created_at TEXT
);
CREATE TABLE results (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_id TEXT,
  kind TEXT CHECK (kind IN ('summary','diff','pr','answer','file')),
  body TEXT, uri TEXT, created_at TEXT
);
CREATE TABLE comments (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT, text TEXT, created_at TEXT);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, actor TEXT, type TEXT, old TEXT, new TEXT, created_at TEXT
);
CREATE INDEX events_task ON events(task_id, seq);
CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, to_whom TEXT, kind TEXT, payload TEXT,
  created_at TEXT, delivered_at TEXT
);
CREATE INDEX outbox_pending ON outbox(to_whom) WHERE delivered_at IS NULL;
CREATE TABLE idempotency (key TEXT PRIMARY KEY, principal TEXT, response TEXT, created_at TEXT);
`,
  `
CREATE TABLE results_new (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_id TEXT,
  kind TEXT CHECK (kind IN ('summary','diff','pr','answer','file','prompt','spec')),
  body TEXT, uri TEXT, created_at TEXT
);
INSERT INTO results_new (id, task_id, attempt_id, kind, body, uri, created_at)
  SELECT id, task_id, attempt_id, kind, body, uri, created_at FROM results;
DROP TABLE results;
ALTER TABLE results_new RENAME TO results;
`,
  `
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT, wave INTEGER, started_at TEXT NOT NULL, ended_at TEXT,
  trigger_seqs TEXT, steps INTEGER, tokens_in INTEGER, tokens_out INTEGER, cache_read INTEGER, cache_write INTEGER,
  cost_est_usd REAL, context_mean INTEGER, context_peak INTEGER, compactions INTEGER, outcome TEXT
);
CREATE INDEX agent_runs_agent ON agent_runs(agent, started_at);
`,
];

/** The latest version of the ledger's schema. */
export const LEDGER_VERSION = LEDGER_MIGRATIONS.length;

/** The finished dev task, the approved one that depends on it, the held one, and the errand-lane mirror. */
export const DONE_TASK = 'T-aaaaaa';
export const OPEN_TASK = 'T-bbbbbb';
export const HELD_TASK = 'T-cccccc';
export const ERRAND_MIRROR = 'T-eeeeee';
export const DEV_TASKS: ReadonlyArray<string> = [DONE_TASK, OPEN_TASK, HELD_TASK];

const at = (day: number, hour: number, minute = 0): string =>
  new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString();

type Values = Record<string, string | number | null>;

const TASKS: ReadonlyArray<Values> = [
  {
    id: DONE_TASK,
    lane: 'dev',
    project: 'core',
    title: 'Read the zeta tag',
    description: 'The parser drops the zeta tag.',
    acceptance: 'The parser tests pass.',
    requester: 'lead',
    priority: 1,
    risk: 'low',
    role: 'dev',
    budget_usd: 4,
    step_cap: 80,
    estimate_minutes: 30,
    status: 'done',
    close_reason: null,
    defer_until: null,
    is_blocked: 0,
    revision: 7,
    lease_owner: null,
    lease_expires_at: null,
    heartbeat_at: null,
    subscriber: 'lead',
    created_at: at(20, 9),
    updated_at: at(20, 12),
    metadata: '{"pr":12}',
  },
  {
    id: OPEN_TASK,
    lane: 'dev',
    project: 'core',
    title: 'Count the zeta tags',
    description: null,
    acceptance: null,
    requester: 'thinker',
    priority: 2,
    risk: 'normal',
    role: 'dev',
    budget_usd: 2,
    step_cap: 40,
    estimate_minutes: 20,
    status: 'approved',
    close_reason: null,
    defer_until: null,
    is_blocked: 0,
    revision: 3,
    lease_owner: null,
    lease_expires_at: null,
    heartbeat_at: null,
    subscriber: null,
    created_at: at(21, 9),
    updated_at: at(21, 9, 5),
    metadata: null,
  },
  {
    id: HELD_TASK,
    lane: 'dev',
    project: 'core',
    title: 'Log the zeta tags',
    description: null,
    acceptance: null,
    requester: 'lead',
    priority: 3,
    risk: 'low',
    role: 'dev',
    budget_usd: 1.5,
    step_cap: 30,
    estimate_minutes: 15,
    status: 'in_progress',
    close_reason: null,
    defer_until: null,
    is_blocked: 0,
    revision: 4,
    lease_owner: 'dispatcher',
    lease_expires_at: at(22, 10, 45),
    heartbeat_at: at(22, 10),
    subscriber: null,
    created_at: at(22, 9),
    updated_at: at(22, 10),
    metadata: null,
  },
  {
    id: ERRAND_MIRROR,
    lane: 'errand',
    project: null,
    title: 'find the opening hours of the library',
    description: null,
    acceptance: null,
    requester: 'core',
    priority: 2,
    risk: 'normal',
    role: 'scout',
    budget_usd: null,
    step_cap: null,
    estimate_minutes: null,
    status: 'done',
    close_reason: null,
    defer_until: null,
    is_blocked: 0,
    revision: 3,
    lease_owner: null,
    lease_expires_at: null,
    heartbeat_at: null,
    subscriber: 'persona:g1',
    created_at: at(20, 10),
    updated_at: at(20, 10, 5),
    metadata: '{"coreId":"t0000e001"}',
  },
];

const DEPENDENCIES: ReadonlyArray<Values> = [
  { task_id: OPEN_TASK, depends_on_id: DONE_TASK, type: 'blocks', created_by: 'thinker', created_at: at(21, 9) },
  { task_id: HELD_TASK, depends_on_id: DONE_TASK, type: 'discovered-from', created_by: 'lead', created_at: at(22, 9) },
];

const ATTEMPTS: ReadonlyArray<Values> = [
  {
    id: 'A-aaaaaa',
    task_id: DONE_TASK,
    n: 1,
    principal: 'dispatcher',
    role: 'dev',
    model: 'model-a',
    started_at: at(20, 10),
    ended_at: at(20, 11),
    exit_code: 0,
    steps: 42,
    tokens_in: 50000,
    tokens_out: 3000,
    tokens_reasoning: 1000,
    cost_est_usd: 0.4,
    outcome: 'done',
  },
  {
    id: 'A-cccccc',
    task_id: HELD_TASK,
    n: 1,
    principal: 'dispatcher',
    role: 'dev',
    model: 'model-a',
    started_at: at(22, 10),
  },
  {
    id: 'A-eeeeee',
    task_id: ERRAND_MIRROR,
    n: 1,
    principal: 'core',
    role: 'scout',
    started_at: at(20, 10, 1),
    ended_at: at(20, 10, 4),
    cost_est_usd: 0.25,
    outcome: 'done',
  },
];

const QUESTIONS: ReadonlyArray<Values> = [
  {
    id: 'Q-aaaaaa',
    task_id: DONE_TASK,
    attempt_id: 'A-aaaaaa',
    asked_by: 'dispatcher',
    text: 'Which file holds the tag list?',
    to_whom: 'thinker',
    answer: 'src/parser.ts',
    answered_by: 'thinker',
    answered_at: at(20, 10, 30),
    created_at: at(20, 10, 20),
  },
];

const APPROVALS: ReadonlyArray<Values> = [
  { id: 'P-aaaaa1', task_id: DONE_TASK, principal: 'lead', decision: 'approve', scope: 'plan', note: null, created_at: at(20, 9, 30) },
  { id: 'P-aaaaa2', task_id: DONE_TASK, principal: 'lead', decision: 'approve', scope: 'merge', note: 'CI green', created_at: at(20, 12) },
];

const RESULTS: ReadonlyArray<Values> = [
  { id: 'R-aaaaa1', task_id: DONE_TASK, attempt_id: 'A-aaaaaa', kind: 'prompt', body: 'the prompt as sent', uri: null, created_at: at(20, 10) },
  { id: 'R-aaaaa2', task_id: DONE_TASK, attempt_id: 'A-aaaaaa', kind: 'pr', body: null, uri: 'https://example.org/pr/12', created_at: at(20, 11) },
  { id: 'R-aaaaa3', task_id: DONE_TASK, attempt_id: 'A-aaaaaa', kind: 'summary', body: 'The parser reads the tag.', uri: null, created_at: at(20, 11) },
  { id: 'R-eeeeee', task_id: ERRAND_MIRROR, attempt_id: 'A-eeeeee', kind: 'summary', body: 'nine to five', uri: null, created_at: at(20, 10, 4) },
];

const COMMENTS: ReadonlyArray<Values> = [
  { id: 'C-aaaaaa', task_id: DONE_TASK, author: 'thinker', text: 'Keep the old tag readable.', created_at: at(20, 9, 40) },
];

/** The events in the order the ledger wrote them; the errand mirror's are interleaved with the dev tasks'. */
const EVENTS: ReadonlyArray<Values> = [
  { task_id: DONE_TASK, actor: 'lead', type: 'task.created', old: null, new: '{"title":"Read the zeta tag"}', created_at: at(20, 9) },
  { task_id: DONE_TASK, actor: 'lead', type: 'status', old: null, new: 'proposed', created_at: at(20, 9) },
  { task_id: DONE_TASK, actor: 'lead', type: 'status', old: 'proposed', new: 'approved', created_at: at(20, 9, 30) },
  { task_id: ERRAND_MIRROR, actor: 'core', type: 'task.created', old: null, new: null, created_at: at(20, 10) },
  { task_id: DONE_TASK, actor: 'dispatcher', type: 'lease.claimed', old: null, new: '{"owner":"dispatcher"}', created_at: at(20, 10) },
  { task_id: ERRAND_MIRROR, actor: 'core', type: 'status', old: 'in_progress', new: 'done', created_at: at(20, 10, 4) },
  { task_id: DONE_TASK, actor: 'dispatcher', type: 'status', old: 'in_progress', new: 'needs_validation', created_at: at(20, 11) },
  { task_id: DONE_TASK, actor: 'lead', type: 'status', old: 'needs_validation', new: 'done', created_at: at(20, 12) },
  { task_id: OPEN_TASK, actor: 'thinker', type: 'task.created', old: null, new: '{"title":"Count the zeta tags"}', created_at: at(21, 9) },
  { task_id: OPEN_TASK, actor: 'thinker', type: 'status', old: 'triaged', new: 'approved', created_at: at(21, 9, 5) },
  { task_id: HELD_TASK, actor: 'lead', type: 'task.created', old: null, new: '{"title":"Log the zeta tags"}', created_at: at(22, 9) },
  { task_id: HELD_TASK, actor: 'dispatcher', type: 'lease.claimed', old: null, new: '{"owner":"dispatcher"}', created_at: at(22, 10) },
];

const OUTBOX: ReadonlyArray<Values> = [
  { task_id: DONE_TASK, to_whom: 'lead', kind: 'status', payload: '{"status":"done"}', created_at: at(20, 12), delivered_at: at(20, 12, 1) },
  { task_id: ERRAND_MIRROR, to_whom: 'persona:g1', kind: 'status', payload: '{"status":"done"}', created_at: at(20, 10, 4), delivered_at: null },
];

const AGENT_RUNS: ReadonlyArray<Values> = [
  {
    id: 'W-aaaaaa',
    agent: 'thinker',
    session_id: 'session-1',
    wave: 3,
    started_at: at(20, 9, 10),
    ended_at: at(20, 9, 20),
    trigger_seqs: '[1,2]',
    steps: 12,
    tokens_in: 90000,
    tokens_out: 2000,
    cost_est_usd: 0.9,
    context_mean: 60000,
    context_peak: 80000,
    outcome: 'done',
  },
];

/** The ledger's rows of each table, keyed by its table name in ledger.db. */
export const LEDGER_ROWS: Readonly<Record<string, ReadonlyArray<Values>>> = {
  tasks: TASKS,
  dependencies: DEPENDENCIES,
  attempts: ATTEMPTS,
  questions: QUESTIONS,
  approvals: APPROVALS,
  results: RESULTS,
  comments: COMMENTS,
  events: EVENTS,
  outbox: OUTBOX,
  agent_runs: AGENT_RUNS,
};

function insert(db: DatabaseSync, table: string, row: Values): void {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
    ...columns.map((column) => row[column] ?? null)
  );
}

/**
 * Writes the ledger history above to a new `ledger.db` at `file`, at the ledger's latest schema version. `version`
 * records another version in `schema_version` over the same tables, for a file the import must refuse.
 */
export function writeLedgerDb(file: string, { version = LEDGER_VERSION }: { version?: number } = {}): void {
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    for (const [index, sql] of LEDGER_MIGRATIONS.entries()) {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(index + 1);
    }
    for (let extra = LEDGER_VERSION + 1; extra <= version; extra += 1) {
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(extra);
    }
    for (const [table, rows] of Object.entries(LEDGER_ROWS)) for (const row of rows) insert(db, table, row);
    // The service purged keys past 24 hours; one fresh key stays, which the board never takes over.
    insert(db, 'idempotency', { key: 'lead:k1', principal: 'lead', response: 'null', created_at: at(22, 10) });
  } finally {
    db.close();
  }
}

/** Every row of `table` in `file` whose `task_id` is one of `tasks`, in rowid order. */
export function ledgerRows(file: string, table: string, tasks: ReadonlyArray<string>): Array<Record<string, unknown>> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const marks = tasks.map(() => '?').join(', ');
    return db
      .prepare(`SELECT * FROM ${table} WHERE task_id IN (${marks}) ORDER BY rowid`)
      .all(...tasks)
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}
