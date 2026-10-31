// Board v3 (src/board/schema.ts), the data step of PR 6d: at the first open by the current code every `work` row of
// kind errand becomes a board task of lane `errand` with the same id, its transition lines become the task's status
// events, and `work` and `work_events` stay behind as an archive that refuses every write. A second open changes
// nothing. The archive is written at board v2 by the unit writer of the engine before 6d (fixtures/errand-archive.ts).
// Temporary files only, a fixed clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.js';
import { tableHashes } from '../tools/memory-db.mjs';
import { readBoard } from '../src/board/board.ts';
import { boardVersion } from '../src/board/schema.ts';
import type { BoardDb } from '../src/board/schema.ts';
import { ARCHIVE, BOARD_STATUS, STATUS_EVENTS, T0, archiveDataDir } from './fixtures/errand-archive.ts';

const NOW = T0 + 60 * 60 * 1000;

// open.js types its connection as `object`; it is node:sqlite's DatabaseSync, which has every method BoardDb names.
const dbOf = (handle: { db: object }): BoardDb => handle.db as BoardDb;

function withOpen<T>(file: string, fn: (db: BoardDb) => T): T {
  const handle = openMemoryDb(file);
  try {
    return fn(dbOf(handle));
  } finally {
    handle.close();
  }
}

const countOf = (db: BoardDb, sql: string, ...params: Array<unknown>): number =>
  Number(db.prepare(sql).get(...params)?.n ?? -1);

test('the first open gives one errand-lane board task per archived errand, with its id and its mapped status', () => {
  const { file } = archiveDataDir();
  withOpen(file, (db) => {
    const board = readBoard(db, () => NOW);
    const tasks = board.list();
    assert.deepEqual(tasks.map((task) => task.id).sort(), ARCHIVE.map((errand) => errand.id).sort());
    for (const task of tasks) {
      assert.equal(task.lane, 'errand', task.id);
      assert.equal(task.status, BOARD_STATUS[task.id], task.id);
    }
  });
});

test("each moved task keeps the errand's agent as its role and its goal as its title", () => {
  const { file } = archiveDataDir();
  withOpen(file, (db) => {
    const board = readBoard(db, () => NOW);
    for (const errand of ARCHIVE) {
      const { task } = board.show(errand.id);
      assert.equal(task.role, errand.agent, errand.id);
      assert.equal(task.title, errand.goal, errand.id);
    }
  });
});

test("a done errand's result text becomes the moved task's handoff", () => {
  const { file } = archiveDataDir();
  withOpen(file, (db) => {
    const view = readBoard(db, () => NOW).show('t0000e001');
    assert.equal(view.handoff?.result, 'The notes list three changes.');
  });
});

test("each errand's transition lines become its status events, in order, the states mapped", () => {
  const { file } = archiveDataDir();
  withOpen(file, (db) => {
    for (const errand of ARCHIVE) {
      const statuses = db
        .prepare("SELECT new FROM board_events WHERE task_id = ? AND type = 'status' ORDER BY seq")
        .all(errand.id)
        .map((row) => String(row.new));
      assert.deepEqual(statuses, STATUS_EVENTS[errand.id], errand.id);
    }
  });
});

test('a second open changes neither the board nor the archive', () => {
  const { file } = archiveDataDir();
  const first = withOpen(file, (db) => {
    assert.equal(countOf(db, 'SELECT COUNT(*) AS n FROM board_tasks'), ARCHIVE.length, 'the first open moved them');
    return tableHashes(db);
  });
  const second = withOpen(file, (db) => tableHashes(db));
  const part = (hashes: Array<{ table: string }>): Array<{ table: string }> =>
    hashes.filter((entry) => entry.table.startsWith('board_') || entry.table.startsWith('work'));
  assert.deepEqual(part(second), part(first));
});

test('the archive keeps its rows and refuses an insert, an update and a delete of work', () => {
  const { file } = archiveDataDir();
  withOpen(file, (db) => {
    assert.equal(countOf(db, "SELECT COUNT(*) AS n FROM work WHERE kind = 'errand'"), ARCHIVE.length);
    assert.throws(() =>
      db.prepare("INSERT INTO work (id, kind, state, record) VALUES ('t0000e999', 'errand', 'queued', '{}')").run()
    );
    assert.throws(() => db.prepare("UPDATE work SET state = 'done' WHERE id = 't0000e002'").run());
    assert.throws(() => db.prepare("DELETE FROM work WHERE id = 't0000e003'").run());
    assert.equal(countOf(db, 'SELECT COUNT(*) AS n FROM work'), ARCHIVE.length);
    assert.equal(countOf(db, "SELECT COUNT(*) AS n FROM work WHERE id = 't0000e002' AND state = 'failed'"), 1);
  });
});

test('the archive refuses an insert, an update and a delete of work_events', () => {
  const { file } = archiveDataDir();
  withOpen(file, (db) => {
    const before = countOf(db, 'SELECT COUNT(*) AS n FROM work_events');
    assert.ok(before > 0, 'the fixture wrote transition lines');
    assert.throws(() =>
      db.prepare("INSERT INTO work_events (id, work_id, at_ms, record) VALUES ('x:1:0', 't0000e001', 1, '{}')").run()
    );
    assert.throws(() => db.prepare('UPDATE work_events SET at_ms = 0').run());
    assert.throws(() => db.prepare('DELETE FROM work_events').run());
    assert.equal(countOf(db, 'SELECT COUNT(*) AS n FROM work_events'), before);
  });
});

test('a database with no archived errand reaches board v3 with an empty board', () => {
  const handle = openMemoryDb(':memory:');
  try {
    assert.equal(handle.board.ok, true);
    assert.equal(boardVersion(dbOf(handle)), 3);
    assert.deepEqual(readBoard(dbOf(handle), () => NOW).list(), []);
  } finally {
    handle.close();
  }
});
