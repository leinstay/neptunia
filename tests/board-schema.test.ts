// The board's schema in the memory database (src/board/schema.ts and the baseline of
// src/memory/db/schema-baseline.ts): a new database holds the board's tables at the board's version, and a reopen
// keeps the board's rows. Temporary files only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { BOARD_VERSION, boardVersion } from '../src/board/schema.ts';
import type { BoardDb } from '../src/board/schema.ts';
import { tempDir } from './fixtures/tmp.ts';

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

test('a new memory database holds the eleven board tables and the board at version 3', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    const tables = tableNames(db);
    const board = [
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
    ];
    for (const table of board) assert.ok(tables.includes(table), `${table} is missing`);
    assert.ok(tables.includes('board_schema_version'));
    assert.equal(BOARD_VERSION, 3);
    assert.equal(boardVersion(db), 3);
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

// The baseline seeds the three version rows the board's own migrations once wrote, one per step.
test('a reopened file keeps its board rows and its board version rows', () => {
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
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM board_schema_version').get()?.n, 3);
    assert.equal(db.prepare("SELECT title FROM board_tasks WHERE id = 'T-aaaaaa'").get()?.title, 'kept');
  } finally {
    second.close();
  }
});
