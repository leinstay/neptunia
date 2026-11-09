// The shapes the files of the memory database share: a row as node:sqlite hands it back, the connection narrowed to
// what this folder calls, and the handle `openMemoryDb` returns, with the two functions that take a connection out
// of either. Every file here imports them instead of declaring its own copy.

import type { BoardStatus } from '../../board/schema.ts';

/** A row of a query, or a JSON object read from a file: the keys are known where the code reads them. */
export type Row = Record<string, unknown>;

/** What `run` reports: the rows it changed and, after an INSERT, the id of the last one. */
export type RunResult = { changes: number | bigint; lastInsertRowid: number | bigint };

/** A prepared statement, as node:sqlite's `StatementSync` offers the calls this folder makes. */
export type Statement = {
  get(...params: Array<unknown>): Row | undefined;
  all(...params: Array<unknown>): Array<Row>;
  run(...params: Array<unknown>): RunResult;
  iterate(...params: Array<unknown>): IterableIterator<Row>;
};

/** A connection of the memory database: node:sqlite's `DatabaseSync` has every method named here. */
export type Db = {
  prepare(sql: string): Statement;
  exec(sql: string): void;
};

/**
 * What `openMemoryDb` returns. `db` is the open connection (node:sqlite's `DatabaseSync`), kept opaque so a caller
 * narrows it to the type it needs; this folder reads it through `dbOf`.
 */
export type MemoryHandle = {
  db: object;
  path: string;
  readOnly: boolean;
  board: BoardStatus;
  transaction<TResult>(fn: () => TResult): TResult;
  close(): void;
};

/** The rows of one unit or one mapping, by table. */
export type Rows = Record<string, Array<Row & { id?: string }>>;

/** A function that takes a connection takes the handle `openMemoryDb` returns, the raw connection, or a holder of it. */
export type Connection = MemoryHandle | Db | { db: unknown };

/** The raw connection of a handle, or the connection itself. */
export function dbOf(source: Connection): Db {
  // `MemoryHandle.db` is a `DatabaseSync`, which has every method `Db` names.
  return 'db' in source ? (source.db as Db) : source;
}

/** The handle's `transaction`, or a plain call when the connection is already inside the caller's transaction. */
export function transactionOf(source: Connection): <TResult>(fn: () => TResult) => TResult {
  return 'transaction' in source ? (fn) => source.transaction(fn) : (fn) => fn();
}

/** The engine's logger, as this folder calls it: counts and codes only, never a text. */
export type Log = {
  info(message: string, fields?: Row): void;
  warn(message: string, fields?: Row): void;
  error(message: string, fields?: Row): void;
  debug?(message: string, fields?: Row): void;
};

/** The settings these files read. Every key may be missing or hold anything, and each reader checks what it takes. */
export type Config = {
  bot?: { timezone?: unknown; ownerPerson?: unknown };
  selfreflection?: { placeId?: unknown };
  focus?: Row | null;
  wakes?: { loop?: { timeBudgetMs?: unknown } };
  llm?: { maxRequestTokens?: unknown; keyByRole?: Row };
  memoryDb?: { file?: unknown; closeTimeoutMs?: unknown; session?: Row; [key: string]: unknown };
  recall?: { db?: Row; [key: string]: unknown };
  [section: string]: unknown;
};

/** The text `${value}` and `String(value)` give for the values these files hold: the one place that coercion is stated. */
export function asText(value: unknown): string {
  return `${value as string}`; // coerced as any template interpolation is
}

/** A number that is neither NaN nor infinite: `Number.isFinite`, narrowing the type. */
export const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A whole number: `Number.isInteger`, narrowing the type. */
export const isWholeNumber = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
