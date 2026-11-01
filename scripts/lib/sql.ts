// The SQLite connection of a memory handle, typed the way the scripts that read the database use it. The memory
// writer's `MemoryHandle` declares `db` as `object`; `openMemoryDb` always opens a node:sqlite connection, and the
// scripts call only these methods on it. Used by scripts/memory-db.ts and scripts/memory-session.ts.

import type { Untyped } from '../../src/tools/types.ts';

/** A prepared statement: its row values stay untyped, as the SQL text decides them. */
export type SqlStatement = {
  get<Row = Untyped>(...params: Array<Untyped>): Row | undefined;
  all<Row = Untyped>(...params: Array<Untyped>): Array<Row>;
  run(...params: Array<Untyped>): Untyped;
  iterate(...params: Array<Untyped>): IterableIterator<Untyped>;
};

/** The connection methods the scripts call. */
export type SqlDb = { prepare(sql: string): SqlStatement; exec(sql: string): void };

/** The connection of `handle`. */
export function sqlOf(handle: { db: object }): SqlDb {
  return handle.db as SqlDb; // see the file comment: `db` is a node:sqlite connection
}
