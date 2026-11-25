// Typing helpers for the tests that feed a function what its types forbid or read a value its types hide: a raw SQL
// connection (`openMemoryDb` types `handle.db` as `object`) and an input of the wrong type, passed on purpose to check
// that the function tolerates it.
import type { Untyped } from '../../src/tools/types.ts';

type Statement = {
  all(...args: Array<unknown>): Array<Record<string, Untyped>>;
  get(...args: Array<unknown>): Record<string, Untyped>;
  run(...args: Array<unknown>): unknown;
};
export type UntypedDb = { prepare(sql: string): Statement; exec(sql: string): void };

/** The `node:sqlite` connection of a handle, typed for prepare, all, get, run and exec. */
export function sqlOf(handle: { db: object }): UntypedDb {
  // The handle's `db` is a node:sqlite DatabaseSync, and these tests call nothing else on it.
  return handle.db as UntypedDb;
}

/** An input of the wrong type that a test passes on purpose; the parameter it lands in gives `T`. */
export function wrongly<T>(value: unknown): T {
  // The test checks the function's tolerance of this value, so the type the compiler wants is the one thing to bypass.
  return value as T;
}

/** A value the code under test promised to return, narrowed for the compiler; a missing one fails the test at once. */
export function present<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) {
    throw new Error(`the code under test returned no ${what}; the test needs it`);
  }
  return value;
}

/** Removes a property the type calls required, as a test does to hand the code a record that lacks it. */
export function removeField(target: object, key: string): void {
  // The property is required by the type; the test deletes it on purpose, so the compiler's view is the thing to bypass.
  delete (target as Record<string, unknown>)[key];
}

/** The rows of a table of cases, each kept as a tuple, so `for (const [label, run] of table([...]))` types each column. */
export function table<T extends Array<unknown> | []>(rows: Array<T>): Array<T> {
  return rows;
}
