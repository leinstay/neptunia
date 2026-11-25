// The read seam of one module over the memory database: `db()` the read connection, `run(fn)` the function with its failure
// logged once with a code. No import beyond types, because src/memory/types.ts reads it and every module reads that.

import type { Db, Log } from '../types.ts';

function codedError(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * The seam of one module (see the head of this file): `db()` is the read connection, `run(fn)` is `fn()` with its
 * failure logged once with a code.
 */
export function createReadSeam({
  memoryDb = null,
  log,
  reader,
}: {
  memoryDb?: { readHandle?: () => { db: object } | null } | null;
  log: Pick<Log, 'warn'>;
  reader: string;
}): { db(): Db; run<TResult>(fn: () => TResult): TResult } {
  type Failure = Error & { code?: string; memoryDbLogged?: boolean };
  function failed(error: unknown): Failure {
    const out: Failure = error instanceof Error ? error : codedError('DB_READ_FAILED');
    if (!out.code) out.code = 'DB_READ_FAILED';
    if (!out.memoryDbLogged) {
      out.memoryDbLogged = true;
      log.warn('memory db: read failed', { reader, code: out.code });
    }
    return out;
  }

  /** The read connection, else throws `DB_CLOSED`. */
  function db(): Db {
    const handle = memoryDb?.readHandle?.() ?? null;
    if (!handle?.db) throw failed(codedError('DB_CLOSED', 'memory db is not open'));
    return handle.db as Db;
  }

  /** `fn()`, its failure logged with a code and thrown again. */
  function run<TResult>(fn: () => TResult): TResult {
    try {
      return fn();
    } catch (error) {
      throw failed(error);
    }
  }

  return { db, run };
}
