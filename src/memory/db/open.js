// Opens the memory database (`data/memory.db`): node:sqlite, WAL, foreign keys on, a busy timeout, migrations by a
// `schema_version` table, `transaction(fn)`, and the single writer's lock file `<db>.lock` holding
// `{ pid, startedAt }`. Only the bot process writes; tools open `readOnly` (no lock, no migration) and the
// tools that import or sync refuse to run while a live process holds the lock. A lock of a dead pid is taken over.
//
// Node prints an ExperimentalWarning when node:sqlite loads; that one warning is dropped and every other warning
// still reaches the original listeners (the same filter as the ledger's database).

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { MIGRATIONS, finishDiaryDestination, finishDiaryMirror } from './schema.js';
import { importWakeQueues } from './wake-queue.ts';

const originalListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning?.name === 'ExperimentalWarning' && /SQLite/i.test(String(warning.message))) return;
  for (const listener of originalListeners) listener(warning);
});
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

export { MIGRATIONS };

/** The path of a database's writer lock. */
export const lockPathOf = (dbPath) => `${dbPath}.lock`;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLock(file) {
  try {
    const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
    return lock && typeof lock === 'object' ? lock : null;
  } catch {
    return null;
  }
}

/**
 * Takes the writer lock. A live holder refuses with an error naming its pid and start time; a dead holder's lock
 * (or an unreadable one) is replaced.
 * @returns {() => void} release (removes the lock only while it is still ours)
 */
export function acquireLock(dbPath, { pid = process.pid, now = Date.now, alive = pidAlive } = {}) {
  const file = lockPathOf(dbPath);
  const held = fs.existsSync(file) ? readLock(file) : null;
  if (held && alive(held.pid)) {
    throw new Error(`memory db ${dbPath} is locked by pid ${held.pid} (since ${held.startedAt ?? 'unknown'})`);
  }
  fs.writeFileSync(file, JSON.stringify({ pid, startedAt: new Date(now()).toISOString() }));
  return () => {
    const current = readLock(file);
    if (current?.pid === pid) fs.rmSync(file, { force: true });
  };
}

/** The version the database is at (0 for a new file). */
export function schemaVersion(db) {
  const table = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
  if (!table) return 0;
  return db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v ?? 0;
}

/**
 * Applies every migration above the current version, in one transaction. An entry is SQL text or a function of the
 * connection and `context` (what only the opener knows: `diaryPlaceId`, the deployment's diary channel, for v12 and
 * v15, and `dataDir`, the data directory, for v18). A data step v12, v15 or v18 could not finish without the context
 * is finished by the first open that has it.
 */
export function migrate(db, migrations = MIGRATIONS, context = {}) {
  inTransaction(db, () => {
    db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    let version = schemaVersion(db);
    while (version < migrations.length) {
      const step = migrations[version];
      if (typeof step === 'function') step(db, context);
      else db.exec(step);
      version += 1;
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
    }
    if (migrations === MIGRATIONS && schemaVersion(db) >= MIGRATIONS.length) {
      finishDiaryDestination(db, context);
      finishDiaryMirror(db, context);
      importWakeQueues(db, context);
    }
  });
}

/** BEGIN IMMEDIATE .. COMMIT; a throw rolls back and rethrows. */
export function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw error;
  }
}

/**
 * Opens a memory database.
 * @param {string} dbPath  A file path, or ':memory:' (no lock, no file).
 * @param {{ readOnly?: boolean, migrations?: Array<string | ((db: never, context: never) => void)>, pid?: number, now?: () => number, alive?: (pid: number) => boolean,
 *   context?: { diaryPlaceId?: string|null, dataDir?: string } }} [opts]  `context`: what a migration step needs from the opener (migrate)
 * @returns {{ db: object, path: string, readOnly: boolean, transaction: (fn: () => any) => any, close: () => void }}
 */
export function openMemoryDb(dbPath, opts = {}) {
  const readOnly = opts.readOnly === true;
  const memory = dbPath === ':memory:';
  let release = () => {};
  if (!readOnly && !memory) release = acquireLock(dbPath, opts);
  let db;
  try {
    db = new DatabaseSync(dbPath, readOnly ? { readOnly: true } : {});
    if (!readOnly) {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
    }
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    if (!readOnly) migrate(db, opts.migrations ?? MIGRATIONS, opts.context ?? {});
  } catch (error) {
    try {
      db?.close();
    } catch {
      /* not open */
    }
    release();
    throw error;
  }
  let closed = false;
  return {
    db,
    path: dbPath,
    readOnly,
    transaction(fn) {
      if (readOnly) throw new Error('memory db is open read-only');
      return inTransaction(db, fn);
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } finally {
        release();
      }
    },
  };
}
