// The board's schema in the memory database (src/board/schema.ts, the baseline of src/memory/db/schema-baseline.ts and
// step 60 of src/memory/db/schema.ts): a new database holds the errand board's four tables at the board's version, and
// a reopen keeps the board's rows. Temporary files only.
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

// Changed: step 60 narrows the board to what errands use, so a new database holds four board tables, not eleven.
test('a new memory database holds the four board tables of errands and the board at version 3', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    assert.deepEqual(
      tableNames(db).filter((name) => name.startsWith('board_')),
      ['board_events', 'board_outbox', 'board_results', 'board_schema_version', 'board_tasks']
    );
    assert.equal(BOARD_VERSION, 3);
    assert.equal(boardVersion(db), 3);
    assert.equal(handle.board.ok, true);
  } finally {
    handle.close();
  }
});

// Changed: step 60 keeps only the columns the errand store writes in board_tasks and board_results; the events and
// the outbox keep theirs.
test('the board tables have the columns the errand store writes and reads', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    const expected: Record<string, Array<string>> = {
      board_tasks: ['id', 'title', 'role', 'status', 'close_reason', 'created_at', 'updated_at', 'metadata'],
      board_results: ['id', 'task_id', 'kind', 'body', 'created_at'],
      board_events: ['seq', 'task_id', 'actor', 'type', 'old', 'new', 'created_at'],
      board_outbox: ['seq', 'task_id', 'to_whom', 'kind', 'payload', 'created_at', 'delivered_at'],
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
  // Changed: the task is filed in the narrow shape of step 60, at a status an errand stands in.
  dbOf(first)
    .prepare(
      "INSERT INTO board_tasks (id, title, role, status, created_at, updated_at) VALUES ('T-aaaaaa', 'kept', 'scout', 'approved', 'x', 'x')"
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
