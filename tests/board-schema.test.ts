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

test('a new memory database holds the eleven board tables and the board at version 1', () => {
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
    assert.equal(BOARD_MIGRATIONS.length, 1);
    assert.equal(boardVersion(db), 1);
    assert.equal(handle.board.ok, true);
  } finally {
    handle.close();
  }
});

// The cutover (PR 6e) copies ledger.db's rows column by column, so each board table keeps its ledger v3 columns.
test('the board tables have the columns of the ledger schema v3, approvals as reviews', () => {
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

test('a reopened file keeps its board rows and does not run board v1 twice', () => {
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
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM board_schema_version').get()?.n, 1);
    assert.equal(db.prepare("SELECT title FROM board_tasks WHERE id = 'T-aaaaaa'").get()?.title, 'kept');
  } finally {
    second.close();
  }
});

test('a later board migration is applied on top of v1 and leaves the memory version alone', () => {
  const file = path.join(tempDir('nep-board-schema-'), 'memory.db');
  openMemoryDb(file).close();
  const handle = openMemoryDb(file, {
    boardMigrations: [...BOARD_MIGRATIONS, 'CREATE TABLE board_later (id TEXT PRIMARY KEY);'],
  });
  try {
    const db = dbOf(handle);
    assert.equal(boardVersion(db), 2);
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

test('a failing board migration on top of v1 keeps the v1 board and its rows as they were', () => {
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
    assert.equal(boardVersion(db), 1);
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
