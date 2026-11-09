import { createReadSeam } from './db/readers/seam.ts';
import type { LineVectorsWrite } from './db/line-vectors.ts';
import type { RecordLinesWrite } from './db/record-lines.ts';
import type { OperationalWrite } from './db/operational.ts';
import type { MemoryHandle, Row } from './db/types.ts';
// The shapes the memory modules share: the live settings handle a module reads at the moment of use, and the logger
// it reports counts and names to. A module's own data types live in that module.

/** JSON read from a config, a file or the database: its fields are checked where they are read. */
export type Untyped = ReturnType<typeof JSON.parse>;

/** A record of unknown values. */
export type Obj = Record<string, unknown>;

/** Whether `value` is a record: an object that is not null and not an array. */
export function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The hot view of `config.json` and the prompt files: read at the moment of use, never cached. */
export type Hot = { readonly config: Record<string, Untyped>; readonly prompts: Record<string, Untyped> };

/** The structured logger (src/log.js): messages are `module: event`, fields carry counts and names. */
export type Log = {
  info: (message: string, fields?: Obj) => void;
  warn: (message: string, fields?: Obj) => void;
  error: (message: string, fields?: Obj) => void;
};

/** The field `key` of a caught value, or undefined when the value has none: a catch binding is `unknown`. */
export function propOf(value: unknown, key: string): unknown {
  return isObj(value) ? value[key] : undefined;
}

/** `Number.isFinite` as a type guard: a settings value or a stored field is `unknown` until it passes. */
export function isFiniteNumber(value: unknown): value is number {
  return Number.isFinite(value);
}

/** `Number.isInteger` as a type guard. */
export function isIntegerNumber(value: unknown): value is number {
  return Number.isInteger(value);
}

/** A stored record whose fields are read one by one after their own checks: `isObj` with untyped fields. */
export function isRecord(value: unknown): value is Record<string, Untyped> {
  return isObj(value);
}

/** A stored object whose fields are read one by one: a value from a JSON file or the database, untyped inside. */
export type StoredRecord = Record<string, Untyped>;

/** The memory database service (src/memory/db/service.ts) as the memory modules call it. */
export type MemoryDb = {
  namespace?: () => string | null;
  readHandle?: () => MemoryHandle | null;
  writeUnit?: (update: unknown) => Promise<unknown>;
  writeOperational?: (write: OperationalWrite) => Promise<unknown>;
  writeLineVectors?: (write: LineVectorsWrite) => Promise<unknown>;
  writeRecordLines?: (write: RecordLinesWrite) => Promise<unknown>;
  memoryWrite?: (update: unknown) => Promise<unknown>;
  keepPending?: (update: unknown) => string;
  onAffinityMoves?: (listener: (moves: Array<Row>) => void) => () => void;
};

/** Whether the database can take a unit write: the outbox of a store or a journal exists only then. */
export function canWriteUnits(db: MemoryDb | null | undefined): db is MemoryDb & Required<Pick<MemoryDb, 'writeUnit'>> {
  return typeof db?.writeUnit === 'function';
}

/** The read seam of one memory module over its database (`reader` names the module in the log). */
export function readSeamOf(
  memoryDb: MemoryDb | null | undefined,
  log: Pick<Log, 'warn'>,
  reader: string
): ReturnType<typeof createReadSeam> {
  return createReadSeam({ memoryDb, log, reader });
}
