// The cutover's import (tools/board-import.mjs): the development history of the ledger service's `ledger.db` comes
// onto the board in `memory.db` with the ledger's ids, on a stopped core. Every dev-lane task comes with its
// dependencies, attempts, questions, reviews (the ledger's approvals), results, comments, events and outbox rows, and
// every agent run with it. The errand lane stays behind: it only mirrored her errands, which the board holds already.
// The board numbers its own events, so the imported events and outbox rows follow the board's in the ledger's order. A
// second run finds everything in place and writes nothing. A ledger at another schema version than 3, or a board task
// that holds a ledger id with other content, is refused before anything is written. The ledger file is built by the
// test with the ledger's own schema (fixtures/ledger-db.ts); temporary directories, a fixed clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.js';
import { openBoard, readBoard } from '../src/board/board.ts';
import type { BoardSettings } from '../src/board/board.ts';
import type { BoardDb } from '../src/board/schema.ts';
import { tableHashes } from '../tools/memory-db.mjs';
import { importLedger, main } from '../tools/board-import.mjs';
import { tempDir } from './fixtures/tmp.js';
import {
  DEV_TASKS,
  DONE_TASK,
  ERRAND_MIRROR,
  LEDGER_ROWS,
  OPEN_TASK,
  ledgerRows,
  writeLedgerDb,
} from './fixtures/ledger-db.ts';

const NOW = Date.parse('2026-10-31T10:00:00.000Z');
const SETTINGS: BoardSettings = {
  leaseTtlMinutes: 30,
  autoTriage: { role: 'dev', budget: 4, steps: 80, estimate: 30 },
  projects: {},
};
/** One of her errands as board v3 moved it from the `work` archive, with the board's first two events. */
const OWN_ERRAND = 't0000e001';

type Row = Record<string, unknown>;
type Hash = { table: string; rows: number; hash: string };

// open.js types its connection as `object`; it is node:sqlite's DatabaseSync, which has every method BoardDb names.
const dbOf = (handle: { db: object }): BoardDb => handle.db as BoardDb;

/** A ledger.db and a memory.db in a fresh folder: the board at its version, holding one errand of hers. */
function setUp(ledgerVersion?: number): { ledger: string; memory: string; dir: string } {
  const dir = tempDir('nep-board-import-');
  const ledger = path.join(dir, 'ledger.db');
  const memory = path.join(dir, 'memory.db');
  writeLedgerDb(ledger, ledgerVersion === undefined ? {} : { version: ledgerVersion });
  const handle = openMemoryDb(memory);
  try {
    const db = dbOf(handle);
    db.prepare(
      `INSERT INTO board_tasks (id, lane, title, requester, role, status, created_at, updated_at)
       VALUES (?, 'errand', 'find the release notes of the editor', 'persona', 'scout', 'done', ?, ?)`
    ).run(OWN_ERRAND, '2026-10-30T10:00:00.000Z', '2026-10-30T10:00:06.000Z');
    const event = db.prepare(
      "INSERT INTO board_events (task_id, actor, type, old, new, created_at) VALUES (?, 'core', 'status', ?, ?, ?)"
    );
    event.run(OWN_ERRAND, null, 'approved', '2026-10-30T10:00:00.000Z');
    event.run(OWN_ERRAND, 'in_progress', 'done', '2026-10-30T10:00:06.000Z');
  } finally {
    handle.close();
  }
  return { ledger, memory, dir };
}

/** `sql` over the memory database, read-only. */
function rows(file: string, sql: string, ...args: Array<unknown>): Array<Row> {
  const handle = openMemoryDb(file, { readOnly: true });
  try {
    return dbOf(handle)
      .prepare(sql)
      .all(...args)
      .map((row) => ({ ...row }));
  } finally {
    handle.close();
  }
}

function boardHashes(file: string): Array<Hash> {
  const handle = openMemoryDb(file, { readOnly: true });
  try {
    return (tableHashes(handle.db) as Array<Hash>).filter((entry) => entry.table.startsWith('board_'));
  } finally {
    handle.close();
  }
}

/** The ids of `column` in `table` of the board for the dev tasks, sorted. */
const boardIds = (file: string, table: string, column = 'id'): Array<unknown> =>
  rows(file, `SELECT ${column} AS id FROM ${table} WHERE task_id IN (?, ?, ?)`, ...DEV_TASKS)
    .map((row) => row.id)
    .sort();

/** The ids of `column` in the ledger's rows of `table` for the dev tasks, sorted. */
const ledgerIds = (table: string, column = 'id'): Array<unknown> =>
  (LEDGER_ROWS[table] ?? [])
    .filter((row) => DEV_TASKS.includes(String(row.task_id)))
    .map((row) => row[column])
    .sort();

/** What an event row says, without its sequence number. */
const eventOf = (row: Row): Array<unknown> => [row.task_id, row.actor, row.type, row.old, row.new, row.created_at];

test('imports every dev task of the ledger with its id and its fields, at lease generation 0', () => {
  const { ledger, memory } = setUp();
  const report = importLedger({ from: ledger, db: memory });
  assert.equal(report.ok, true);
  const imported = rows(memory, "SELECT * FROM board_tasks WHERE lane = 'dev' ORDER BY id");
  assert.deepEqual(
    imported.map((row) => row.id),
    [...DEV_TASKS].sort()
  );
  const done = imported.find((row) => row.id === DONE_TASK);
  const source = LEDGER_ROWS.tasks?.find((row) => row.id === DONE_TASK);
  assert.ok(done !== undefined && source !== undefined);
  for (const column of Object.keys(source)) assert.equal(done[column], source[column], column);
  assert.deepEqual(
    imported.map((row) => row.lease_generation),
    [0, 0, 0]
  );
});

test('leaves the errand lane of the ledger behind and her own errand on the board as it was', () => {
  const { ledger, memory } = setUp();
  const before = rows(memory, "SELECT * FROM board_tasks WHERE lane = 'errand'");
  const report = importLedger({ from: ledger, db: memory });
  assert.ok(report.ok);
  assert.equal(report.skipped.errandTasks, 1);
  assert.deepEqual(rows(memory, "SELECT * FROM board_tasks WHERE lane = 'errand'"), before);
  for (const table of ['board_tasks', 'board_attempts', 'board_results', 'board_events', 'board_outbox']) {
    const column = table === 'board_tasks' ? 'id' : 'task_id';
    assert.deepEqual(rows(memory, `SELECT 1 FROM ${table} WHERE ${column} = ?`, ERRAND_MIRROR), [], table);
  }
});

test('brings the attempts, questions, results and comments of the dev tasks with their ids', () => {
  const { ledger, memory } = setUp();
  assert.ok(importLedger({ from: ledger, db: memory }).ok);
  assert.deepEqual(boardIds(memory, 'board_attempts'), ledgerIds('attempts'));
  assert.deepEqual(boardIds(memory, 'board_questions'), ledgerIds('questions'));
  assert.deepEqual(boardIds(memory, 'board_results'), ledgerIds('results'));
  assert.deepEqual(boardIds(memory, 'board_comments'), ledgerIds('comments'));
  const attempt = rows(memory, 'SELECT * FROM board_attempts WHERE id = ?', 'A-aaaaaa')[0];
  assert.deepEqual(
    [attempt?.principal, attempt?.role, attempt?.cost_est_usd, attempt?.outcome],
    ['dispatcher', 'dev', 0.4, 'done']
  );
});

test("brings the ledger's approvals as reviews with their decision and scope", () => {
  const { ledger, memory } = setUp();
  assert.ok(importLedger({ from: ledger, db: memory }).ok);
  const reviews = rows(memory, 'SELECT id, principal, decision, scope FROM board_reviews ORDER BY id');
  assert.deepEqual(reviews, [
    { id: 'P-aaaaa1', principal: 'lead', decision: 'approve', scope: 'plan' },
    { id: 'P-aaaaa2', principal: 'lead', decision: 'approve', scope: 'merge' },
  ]);
});

test('brings the dependencies with their type, and keeps the dependent of a done task unblocked', () => {
  const { ledger, memory } = setUp();
  assert.ok(importLedger({ from: ledger, db: memory }).ok);
  const deps = rows(memory, 'SELECT task_id, depends_on_id, type FROM board_dependencies ORDER BY task_id');
  assert.deepEqual(
    deps,
    (LEDGER_ROWS.dependencies ?? [])
      .map((row) => ({ task_id: row.task_id, depends_on_id: row.depends_on_id, type: row.type }))
      .sort((a, b) => String(a.task_id).localeCompare(String(b.task_id)))
  );
  assert.equal(rows(memory, 'SELECT is_blocked FROM board_tasks WHERE id = ?', OPEN_TASK)[0]?.is_blocked, 0);
});

test('brings every agent run with its id and its figures', () => {
  const { ledger, memory } = setUp();
  assert.ok(importLedger({ from: ledger, db: memory }).ok);
  const runs = rows(memory, 'SELECT id, agent, wave, cost_est_usd, context_peak FROM board_agent_runs');
  assert.deepEqual(runs, [{ id: 'W-aaaaaa', agent: 'thinker', wave: 3, cost_est_usd: 0.9, context_peak: 80000 }]);
});

test("appends the dev tasks' events after the board's own, in the ledger's order, and keeps the board's numbers", () => {
  const { ledger, memory } = setUp();
  const own = rows(memory, 'SELECT * FROM board_events ORDER BY seq');
  const last = Math.max(...own.map((row) => Number(row.seq)));
  assert.ok(importLedger({ from: ledger, db: memory }).ok);
  assert.deepEqual(rows(memory, 'SELECT * FROM board_events WHERE task_id = ? ORDER BY seq', OWN_ERRAND), own);
  const imported = rows(memory, 'SELECT * FROM board_events WHERE task_id IN (?, ?, ?) ORDER BY seq', ...DEV_TASKS);
  assert.ok(
    imported.every((row) => Number(row.seq) > last),
    'every imported event follows the board events'
  );
  assert.deepEqual(imported.map(eventOf), ledgerRows(ledger, 'events', DEV_TASKS).map(eventOf));
});

test('brings the outbox rows of the dev tasks with their delivery marks', () => {
  const { ledger, memory } = setUp();
  assert.ok(importLedger({ from: ledger, db: memory }).ok);
  const outbox = rows(memory, 'SELECT task_id, to_whom, kind, payload, delivered_at FROM board_outbox ORDER BY seq');
  assert.deepEqual(
    outbox,
    ledgerRows(ledger, 'outbox', DEV_TASKS).map((row) => ({
      task_id: row.task_id,
      to_whom: row.to_whom,
      kind: row.kind,
      payload: row.payload,
      delivered_at: row.delivered_at,
    }))
  );
});

test('takes over no idempotency key of the ledger', () => {
  const { ledger, memory } = setUp();
  assert.ok(importLedger({ from: ledger, db: memory }).ok);
  assert.deepEqual(rows(memory, 'SELECT key FROM board_idempotency'), []);
});

test('reports what it imported, table by table', () => {
  const { ledger, memory } = setUp();
  const report = importLedger({ from: ledger, db: memory });
  assert.ok(report.ok);
  // The whole shape is the point: one count per table of the ledger the import brings, the deploy reads them all.
  assert.deepEqual(report.imported, {
    tasks: 3,
    dependencies: 2,
    attempts: 2,
    questions: 1,
    reviews: 2,
    results: 3,
    comments: 1,
    events: 10,
    outbox: 1,
    agentRuns: 1,
  });
});

test('a second run imports nothing and leaves every board table as it was', () => {
  const { ledger, memory } = setUp();
  const first = importLedger({ from: ledger, db: memory });
  assert.ok(first.ok);
  const after = boardHashes(memory);
  const second = importLedger({ from: ledger, db: memory });
  assert.ok(second.ok);
  assert.ok(
    Object.values(second.imported).every((n) => n === 0),
    JSON.stringify(second.imported)
  );
  assert.deepEqual(second.present, first.imported);
  assert.deepEqual(boardHashes(memory), after);
});

test('a dry run reports the counts of the import and writes nothing', () => {
  const { ledger, memory } = setUp();
  const before = boardHashes(memory);
  const dry = importLedger({ from: ledger, db: memory, dryRun: true });
  assert.ok(dry.ok);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.imported.tasks, 3);
  assert.deepEqual(boardHashes(memory), before);
});

test('refuses a ledger at a schema version it does not know, and writes nothing', () => {
  const { ledger, memory } = setUp(4);
  const before = boardHashes(memory);
  const report = importLedger({ from: ledger, db: memory });
  assert.equal(report.ok, false);
  assert.equal(report.ok ? null : report.code, 'unknown-version');
  assert.deepEqual(boardHashes(memory), before);
});

test('refuses when a board task holds a ledger id with other content, and writes nothing', () => {
  const { ledger, memory } = setUp();
  const handle = openMemoryDb(memory);
  try {
    dbOf(handle)
      .prepare(
        `INSERT INTO board_tasks (id, lane, title, requester, status, created_at, updated_at)
         VALUES (?, 'dev', 'another task', 'lead', 'proposed', ?, ?)`
      )
      .run(OPEN_TASK, '2026-10-29T09:00:00.000Z', '2026-10-29T09:00:00.000Z');
  } finally {
    handle.close();
  }
  const before = boardHashes(memory);
  const report = importLedger({ from: ledger, db: memory });
  assert.equal(report.ok ? null : report.code, 'conflict');
  assert.deepEqual(boardHashes(memory), before);
});

test('an imported task shows its attempts, results, reviews and events through the board', () => {
  const { ledger, memory } = setUp();
  assert.ok(importLedger({ from: ledger, db: memory }).ok);
  const handle = openMemoryDb(memory, { readOnly: true });
  try {
    const view = readBoard(dbOf(handle), () => NOW).show(DONE_TASK);
    assert.equal(view.task.status, 'done');
    assert.deepEqual(
      view.attempts.map((row) => row.id),
      ['A-aaaaaa']
    );
    assert.deepEqual(view.results.map((row) => row.kind).sort(), ['pr', 'prompt', 'summary']);
    assert.equal(view.approvals.length, 2);
    assert.equal(view.events.length, 6);
  } finally {
    handle.close();
  }
});

test('an imported approved task is handed to a worker by task.next with the first generation', () => {
  const { ledger, memory, dir } = setUp();
  assert.ok(importLedger({ from: ledger, db: memory }).ok);
  const privateDir = path.join(dir, 'p');
  tempDirFile(privateDir, 'clients.json', {
    dispatcher: { kind: 'agent', tokenFile: 'clients/dispatcher.token', permissions: [], boardRoles: ['worker'] },
  });
  const handle = openMemoryDb(memory);
  try {
    const board = openBoard({ db: dbOf(handle), privateDir, now: () => NOW, settings: () => SETTINGS });
    const held = board.call('dispatcher', 'task.next', { lane: 'dev', role: 'dev' });
    assert.equal(held?.id, OPEN_TASK);
    assert.equal(held?.lease_generation, 1);
  } finally {
    handle.close();
  }
});

test('main exits 1 with the refusal code first on stderr for a ledger it does not know', () => {
  const { ledger, memory } = setUp(4);
  const err: Array<string> = [];
  const code = main(['--from', ledger, '--db', memory], { out: () => {}, err: (line: string) => err.push(line) });
  assert.equal(code, 1);
  assert.ok((err[0] ?? '').startsWith('unknown-version:'), err.join('\n'));
});

test('main exits 2 without --from and touches no file', () => {
  const { memory } = setUp();
  const before = boardHashes(memory);
  assert.equal(main(['--db', memory], { out: () => {}, err: () => {} }), 2);
  assert.deepEqual(boardHashes(memory), before);
});

/** Writes `value` as JSON to `<dir>/<name>`, making the folder. */
function tempDirFile(dir: string, name: string, value: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
}
