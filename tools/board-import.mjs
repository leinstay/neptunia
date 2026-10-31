#!/usr/bin/env node
// The cutover's import: the development history of the task ledger service's `ledger.db` onto the board in
// `memory.db`, on a stopped core (docs/board.md, "Importing a ledger"). Run from a checkout:
//
//   node tools/board-import.mjs --from <ledger.db> --db <memory.db> [--dry-run]
//
// It reads a ledger at schema version 3 and brings every `dev`-lane task with its id and every ledger column, at lease
// generation 0, with its dependencies, attempts, questions, approvals (as `board_reviews`), results, comments, events
// and outbox rows, and every row of `agent_runs`. The `errand` lane stays behind with every row that hangs off it: it
// only mirrored her errands, which the board holds under their own ids. Events and outbox rows are appended after the
// board's last `seq`, in the ledger's order, since the board numbered its own already. No idempotency key comes over.
// A task or an agent run the board holds with the same id and the same content counts as `present` and brings nothing,
// so a second run writes nothing. A board row that holds a ledger id with other content refuses the whole import
// (`conflict`). The writes are one BEGIN IMMEDIATE transaction under the database's writer lock; `--dry-run` opens the
// database read-only and reports the counts it would import. Exit 0 ok, 1 refused (`<code>: <message>` first on
// stderr), 2 a usage error. Nothing here starts the bot or calls a model.

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { openMemoryDb } from '../src/memory/db/open.js';
import { BOARD_MIGRATIONS, boardVersion } from '../src/board/schema.ts';

/** @typedef {import('../src/board/schema.ts').BoardDb} BoardDb */
/** @typedef {Record<string, unknown>} Row */
/** @typedef {{ out(line: string): void, err(line: string): void }} Io */
/**
 * @typedef {{ tasks: number, dependencies: number, attempts: number, questions: number, reviews: number,
 *   results: number, comments: number, events: number, outbox: number, agentRuns: number }} ImportCounts
 */
/** @typedef {'unknown-version' | 'not-a-ledger' | 'conflict' | 'board-unavailable'} RefusalCode */
/**
 * @typedef {{ ok: true, dryRun: boolean, imported: ImportCounts, present: ImportCounts,
 *   skipped: { errandTasks: number } }
 *   | { ok: false, code: RefusalCode, message: string }} ImportReport
 */

/** The ledger schema version the import reads. */
const LEDGER_VERSION = 3;

/**
 * The ledger's tables that hang off a task, each with its board table and the count it adds to. `id` is the column
 * that identifies a row on the board, null for a table the board numbers itself.
 * @type {ReadonlyArray<{ from: string, to: string, count: keyof ImportCounts, id: ReadonlyArray<string> | null }>}
 */
const CHILDREN = [
  { from: 'dependencies', to: 'board_dependencies', count: 'dependencies', id: ['task_id', 'depends_on_id'] },
  { from: 'attempts', to: 'board_attempts', count: 'attempts', id: ['id'] },
  { from: 'questions', to: 'board_questions', count: 'questions', id: ['id'] },
  { from: 'approvals', to: 'board_reviews', count: 'reviews', id: ['id'] },
  { from: 'results', to: 'board_results', count: 'results', id: ['id'] },
  { from: 'comments', to: 'board_comments', count: 'comments', id: ['id'] },
  { from: 'events', to: 'board_events', count: 'events', id: null },
  { from: 'outbox', to: 'board_outbox', count: 'outbox', id: null },
];

/** @returns {ImportCounts} */
const zero = () => ({
  tasks: 0,
  dependencies: 0,
  attempts: 0,
  questions: 0,
  reviews: 0,
  results: 0,
  comments: 0,
  events: 0,
  outbox: 0,
  agentRuns: 0,
});

/** A refusal of the import. */
class Refusal extends Error {
  /**
   * @param {RefusalCode} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Every row of `table` in the ledger, in rowid order.
 * @param {DatabaseSync} ledger
 * @param {string} table
 * @returns {Array<Row>}
 */
const ledgerTable = (ledger, table) =>
  ledger
    .prepare(`SELECT * FROM "${table}" ORDER BY rowid`)
    .all()
    .map((row) => ({ ...row }));

/**
 * Opens `file` as a ledger read-only and checks its schema version.
 * @param {string} file
 * @returns {DatabaseSync}
 */
function openLedger(file) {
  if (!fs.existsSync(file)) throw new Refusal('not-a-ledger', `${file} does not exist`);
  const ledger = new DatabaseSync(file, { readOnly: true });
  try {
    const has = (/** @type {string} */ name) =>
      ledger.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
    if (!has('schema_version') || !has('tasks')) {
      throw new Refusal('not-a-ledger', `${file} has no schema_version or tasks table`);
    }
    const version = Number(ledger.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v ?? 0);
    if (version !== LEDGER_VERSION) {
      throw new Refusal(
        'unknown-version',
        `the ledger is at schema version ${version}; the import reads version ${LEDGER_VERSION}`
      );
    }
    return ledger;
  } catch (error) {
    ledger.close();
    throw error;
  }
}

/**
 * Whether two rows hold the same value in every column of `source`.
 * @param {Row} source
 * @param {Row} target
 */
const sameColumns = (source, target) => Object.keys(source).every((column) => source[column] === target[column]);

/**
 * The board's row of `table` whose columns `id` hold the values `row` has there, if any.
 * @param {BoardDb} db
 * @param {string} table
 * @param {ReadonlyArray<string>} id
 * @param {Row} row
 * @returns {Row | undefined}
 */
const boardRow = (db, table, id, row) =>
  db
    .prepare(`SELECT * FROM ${table} WHERE ${id.map((column) => `${column} = ?`).join(' AND ')}`)
    .get(...id.map((column) => row[column]));

/**
 * What the import would do: the rows to insert per board table, in order, and the counts.
 * @param {DatabaseSync} ledger
 * @param {BoardDb} db
 */
function plan(ledger, db) {
  const imported = zero();
  const present = zero();
  /** @type {Array<{ table: string, row: Row }>} */
  const inserts = [];
  const tasks = ledgerTable(ledger, 'tasks');
  const errandTasks = tasks.filter((task) => task.lane === 'errand').length;
  /** @type {Set<unknown>} */
  const fresh = new Set();
  /** @type {Set<unknown>} */
  const kept = new Set();
  for (const task of tasks.filter((row) => row.lane === 'dev')) {
    const found = boardRow(db, 'board_tasks', ['id'], task);
    if (found === undefined) {
      fresh.add(task.id);
      imported.tasks += 1;
      inserts.push({
        table: 'board_tasks',
        row: { ...task, lease_generation: 0, blocked_reason: null, unblocks: null },
      });
    } else if (sameColumns(task, found)) {
      kept.add(task.id);
      present.tasks += 1;
    } else {
      throw new Refusal('conflict', `the board holds task ${String(task.id)} with other content`);
    }
  }
  for (const child of CHILDREN) {
    for (const row of ledgerTable(ledger, child.from)) {
      if (kept.has(row.task_id)) present[child.count] += 1;
      if (!fresh.has(row.task_id)) continue;
      if (child.id !== null && boardRow(db, child.to, child.id, row) !== undefined) {
        throw new Refusal('conflict', `the board holds a row of ${child.to} with the id of ledger ${child.from} row`);
      }
      // The board numbers its events and outbox rows itself: the ledger's `seq` stays behind.
      const copied = child.id === null ? Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'seq')) : row;
      inserts.push({ table: child.to, row: copied });
      imported[child.count] += 1;
    }
  }
  for (const run of ledgerTable(ledger, 'agent_runs')) {
    const found = boardRow(db, 'board_agent_runs', ['id'], run);
    if (found === undefined) {
      imported.agentRuns += 1;
      inserts.push({ table: 'board_agent_runs', row: run });
    } else if (sameColumns(run, found)) {
      present.agentRuns += 1;
    } else {
      throw new Refusal('conflict', `the board holds agent run ${String(run.id)} with other content`);
    }
  }
  return { imported, present, inserts, errandTasks };
}

/**
 * One row inserted into `table` with its own columns.
 * @param {BoardDb} db
 * @param {string} table
 * @param {Row} row
 */
function insert(db, table, row) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
    ...columns.map((column) => row[column] ?? null)
  );
}

/**
 * Opens the memory database for the import: read-only for a dry run, else under its writer lock with no migration.
 * The board must be at the engine's version.
 * @param {string} file
 * @param {boolean} dryRun
 */
function openTarget(file, dryRun) {
  if (!fs.existsSync(file)) throw new Refusal('board-unavailable', `${file} does not exist`);
  let handle;
  try {
    handle = dryRun
      ? openMemoryDb(file, { readOnly: true })
      : openMemoryDb(file, { migrations: [], boardMigrations: [] });
  } catch (error) {
    throw new Refusal('board-unavailable', error instanceof Error ? error.message : String(error));
  }
  // node:sqlite's DatabaseSync, which open.js types as `object`, has every method BoardDb names.
  const db = /** @type {BoardDb} */ (handle.db);
  const version = boardVersion(db);
  if (version !== BOARD_MIGRATIONS.length) {
    handle.close();
    throw new Refusal(
      'board-unavailable',
      `the board is at version ${version}, the engine expects ${BOARD_MIGRATIONS.length}`
    );
  }
  return { handle, db };
}

/**
 * Imports the development history of the ledger at `from` into the board of the memory database at `db` (see the head
 * of this file). Never throws for a refusal: it answers `{ ok: false, code, message }`.
 * @param {{ from: string, db: string, dryRun?: boolean }} options
 * @returns {ImportReport}
 */
export function importLedger({ from, db: file, dryRun = false }) {
  /** @type {DatabaseSync | null} */
  let ledger = null;
  /** @type {ReturnType<typeof openTarget> | null} */
  let target = null;
  try {
    ledger = openLedger(from);
    target = openTarget(file, dryRun);
    const { db, handle } = target;
    const source = ledger;
    const run = () => {
      const planned = plan(source, db);
      if (!dryRun) for (const { table, row } of planned.inserts) insert(db, table, row);
      return planned;
    };
    // open.js types `transaction` as returning any; it returns what `run` returns.
    const planned = dryRun ? run() : /** @type {ReturnType<typeof plan>} */ (handle.transaction(run));
    return {
      ok: true,
      dryRun,
      imported: planned.imported,
      present: planned.present,
      skipped: { errandTasks: planned.errandTasks },
    };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, code: error.code, message: error.message };
    throw error;
  } finally {
    target?.handle.close();
    ledger?.close();
  }
}

/**
 * The counts as one line, `tasks 3, dependencies 2, ...`.
 * @param {ImportCounts} counts
 */
const countsLine = (counts) =>
  Object.entries(counts)
    .map(([name, n]) => `${name} ${n}`)
    .join(', ');

const USAGE = 'usage: board-import.mjs --from <ledger.db> --db <memory.db> [--dry-run]';

/**
 * Runs a command line; returns the exit code.
 * @param {ReadonlyArray<string>} argv
 * @param {Io} io
 * @returns {number}
 */
export function main(argv, io = { out: (line) => console.log(line), err: (line) => console.error(line) }) {
  /** @type {Record<string, string>} */
  const paths = {};
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if ((arg === '--from' || arg === '--db') && value !== undefined && !value.startsWith('--')) {
      paths[arg.slice(2)] = value;
      i += 1;
    } else {
      io.err(USAGE);
      return 2;
    }
  }
  const { from, db } = paths;
  if (from === undefined || db === undefined) {
    io.err(USAGE);
    return 2;
  }
  const report = importLedger({ from, db, dryRun });
  if (!report.ok) {
    io.err(`${report.code}: ${report.message}`);
    return 1;
  }
  io.out(`board-import ok${report.dryRun ? ' (dry run, nothing written)' : ''}`);
  io.out(`imported: ${countsLine(report.imported)}`);
  io.out(`present: ${countsLine(report.present)}`);
  io.out(`skipped: errand tasks ${report.skipped.errandTasks}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
