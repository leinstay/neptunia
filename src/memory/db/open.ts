// Opens the memory database (`data/memory.db`): node:sqlite, WAL, foreign keys on, a busy timeout, migrations by a
// `schema_version` table, `transaction(fn)`, and the single writer's lock file `<db>.lock` holding
// `{ pid, startedAt }`. After the memory migrations the task board's own migrations run in a transaction of their own
// (src/board/schema.ts), so a board that fails to migrate is down while her memory stays open and writable. Only the bot process writes; tools open `readOnly` (no lock, no migration) and the
// tools that import or sync refuse to run while a live process holds the lock. A lock of a dead pid is taken over.
//
// Node prints an ExperimentalWarning when node:sqlite loads; that one warning is dropped and every other warning
// still reaches the original listeners (the same filter as the ledger's database).

import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncClass } from 'node:sqlite';
import { MIGRATIONS, finishDiaryDestination, finishDiaryMirror } from './schema.ts';
import type { Migration, MigrationContext } from './schema.ts';
import { ALIVE_LEASE, importWakeQueues, leaseOf } from './wake-queue.ts';
import { BOARD_MIGRATIONS, boardVersion, migrateBoard } from '../../board/schema.ts';
import type { BoardDb, BoardStatus } from '../../board/schema.ts';
import type { Db, MemoryHandle } from './types.ts';

const originalListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning: Error) => {
  if (warning?.name === 'ExperimentalWarning' && /SQLite/i.test(String(warning.message))) return;
  for (const listener of originalListeners) listener(warning);
});
// Loaded through require so the warning filter above is in place before the module loads.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncClass };

export { MIGRATIONS };

/** The path of a database's writer lock. */
export const lockPathOf = (dbPath: string): string => `${dbPath}.lock`;

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'EPERM';
  }
}

type Lock = { pid?: number; startedAt?: string };

function readLock(file: string): Lock | null {
  try {
    const lock: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return lock && typeof lock === 'object' ? lock : null;
  } catch {
    return null;
  }
}

/** The options of the lock functions: the process that takes it, the clock and the check of a holder's pid. */
export type LockOptions = { pid?: number; now?: () => number; alive?: (pid: unknown) => boolean };

/**
 * Takes the writer lock. A live holder refuses with an error naming its pid and start time; a dead holder's lock
 * (or an unreadable one) is replaced. Returns `release`, which removes the lock only while it is still ours.
 */
export function acquireLock(
  dbPath: string,
  { pid = process.pid, now = Date.now, alive = pidAlive }: LockOptions = {}
): () => void {
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

/**
 * The claim of one core on the database at `dbPath`, taken at the core's start before it touches its socket. It takes
 * the writer lock, so a live holder refuses it (`locked`). Then it reads the `core:alive` lease: while another holder's
 * renewal is within its ttl at `now()`, it lets the lock go and refuses with `core-running`. A lock left by a process
 * that is gone means that core crashed, so its lease, fresh as it may be, is no longer anyone's and the start goes on.
 * Returns `release`, which removes the lock only while it is still ours.
 */
export function claimCore(
  dbPath: string,
  { pid = process.pid, now = Date.now, alive = pidAlive }: LockOptions = {}
): () => void {
  const file = lockPathOf(dbPath);
  const held = fs.existsSync(file) ? readLock(file) : null;
  const crashed = held !== null && !alive(Number(held.pid));
  const release = acquireLock(dbPath, { pid, now, alive });
  if (crashed || !fs.existsSync(dbPath)) return release;
  const lease = aliveLeaseOf(dbPath);
  const at = now();
  if (lease !== null && lease.expiresAt > at) {
    release();
    throw new Error(
      `core-running: another core renewed core:alive at ${new Date(lease.renewedAt).toISOString()}, ` +
        `valid until ${new Date(lease.expiresAt).toISOString()}; stop it first`
    );
  }
  return release;
}

/** The `core:alive` lease of the database at `dbPath`, read without a lock; null when there is none to read. */
function aliveLeaseOf(dbPath: string): ReturnType<typeof leaseOf> {
  let handle: MemoryHandle | null = null;
  try {
    handle = openMemoryDb(dbPath, { readOnly: true });
    return leaseOf(handle, ALIVE_LEASE);
  } catch {
    // A database before the leases table (schema v18), or one that cannot be read: no core renewed a lease in it.
    return null;
  } finally {
    handle?.close();
  }
}

/** The version the database is at (0 for a new file). */
export function schemaVersion(dbGiven: unknown): number {
  const db = dbGiven as Db;
  const table = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
  if (!table) return 0;
  return Number(db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v ?? 0);
}

/**
 * Applies every migration above the current version, in one transaction. An entry is SQL text or a function of the
 * connection and `context` (what only the opener knows: `diaryPlaceId`, the deployment's diary channel, for v12 and
 * v15, and `dataDir`, the data directory, for v18). A data step v12, v15 or v18 could not finish without the context
 * is finished by the first open that has it.
 */
export function migrate(
  dbGiven: unknown,
  migrations: ReadonlyArray<Migration> = MIGRATIONS,
  context: MigrationContext = {}
): void {
  const db = dbGiven as Db;
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
export function inTransaction<TResult>(dbGiven: unknown, fn: () => TResult): TResult {
  const db = dbGiven as Db;
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

/** The board's status as a read-only open finds it: up when it is at the version of `migrations`. */
function boardStatusOf(db: BoardDb, migrations: ReadonlyArray<string>): BoardStatus {
  const version = boardVersion(db);
  return version === migrations.length
    ? { ok: true, version }
    : { ok: false, version, error: `the board is at version ${version}, the engine expects ${migrations.length}` };
}

/**
 * The options of `openMemoryDb`. `context` is what a migration step needs from the opener (see `migrate`);
 * `boardMigrations` replaces the board's list (default `BOARD_MIGRATIONS`), as `migrations` does the memory's.
 */
export type OpenOptions = LockOptions & {
  readOnly?: boolean;
  migrations?: ReadonlyArray<Migration>;
  boardMigrations?: ReadonlyArray<string>;
  context?: MigrationContext;
};

/**
 * Opens a memory database. `dbPath` is a file path, or ':memory:' (no lock, no file). The handle's `board` is the
 * board's migration status (a read-only open migrates nothing and reports the board down when it is not at the
 * expected version).
 */
export function openMemoryDb(dbPathGiven: unknown, opts: OpenOptions = {}): MemoryHandle {
  const dbPath = dbPathGiven as string;
  const readOnly = opts.readOnly === true;
  const memory = dbPath === ':memory:';
  let release = (): void => {};
  if (!readOnly && !memory) release = acquireLock(dbPath, opts);
  let db: InstanceType<typeof DatabaseSync> | undefined;
  let board: BoardStatus = { ok: false, version: 0, error: 'not opened' };
  try {
    db = new DatabaseSync(dbPath, readOnly ? { readOnly: true } : {});
    if (!readOnly) {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
    }
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    if (!readOnly) migrate(db, opts.migrations ?? MIGRATIONS, opts.context ?? {});
    const boardMigrations = opts.boardMigrations ?? BOARD_MIGRATIONS;
    board = readOnly ? boardStatusOf(db, boardMigrations) : migrateBoard(db, boardMigrations);
  } catch (error) {
    try {
      db?.close();
    } catch {
      /* not open */
    }
    release();
    throw error;
  }
  const open = db;
  let closed = false;
  return {
    db: open,
    path: dbPath,
    readOnly,
    board,
    transaction<TResult>(fn: () => TResult): TResult {
      if (readOnly) throw new Error('memory db is open read-only');
      return inTransaction(open, fn);
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        open.close();
      } finally {
        release();
      }
    },
  };
}
