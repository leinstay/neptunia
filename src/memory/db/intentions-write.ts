// Her intentions in the memory database: one `intentions` row per record, written by the write kind `intentions`
// (session-write.ts) from the intention store (src/intentions/store.ts). Op `value` stores the whole list: each record
// at its position with `archived` 0, and a listed record that was archived comes back to the list. A live row of the
// list that the value no longer names is retired. Op `archive` appends the records the store moved out of the list,
// each with `archived` 1 at the next position of the archive. The `record` column holds the record verbatim and is the
// authority; `status`, `due_ms`, `created_ms`, `updated_ms` and the scope are copies of its fields for queries. The
// scope is the record's `provenance.scope` with its participants (map/scope-string.ts). Each written row is projected
// into the graph in the same transaction. The readers are in readers/intentions.ts.

import { projectRow } from './graph.ts';
import { stringScope } from './map/scope-string.ts';
import { dmOfPlatformId } from './meta-person.ts';
import { deriveRow } from './rows.ts';
import { dbOf, isFiniteNumber } from './types.ts';
import type { Db, MemoryHandle, Row } from './types.ts';

/** One write of the kind: the whole list, or records moved to the archive. */
export type IntentionsWrite =
  { op: 'value'; intentions: ReadonlyArray<Row> } | { op: 'archive'; records: ReadonlyArray<Row> };

const coded = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const num = (value: unknown): number | null => (isFiniteNumber(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const isRecord = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The records of a write, each a record with an id, else `INTENTIONS_RECORD`. */
function recordsOf(given: unknown): Array<Row> {
  const list = Array.isArray(given) ? (given as Array<unknown>) : [];
  return list.map((record) => {
    if (!isRecord(record) || typeof record.id !== 'string' || record.id === '') throw coded('INTENTIONS_RECORD');
    return record;
  });
}

/** A write as the writer receives it, checked. */
export function intentionsWriteOf(update: Row): IntentionsWrite {
  if (update.op === 'value') return { op: 'value', intentions: recordsOf(update.intentions) };
  if (update.op === 'archive') return { op: 'archive', records: recordsOf(update.records) };
  throw coded('INTENTIONS_OP');
}

/** The row of a record at a position. */
function rowOf(db: Db, record: Row, position: number, archived: boolean): Row {
  const provenance = isRecord(record.provenance) ? record.provenance : {};
  const people = Array.isArray(provenance.participants) ? (provenance.participants as Array<unknown>) : undefined;
  return {
    id: record.id,
    record: JSON.stringify(record),
    status: text(record.status),
    due_ms: num(record.dueAt),
    created_ms: num(record.createdAt),
    updated_ms: num(record.updatedAt),
    ...stringScope(provenance.scope, people, undefined, {
      dmOfMember: (iface, platformId) => dmOfPlatformId(db, iface, platformId),
    }),
    archived: archived ? 1 : 0,
    position,
    retired_at: null,
  };
}

/** The columns of `intentions` by connection: a database of an older version, which a seed of old files writes, lacks the later ones. */
const COLUMNS = new WeakMap<Db, Set<unknown>>();
/** The upsert of a column list by connection, prepared once. */
const UPSERTS = new WeakMap<Db, Map<string, ReturnType<Db['prepare']>>>();

function upsertOf(db: Db, cols: ReadonlyArray<string>): ReturnType<Db['prepare']> {
  let byCols = UPSERTS.get(db);
  if (!byCols) UPSERTS.set(db, (byCols = new Map<string, ReturnType<Db['prepare']>>()));
  const name = cols.join(',');
  let statement = byCols.get(name);
  if (!statement) {
    statement = db.prepare(
      `INSERT INTO intentions (${cols.map((col) => `"${col}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
       ON CONFLICT(id) DO UPDATE SET ${cols
         .filter((col) => col !== 'id')
         .map((col) => `"${col}" = excluded."${col}"`)
         .join(', ')}`
    );
    byCols.set(name, statement);
  }
  return statement;
}

/** Inserts a row, or updates the columns it names when its id is stored; the graph follows. */
function writeRow(db: Db, row: Row, at: string): void {
  const derived = deriveRow(db, 'intentions', row);
  let have = COLUMNS.get(db);
  if (!have) {
    have = new Set(
      db
        .prepare('PRAGMA table_info(intentions)')
        .all()
        .map((column) => column.name)
    );
    COLUMNS.set(db, have);
  }
  const cols = Object.keys(derived).filter((col) => have.has(col));
  upsertOf(db, cols).run(...cols.map((col) => derived[col] ?? null));
  projectRow(db, 'intentions', derived, { at });
}

/** Stores one checked write inside the caller's transaction; returns how many rows it wrote and retired. */
export function writeIntentions(db: Db, write: IntentionsWrite, at: string): { written: number; retired: number } {
  if (write.op === 'archive') {
    const top = db.prepare('SELECT MAX(position) AS p FROM intentions WHERE archived = 1').get()?.p;
    let position = typeof top === 'number' ? top + 1 : 0;
    for (const record of write.records) writeRow(db, rowOf(db, record, position++, true), at);
    return { written: write.records.length, retired: 0 };
  }
  write.intentions.forEach((record, position) => writeRow(db, rowOf(db, record, position, false), at));
  const named = new Set(write.intentions.map((record) => record.id));
  let retired = 0;
  const retire = db.prepare('UPDATE intentions SET retired_at = ? WHERE id = ?');
  for (const row of db.prepare('SELECT id FROM intentions WHERE archived = 0 AND retired_at IS NULL').all()) {
    if (named.has(row.id)) continue;
    retire.run(at, row.id);
    projectRow(db, 'intentions', { id: row.id }, { at });
    retired += 1;
  }
  return { written: write.intentions.length, retired };
}

/** The write kind `intentions` on the writer connection (session-write.ts). */
export function applyIntentionsWrite(handle: MemoryHandle, update: Row): { written: number; retired: number } {
  const write = intentionsWriteOf(update);
  const at = new Date(isFiniteNumber(update.now) ? update.now : Date.now()).toISOString();
  return handle.transaction(() => writeIntentions(dbOf(handle), write, at));
}

/** The intentions write a unit write of the intention units carries, or null for any other unit. */
export function intentionsOfUnit(update: Row): IntentionsWrite | null {
  const key = update.key as { kind?: unknown; selector?: { collection?: unknown } } | undefined;
  if (key?.kind !== 'intentions') return null;
  if (key.selector?.collection === 'archive') return intentionsWriteOf({ op: 'archive', records: update.lines });
  const value = isRecord(update.value) ? update.value : {};
  return intentionsWriteOf({ op: 'value', intentions: value.intentions });
}

/**
 * Schema version 44 (schema.ts): the intention rows leave their units. Every row loses `owner_key`, the `operational`
 * remainder of the list goes, and the units of the intentions are retired. The list and the archive are found by
 * `archived` and `position`, which an index serves.
 */
export function moveIntentionOwners(db: Db): void {
  db.exec('CREATE INDEX IF NOT EXISTS intentions_list ON intentions(archived, position)');
  db.exec('UPDATE intentions SET owner_key = NULL WHERE owner_key IS NOT NULL');
  db.exec("DELETE FROM operational WHERE kind = 'intentions'");
  db.prepare("UPDATE storage_units SET retired_at = ? WHERE kind = 'intentions' AND retired_at IS NULL").run(
    new Date().toISOString()
  );
}
