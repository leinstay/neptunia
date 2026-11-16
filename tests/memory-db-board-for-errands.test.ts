// Schema step 60 (src/memory/db/schema.ts) on a database written at version 59: the board keeps its errands and
// their events, outbox rows and handoffs, loses every task of another lane with its rows and the seven tables only
// development used, and takes the narrow shape of board_tasks and board_results; the selfimprovement wakes still
// waiting go. Each test builds a version 59 file with the steps above the baseline up to 59, fills it with raw SQL
// the way production holds it, and opens it with the current code. Temporary files, synthetic rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, openMemoryDb } from '../src/memory/db/open.ts';
import { BASELINE_VERSION } from '../src/memory/db/schema-baseline.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import { filledRows, schemaShape } from './fixtures/memory-db/schema-shape.ts';
import { tempDir } from './fixtures/tmp.ts';

const DROPPED = [
  'board_agent_runs',
  'board_attempts',
  'board_comments',
  'board_dependencies',
  'board_idempotency',
  'board_questions',
  'board_reviews',
];

const TASK_COLUMNS = ['id', 'title', 'role', 'status', 'close_reason', 'created_at', 'updated_at', 'metadata'];
const RESULT_COLUMNS = ['id', 'task_id', 'kind', 'body', 'created_at'];

// Three errands filed in an order their ids do not sort in, so a rebuild that loses the filing order shows.
const ERRANDS = `
INSERT INTO board_tasks (id, lane, title, requester, role, status, close_reason, subscriber, created_at, updated_at,
  metadata) VALUES
  ('E-zz', 'errand', 'find the tide table', 'persona', 'research', 'done', NULL, 'persona',
   '2026-11-01T10:00:00.000Z', '2026-11-01T10:05:00.000Z', '{"errand":{"placeId":"synthetic:chat:1","createdAt":1}}'),
  ('E-mm', 'errand', 'fetch the ferry times', 'persona', 'research', 'failed', 'the site was down', 'persona',
   '2026-11-02T10:00:00.000Z', '2026-11-02T10:01:00.000Z', '{"errand":{"placeId":"synthetic:chat:2","createdAt":2}}'),
  ('E-aa', 'errand', 'draw the harbour', 'persona', 'artist', 'in_progress', NULL, 'persona',
   '2026-11-03T10:00:00.000Z', '2026-11-03T10:00:30.000Z', '{"errand":{"placeId":"synthetic:chat:1","createdAt":3}}'),
  ('E-qq', 'errand', 'read the notice', 'persona', 'research', 'approved', NULL, 'persona',
   '2026-11-04T10:00:00.000Z', '2026-11-04T10:00:00.000Z', '{"errand":{"placeId":"synthetic:chat:3","createdAt":4}}');
INSERT INTO board_events (task_id, actor, type, old, new, created_at) VALUES
  ('E-zz', 'core', 'status', NULL, 'approved', '2026-11-01T10:00:00.000Z'),
  ('E-zz', 'core', 'status', 'approved', 'in_progress', '2026-11-01T10:01:00.000Z'),
  ('E-zz', 'core', 'status', 'in_progress', 'done', '2026-11-01T10:05:00.000Z'),
  ('E-mm', 'core', 'status', NULL, 'approved', '2026-11-02T10:00:00.000Z'),
  ('E-mm', 'core', 'status', 'approved', 'failed', '2026-11-02T10:01:00.000Z'),
  ('E-aa', 'core', 'status', NULL, 'approved', '2026-11-03T10:00:00.000Z'),
  ('E-aa', 'core', 'status', 'approved', 'in_progress', '2026-11-03T10:00:30.000Z'),
  ('E-qq', 'core', 'status', NULL, 'approved', '2026-11-04T10:00:00.000Z');
INSERT INTO board_outbox (task_id, to_whom, kind, payload, created_at, delivered_at) VALUES
  ('E-zz', 'persona', 'done', '{"task":"E-zz","title":"find the tide table","status":"done","close_reason":null}',
   '2026-11-01T10:05:00.000Z', '2026-11-01T10:06:00.000Z'),
  ('E-mm', 'persona', 'failed',
   '{"task":"E-mm","title":"fetch the ferry times","status":"failed","close_reason":"the site was down"}',
   '2026-11-02T10:01:00.000Z', NULL);
INSERT INTO board_results (id, task_id, attempt_id, kind, body, uri, created_at) VALUES
  ('R-E-zz', 'E-zz', NULL, 'handoff', '{"result":"High water at 06:10.","evidence":[],"artifacts":[],"tests":[],"open_issues":[]}',
   NULL, '2026-11-01T10:05:00.000Z');
`;

// Development tasks with a row in every board table, a task with no lane, and an event that names no task.
const DEVELOPMENT = `
INSERT INTO board_tasks (id, lane, project, title, description, requester, role, status, subscriber, created_at,
  updated_at, lease_owner, lease_expires_at, lease_generation) VALUES
  ('T-dev1', 'dev', 'engine', 'fix the wake queue', 'a finding', 'watcher', 'dev', 'needs_validation', 'owner',
   '2026-10-01T10:00:00.000Z', '2026-10-02T10:00:00.000Z', 'dev', '2026-10-02T11:00:00.000Z', 2),
  ('T-dev2', 'dev', 'engine', 'ship the fix', NULL, 'persona', 'dev', 'done', 'persona',
   '2026-10-03T10:00:00.000Z', '2026-10-04T10:00:00.000Z', NULL, NULL, 0),
  ('T-nolane', NULL, NULL, 'filed before lanes', NULL, 'owner', NULL, 'proposed', NULL,
   '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z', NULL, NULL, 0);
INSERT INTO board_events (task_id, actor, type, old, new, created_at) VALUES
  ('T-dev1', 'watcher', 'task.created', NULL, NULL, '2026-10-01T10:00:00.000Z'),
  ('T-dev1', 'thinker', 'review', NULL, 'approve', '2026-10-01T12:00:00.000Z'),
  ('T-dev2', 'dev', 'status', 'in_progress', 'done', '2026-10-04T10:00:00.000Z'),
  ('T-nolane', 'owner', 'task.created', NULL, NULL, '2026-09-01T10:00:00.000Z'),
  (NULL, 'core', 'lease.reaped', NULL, NULL, '2026-10-05T10:00:00.000Z');
INSERT INTO board_outbox (task_id, to_whom, kind, payload, created_at, delivered_at) VALUES
  ('T-dev1', 'owner', 'needs_answer', '{}', '2026-10-01T11:00:00.000Z', NULL),
  ('T-dev1', 'watcher', 'blocked', '{}', '2026-10-01T11:30:00.000Z', NULL),
  ('T-dev2', 'persona', 'done', '{}', '2026-10-04T10:00:00.000Z', NULL);
INSERT INTO board_results (id, task_id, attempt_id, kind, body, uri, created_at) VALUES
  ('R-dev2-pr', 'T-dev2', 'A-1', 'pr', NULL, 'https://example.invalid/pull/1', '2026-10-04T10:00:00.000Z'),
  ('R-dev2-h', 'T-dev2', 'A-1', 'handoff', '{"result":"merged"}', NULL, '2026-10-04T10:00:00.000Z');
INSERT INTO board_reviews (id, task_id, principal, decision, scope, note, created_at) VALUES
  ('V-1', 'T-dev1', 'thinker', 'approve', 'plan', NULL, '2026-10-01T12:00:00.000Z');
INSERT INTO board_dependencies (task_id, depends_on_id, type, created_by, created_at) VALUES
  ('T-dev2', 'T-dev1', 'blocks', 'thinker', '2026-10-03T10:00:00.000Z');
INSERT INTO board_attempts (id, task_id, n, principal, outcome) VALUES ('A-1', 'T-dev2', 1, 'dev', 'done');
INSERT INTO board_comments (id, task_id, author, text, created_at) VALUES
  ('C-1', 'T-dev1', 'owner', 'looks right', '2026-10-01T13:00:00.000Z');
INSERT INTO board_questions (id, task_id, to_whom, text, created_at) VALUES
  ('Q-1', 'T-dev1', 'owner', 'which branch?', '2026-10-01T11:00:00.000Z');
INSERT INTO board_idempotency (key, principal, response, created_at) VALUES
  ('k-1', 'thinker', '{}', '2026-10-01T10:00:00.000Z');
INSERT INTO board_agent_runs (id, agent, started_at) VALUES ('AR-1', 'dev', '2026-10-03T10:00:00.000Z');
`;

const WAKES = `
INSERT INTO wakes (id, kind, queued_at, payload, state, handled_at) VALUES
  ('w-si-queued', 'selfimprovement', 1000, '{}', 'queued', NULL),
  ('w-si-handled', 'selfimprovement', 900, '{}', 'handled', 950),
  ('w-hb-queued', 'heartbeat', 1100, '{}', 'queued', NULL);
`;

/** A database file at schema version 59 holding `sql`, written with raw SQL after the steps up to 59. */
function at59(sql: string): string {
  const file = path.join(tempDir('nep-board-60-'), 'memory.db');
  openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 59 - BASELINE_VERSION) }).close();
  const raw = new DatabaseSync(file);
  try {
    assert.equal(raw.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v, 59);
    raw.exec(sql);
  } finally {
    raw.close();
  }
  return file;
}

/** Reads `read` from `file` opened raw, before the current code touched it. */
function rawRead<TResult>(file: string, read: (db: Db) => TResult): TResult {
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    return read(raw);
  } finally {
    raw.close();
  }
}

/** Opens `file` with the current code, then `read` on its connection. */
function opened<TResult>(file: string, read: (db: Db) => TResult): TResult {
  const handle = openMemoryDb(file);
  try {
    return read(dbOf(handle));
  } finally {
    handle.close();
  }
}

const rows = (db: Db, sql: string): Array<Row> =>
  db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
const columnsOf = (db: Db, table: string): Array<string> =>
  rows(db, `PRAGMA table_info("${table}")`).map((row) => String(row.name));
const tableNames = (db: Db): Array<string> =>
  rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => String(row.name));

/** The errands' rows in every column step 60 keeps, each table in the order its rows were written. */
function errandRows(db: Db): Record<string, Array<Row>> {
  const errand = "(SELECT id FROM board_tasks WHERE lane = 'errand')";
  return {
    tasks: rows(db, `SELECT ${TASK_COLUMNS.join(', ')} FROM board_tasks WHERE id IN ${errand} ORDER BY rowid`),
    events: rows(db, `SELECT * FROM board_events WHERE task_id IN ${errand} ORDER BY seq`),
    outbox: rows(db, `SELECT * FROM board_outbox WHERE task_id IN ${errand} ORDER BY seq`),
    results: rows(
      db,
      `SELECT ${RESULT_COLUMNS.join(', ')} FROM board_results WHERE task_id IN ${errand} ORDER BY rowid`
    ),
  };
}

test('step 60 keeps every errand with its events, outbox rows and handoff as they were, in filing order', () => {
  // Bug: a rebuild that copies a column into the wrong place, drops an errand's history or its undelivered end, or
  // loses the filing order, which errandsOf lists errands in.
  const file = at59(ERRANDS + DEVELOPMENT);
  const before = rawRead(file, errandRows);
  assert.deepEqual(
    before.tasks.map((row) => row.id),
    ['E-zz', 'E-mm', 'E-aa', 'E-qq']
  );
  const after = opened(file, (db) => {
    const errand = '(SELECT id FROM board_tasks)';
    return {
      tasks: rows(db, `SELECT ${TASK_COLUMNS.join(', ')} FROM board_tasks ORDER BY rowid`),
      events: rows(db, `SELECT * FROM board_events WHERE task_id IN ${errand} ORDER BY seq`),
      outbox: rows(db, `SELECT * FROM board_outbox WHERE task_id IN ${errand} ORDER BY seq`),
      results: rows(db, `SELECT ${RESULT_COLUMNS.join(', ')} FROM board_results ORDER BY rowid`),
    };
  });
  assert.deepEqual(after, before);
});

test('step 60 deletes every task outside the errand lane with its events, outbox rows and results', () => {
  // Bug: a delete that matches `lane <> 'errand'` keeps a task with no lane, or leaves the children of a deleted task
  // behind, where the outbox count of /doctor core still counts them.
  const file = at59(ERRANDS + DEVELOPMENT);
  const left = opened(file, (db) => ({
    tasks: rows(db, 'SELECT id FROM board_tasks ORDER BY id').map((row) => row.id),
    events: rows(db, 'SELECT DISTINCT task_id FROM board_events ORDER BY task_id').map((row) => row.task_id),
    outbox: rows(db, 'SELECT DISTINCT task_id FROM board_outbox ORDER BY task_id').map((row) => row.task_id),
    results: rows(db, 'SELECT id FROM board_results ORDER BY id').map((row) => row.id),
  }));
  assert.deepEqual(left, {
    tasks: ['E-aa', 'E-mm', 'E-qq', 'E-zz'],
    events: ['E-aa', 'E-mm', 'E-qq', 'E-zz'],
    outbox: ['E-mm', 'E-zz'],
    results: ['R-E-zz'],
  });
});

test('step 60 drops the seven tables only development used and keeps events, outbox and the board version', () => {
  // Bug: a step that leaves a development table behind, or drops a table the errand store or the board's version
  // check still reads.
  const file = at59(ERRANDS + DEVELOPMENT);
  const tables = opened(file, tableNames);
  for (const table of DROPPED) assert.equal(tables.includes(table), false, `${table} is still there`);
  assert.deepEqual(
    tables.filter((name) => name.startsWith('board_')),
    ['board_events', 'board_outbox', 'board_results', 'board_schema_version', 'board_tasks']
  );
});

test('step 60 leaves board_tasks and board_results with only the columns errands use', () => {
  // Bug: a rebuild that keeps a development column, or loses one the errand store writes, so the next save throws.
  const file = at59(ERRANDS);
  const shape = opened(file, (db) => ({
    tasks: columnsOf(db, 'board_tasks'),
    results: columnsOf(db, 'board_results'),
    indexes: rows(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'board_tasks' ORDER BY name")
      .map((row) => String(row.name))
      .filter((name) => !name.startsWith('sqlite_autoindex')),
  }));
  assert.deepEqual(shape, { tasks: TASK_COLUMNS, results: RESULT_COLUMNS, indexes: ['board_tasks_status'] });
});

test('after step 60 board_tasks refuses a status no errand stands in', () => {
  // Bug: a rebuild that drops the status check lets a stray write file a task errandsOf cannot read back.
  const file = at59('');
  opened(file, (db) => {
    const insert = db.prepare(
      'INSERT INTO board_tasks (id, title, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const at = '2026-11-05T10:00:00.000Z';
    for (const status of ['approved', 'in_progress', 'done', 'failed', 'cancelled']) {
      insert.run(`E-${status}`, 'an errand', 'research', status, at, at);
    }
    for (const status of ['proposed', 'needs_answer', 'blocked']) {
      assert.throws(() => insert.run(`E-${status}`, 'an errand', 'research', status, at, at), /CHECK constraint/);
    }
  });
});

test('after step 60 board_results refuses a result kind other than handoff', () => {
  // Bug: a rebuild that drops the kind check, so a result errandOf never reads can be written.
  const file = at59(ERRANDS);
  opened(file, (db) => {
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO board_results (id, task_id, kind, body, created_at) VALUES ('R-x', 'E-mm', 'pr', '{}', 'x')"
          )
          .run(),
      /CHECK constraint/
    );
  });
});

test('step 60 deletes the selfimprovement wakes still waiting and keeps the handled ones and other kinds', () => {
  // Bug: a waiting selfimprovement wake that no service claims any more stays queued for good, or the step deletes
  // the handled history or a wake of another kind.
  const file = at59(WAKES);
  const ids = opened(file, (db) => rows(db, 'SELECT id FROM wakes ORDER BY id').map((row) => row.id));
  assert.deepEqual(ids, ['w-hb-queued', 'w-si-handled']);
});

test('a database at version 59 opens at version 60', () => {
  // Bug: a step that runs but records no version, so the next open runs it again over the narrowed tables.
  const file = at59(ERRANDS + DEVELOPMENT);
  const versions = opened(file, (db) =>
    rows(db, 'SELECT version FROM schema_version ORDER BY version').map((row) => Number(row.version))
  );
  assert.equal(Math.max(...versions), 60);
  assert.deepEqual(
    versions.filter((version) => version > 59),
    [60]
  );
});

test('a second open after step 60 changes no table, index or row', () => {
  // Bug: a step written so that it runs, or half runs, on every open.
  const file = at59(ERRANDS + DEVELOPMENT + WAKES);
  const first = opened(file, (db) => ({ shape: schemaShape(db), rows: filledRows(db) }));
  const second = opened(file, (db) => ({ shape: schemaShape(db), rows: filledRows(db) }));
  assert.deepEqual(second, first);
});
