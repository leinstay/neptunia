// The board's schema in the memory database (src/board/schema.ts and the board's step of src/memory/db/open.js):
// board v1 creates its tables beside her memory with a version table of its own, its migrations run after the
// memory's in a transaction of their own, and a failing board migration leaves her memory open and writable. Temporary
// files only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MIGRATIONS, openMemoryDb, schemaVersion } from '../src/memory/db/open.js';
import { BOARD_MIGRATIONS, BOARD_TABLES, boardVersion } from '../src/board/schema.ts';
import type { BoardDb } from '../src/board/schema.ts';
import { tempDir } from './fixtures/tmp.js';

// open.js types its connection as `object`; it is node:sqlite's DatabaseSync, which has every method BoardDb names.
const dbOf = (handle: { db: object }): BoardDb => handle.db as BoardDb;

const tableNames = (db: BoardDb): Array<string> =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row.name));

const columnsOf = (db: BoardDb, table: string): Array<string> =>
  db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .map((row) => String(row.name));

const BROKEN = 'CREATE TABLE board_half (id TEXT); THIS IS NOT SQL;';

// PR 6b: board v2 (lease generations, the block, the handoff and the review decisions) is the latest, so a new
// database stands at version 2, where it stood at 1 before that migration existed.
test('a new memory database holds the eleven board tables and the board at version 2', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    const tables = tableNames(db);
    assert.deepEqual([...BOARD_TABLES].sort(), [
      'board_agent_runs',
      'board_attempts',
      'board_comments',
      'board_dependencies',
      'board_events',
      'board_idempotency',
      'board_outbox',
      'board_questions',
      'board_results',
      'board_reviews',
      'board_tasks',
    ]);
    for (const table of BOARD_TABLES) assert.ok(tables.includes(table), `${table} is missing`);
    assert.ok(tables.includes('board_schema_version'));
    assert.equal(BOARD_MIGRATIONS.length, 2);
    assert.equal(boardVersion(db), 2);
    assert.equal(handle.board.ok, true);
  } finally {
    handle.close();
  }
});

// The cutover (PR 6e) copies ledger.db's rows column by column, so each board table keeps its ledger v3 columns.
// PR 6b: board v2 appends three columns to board_tasks after the ledger's, so the v3 columns keep their order and the
// cutover's copy names only those.
test('the board tables have the columns of the ledger schema v3, approvals as reviews, and the v2 task columns', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    const expected: Record<string, Array<string>> = {
      board_tasks: [
        'id',
        'lane',
        'project',
        'title',
        'description',
        'acceptance',
        'requester',
        'priority',
        'risk',
        'role',
        'budget_usd',
        'step_cap',
        'estimate_minutes',
        'status',
        'close_reason',
        'defer_until',
        'is_blocked',
        'revision',
        'lease_owner',
        'lease_expires_at',
        'heartbeat_at',
        'subscriber',
        'created_at',
        'updated_at',
        'metadata',
        'lease_generation',
        'blocked_reason',
        'unblocks',
      ],
      board_dependencies: ['task_id', 'depends_on_id', 'type', 'created_by', 'created_at'],
      board_attempts: [
        'id',
        'task_id',
        'n',
        'principal',
        'role',
        'model',
        'provider_pin',
        'worktree',
        'branch',
        'db_path',
        'started_at',
        'ended_at',
        'exit_code',
        'finish_reason',
        'steps',
        'tokens_in',
        'tokens_out',
        'tokens_reasoning',
        'cache_read',
        'cache_write',
        'cost_est_usd',
        'cost_billed_usd',
        'rejected_asks',
        'failed_tools',
        'loop_signals',
        'stall_signals',
        'outcome',
      ],
      board_questions: [
        'id',
        'task_id',
        'attempt_id',
        'asked_by',
        'text',
        'to_whom',
        'answer',
        'answered_by',
        'answered_at',
        'created_at',
      ],
      board_reviews: ['id', 'task_id', 'principal', 'decision', 'scope', 'note', 'created_at'],
      board_results: ['id', 'task_id', 'attempt_id', 'kind', 'body', 'uri', 'created_at'],
      board_comments: ['id', 'task_id', 'author', 'text', 'created_at'],
      board_events: ['seq', 'task_id', 'actor', 'type', 'old', 'new', 'created_at'],
      board_outbox: ['seq', 'task_id', 'to_whom', 'kind', 'payload', 'created_at', 'delivered_at'],
      board_idempotency: ['key', 'principal', 'response', 'created_at'],
      board_agent_runs: [
        'id',
        'agent',
        'session_id',
        'wave',
        'started_at',
        'ended_at',
        'trigger_seqs',
        'steps',
        'tokens_in',
        'tokens_out',
        'cache_read',
        'cache_write',
        'cost_est_usd',
        'context_mean',
        'context_peak',
        'compactions',
        'outcome',
      ],
    };
    for (const [table, columns] of Object.entries(expected)) assert.deepEqual(columnsOf(db, table), columns, table);
  } finally {
    handle.close();
  }
});

// PR 6b: the board has more than one migration, so a single run of each leaves one version row per migration.
test('a reopened file keeps its board rows and does not run a board migration twice', () => {
  const file = path.join(tempDir('nep-board-schema-'), 'memory.db');
  const first = openMemoryDb(file);
  dbOf(first)
    .prepare(
      "INSERT INTO board_tasks (id, title, requester, status, created_at, updated_at) VALUES ('T-aaaaaa', 'kept', 'owner', 'proposed', 'x', 'x')"
    )
    .run();
  first.close();
  const second = openMemoryDb(file);
  try {
    const db = dbOf(second);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM board_schema_version').get()?.n, BOARD_MIGRATIONS.length);
    assert.equal(db.prepare("SELECT title FROM board_tasks WHERE id = 'T-aaaaaa'").get()?.title, 'kept');
  } finally {
    second.close();
  }
});

// PR 6b: the shipped list has two entries, so the appended migration is version 3; the count follows the list.
test('a later board migration is applied on top of the shipped ones and leaves the memory version alone', () => {
  const file = path.join(tempDir('nep-board-schema-'), 'memory.db');
  openMemoryDb(file).close();
  const handle = openMemoryDb(file, {
    boardMigrations: [...BOARD_MIGRATIONS, 'CREATE TABLE board_later (id TEXT PRIMARY KEY);'],
  });
  try {
    const db = dbOf(handle);
    assert.equal(boardVersion(db), BOARD_MIGRATIONS.length + 1);
    assert.ok(tableNames(db).includes('board_later'));
    assert.equal(schemaVersion(handle.db), MIGRATIONS.length);
  } finally {
    handle.close();
  }
});

test('a failing board migration leaves the memory migrated, open and writable, and the board down', () => {
  const file = path.join(tempDir('nep-board-schema-'), 'memory.db');
  openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 20), boardMigrations: [] }).close();
  const handle = openMemoryDb(file, { boardMigrations: [BROKEN] });
  try {
    const db = dbOf(handle);
    assert.equal(schemaVersion(handle.db), MIGRATIONS.length);
    assert.equal(handle.board.ok, false);
    assert.equal(boardVersion(db), 0);
    assert.ok(!tableNames(db).includes('board_half'));
    handle.transaction(() => db.prepare("INSERT INTO meta (key, value) VALUES ('after', 'written')").run());
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'after'").get()?.value, 'written');
  } finally {
    handle.close();
  }
});

// PR 6b: the file opens at the latest shipped version (2), and a failing step above it keeps that version.
test('a failing board migration on top of the shipped ones keeps the board and its rows as they were', () => {
  const file = path.join(tempDir('nep-board-schema-'), 'memory.db');
  const first = openMemoryDb(file);
  dbOf(first)
    .prepare(
      "INSERT INTO board_tasks (id, title, requester, status, created_at, updated_at) VALUES ('T-bbbbbb', 'kept', 'owner', 'proposed', 'x', 'x')"
    )
    .run();
  first.close();
  const handle = openMemoryDb(file, { boardMigrations: [...BOARD_MIGRATIONS, BROKEN] });
  try {
    const db = dbOf(handle);
    assert.equal(handle.board.ok, false);
    assert.equal(boardVersion(db), BOARD_MIGRATIONS.length);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM board_tasks').get()?.n, 1);
    assert.ok(!tableNames(db).includes('board_half'));
  } finally {
    handle.close();
  }
});

test('a read-only open of a memory file without a board creates no board table', () => {
  const file = path.join(tempDir('nep-board-schema-'), 'memory.db');
  openMemoryDb(file, { boardMigrations: [] }).close();
  const handle = openMemoryDb(file, { readOnly: true });
  try {
    assert.equal(boardVersion(dbOf(handle)), 0);
    assert.ok(!tableNames(dbOf(handle)).includes('board_tasks'));
  } finally {
    handle.close();
  }
});

test('board v2 on a v1 file keeps every row, starts each task at generation 0, and keeps the indexes and checks', () => {
  const file = path.join(tempDir('nep-board-schema-'), 'memory.db');
  const v1 = openMemoryDb(file, { boardMigrations: BOARD_MIGRATIONS.slice(0, 1) });
  const old = dbOf(v1);
  old
    .prepare(
      `INSERT INTO board_tasks (id, title, requester, status, lease_owner, lease_expires_at, revision, created_at, updated_at, metadata)
      VALUES ('T-held11', 'held', 'owner', 'in_progress', 'hand', '2026-10-31T10:30:00.000Z', 4, 'x', 'x', '{"ci":"green"}')`
    )
    .run();
  old
    .prepare(
      "INSERT INTO board_results (id, task_id, kind, uri, created_at) VALUES ('R-pr1111', 'T-held11', 'pr', 'u', 'x')"
    )
    .run();
  old
    .prepare(
      "INSERT INTO board_reviews (id, task_id, principal, decision, scope, created_at) VALUES ('A-rev111', 'T-held11', 'owner', 'approve', 'plan', 'x')"
    )
    .run();
  old
    .prepare(
      "INSERT INTO board_dependencies (task_id, depends_on_id, type) VALUES ('T-held11', 'T-other1', 'parent-child')"
    )
    .run();
  v1.close();

  const handle = openMemoryDb(file);
  try {
    const db = dbOf(handle);
    assert.equal(handle.board.ok, true);
    assert.equal(boardVersion(db), BOARD_MIGRATIONS.length);
    const task = db.prepare("SELECT * FROM board_tasks WHERE id = 'T-held11'").get();
    assert.deepEqual(
      [task?.status, task?.lease_owner, task?.revision, task?.metadata],
      ['in_progress', 'hand', 4, '{"ci":"green"}']
    );
    assert.deepEqual([task?.lease_generation, task?.blocked_reason, task?.unblocks], [0, null, null]);
    for (const table of ['board_results', 'board_reviews', 'board_dependencies']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 1, table);
    }
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'board_tasks'")
      .all()
      .map((row) => String(row.name));
    assert.ok(indexes.includes('board_tasks_status') && indexes.includes('board_tasks_lease'), indexes.join(','));
    db.prepare(
      "INSERT INTO board_tasks (id, title, requester, status, created_at, updated_at) VALUES ('T-block1', 'b', 'owner', 'blocked', 'x', 'x')"
    ).run();
    db.prepare(
      "INSERT INTO board_results (id, task_id, kind, body, created_at) VALUES ('R-hand11', 'T-block1', 'handoff', '{}', 'x')"
    ).run();
    for (const decision of ['accept', 'changes']) {
      db.prepare(
        "INSERT INTO board_reviews (id, task_id, principal, decision, scope, created_at) VALUES (?, 'T-block1', 'rev', ?, 'merge', 'x')"
      ).run(`A-${decision}`, decision);
    }
    assert.throws(() =>
      db
        .prepare(
          "INSERT INTO board_tasks (id, title, requester, status, created_at, updated_at) VALUES ('T-bad111', 'b', 'owner', 'paused', 'x', 'x')"
        )
        .run()
    );
  } finally {
    handle.close();
  }
});
