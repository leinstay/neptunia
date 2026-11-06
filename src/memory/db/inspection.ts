// The owner's exhaustive storage catalog and row reader. The connection defines what exists, so a table nobody registered is
// still listed and readable, and every row stays reachable: retired, internal, unowned, keyless and derived rows alike. A
// name reaches SQL only after the catalog has seen it, quoted, and every value is bound. Reading writes nothing, so it runs
// over a read-only connection and leaves `node_access` and `turn_reads` as they are. src/memory/db/inspection-snapshots.ts
// holds these reads still for the owner, and src/interface/commands/memory.ts answers them.
//
// Rows page by key: the rowid, or the primary key of a WITHOUT ROWID table. A table whose every rowid alias is shadowed by
// a column has neither, and reads by position, which holds still only inside one snapshot.

import { boardVersion } from '../../board/schema.ts';
import { storageClassOf } from './inspection-classes.ts';
import type { StorageClass } from './inspection-classes.ts';
import { inspectionValueOf, isInspectionValue, sqlValueOf } from './inspection-values.ts';
import type { InspectionValue } from './inspection-values.ts';
import { schemaVersion } from './open.ts';
import { checkLimit, coded, cursorOf, positionOf } from './read-page.ts';
import type { Page } from './read-page.ts';
import type { Db, Row, Statement } from './types.ts';

export type { Page } from './read-page.ts';

/** How much of a value one read answers: well inside a protocol frame after base64 or JSON escapes. */
export const VALUE_CHUNK_BYTES = 1024 * 1024;

export type RowLocator =
  | { kind: 'primary'; values: Array<{ column: string; value: InspectionValue }> }
  | { kind: 'rowid'; alias: string; value: string }
  | { kind: 'snapshot-position'; snapshot: string; position: string };
export type InspectionColumn = {
  name: string;
  declaredType: string;
  primaryOrder: number;
  isNullable: boolean;
  hiddenKind: number;
};
export type InspectionTable = {
  name: string;
  kind: 'table' | 'virtual' | 'shadow' | 'sqlite';
  storageClass: StorageClass;
  ddl: string | null;
  columns: Array<InspectionColumn>;
  foreignKeys: Array<Row>;
  indexes: Array<Row>;
  triggers: Array<Row>;
};
export type InspectionCatalog = {
  memoryVersion: number;
  boardVersion: number;
  tables: Array<InspectionTable>;
  objects: Array<Row>;
};
/** What a shortened cell leaves out, and the offset of the rest in the encoded original value. */
export type CellExcerpt = { totalBytes: number; remainingBytes: number; nextOffset: number };
/**
 * One cell. `excerpt` says a page shortened it. `exactBytes` is the base64 of a stored text that is not valid UTF-8, whose
 * `value` can only show replacement characters.
 */
export type InspectionCell = { column: string; value: InspectionValue; excerpt?: CellExcerpt; exactBytes?: string };
export type InspectionRow = { locator: RowLocator; values: Array<InspectionCell> };
export type InspectionRead = {
  table: string;
  filters: Array<{ column: string; value: InspectionValue }>;
  limit: number;
  cursor: string | null;
};
export type InspectionPage = Page<InspectionRow>;
export type InspectionValueRead = { table: string; locator: RowLocator; column: string; offset: number };
export type InspectionValueChunk = {
  valueKind: 'text' | 'blob';
  encoding: 'utf8' | 'base64';
  value: string;
  nextOffset: number | null;
  totalBytes: number;
};

/** How a snapshot reads rows: the moment a page and a cursor name, and how long a cell may be. */
export type RowReadOptions = { snapshot?: string; excerptBytes?: number | null };

const RAW_SCHEMA_TABLE = 'sqlite_schema';
const ROWID_ALIASES = ['rowid', '_rowid_', 'oid'];
const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const exact = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const lenient = new TextDecoder('utf-8', { ignoreBOM: true });

/** A statement that hands integers over as bigints, so a 64-bit integer keeps every digit and a REAL stays a number. */
function exactStatement(db: Db, sql: string): Statement {
  // Every connection here is a node:sqlite `DatabaseSync`, whose statements take this switch.
  const statement = db.prepare(sql) as Statement & { setReadBigInts(enabled: boolean): unknown };
  statement.setReadBigInts(true);
  return statement;
}

type TableShape = {
  name: string;
  kind: InspectionTable['kind'];
  columns: Array<InspectionColumn>;
  visible: Array<string>;
  key: Array<string>;
  rowidAlias: string | null;
  withoutRowid: boolean;
};

function columnsOf(db: Db, table: string): Array<InspectionColumn> {
  return db
    .prepare('SELECT * FROM pragma_table_xinfo(?)')
    .all(table)
    .map((column) => ({
      name: String(column.name),
      declaredType: String(column.type),
      primaryOrder: Number(column.pk),
      isNullable: column.notnull === 0,
      hiddenKind: Number(column.hidden),
    }));
}

const kindFrom = (name: string, listed: unknown): InspectionTable['kind'] => {
  if (name.startsWith('sqlite_')) return 'sqlite';
  return listed === 'virtual' || listed === 'shadow' ? listed : 'table';
};

/** The shape of a table the connection holds; a name it does not is refused before any SQL is built from it. */
function shapeOf(db: Db, table: string): TableShape {
  const known =
    table === RAW_SCHEMA_TABLE ||
    db.prepare("SELECT 1 AS ok FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) !== undefined;
  if (!known) throw coded('INSPECTION_UNKNOWN_TABLE', 'no such table');
  const listed = db.prepare("SELECT type, wr FROM pragma_table_list WHERE schema = 'main' AND name = ?").get(table);
  const columns = columnsOf(db, table);
  const taken = new Set(columns.map((column) => column.name.toLowerCase()));
  const withoutRowid = listed?.wr === 1;
  return {
    name: table,
    kind: kindFrom(table, listed?.type),
    columns,
    // A generated column is in `SELECT *`; only a virtual table's hidden columns are not.
    visible: columns.filter((column) => column.hiddenKind !== 1).map((column) => column.name),
    key: columns
      .filter((column) => column.primaryOrder > 0)
      .sort((a, b) => a.primaryOrder - b.primaryOrder)
      .map((column) => column.name),
    rowidAlias: withoutRowid ? null : (ROWID_ALIASES.find((alias) => !taken.has(alias)) ?? null),
    withoutRowid,
  };
}

/** Every table and schema object of the connection, as SQLite lists them. */
export function catalog(db: Db): InspectionCatalog {
  const names = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row.name));
  const copies = (rows: ReadonlyArray<Row>): Array<Row> => rows.map((row) => ({ ...row }));
  const tables = names.map((name): InspectionTable => {
    const { kind, columns } = shapeOf(db, name);
    const ddl = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name)?.sql;
    return {
      name,
      kind,
      storageClass: storageClassOf(name, kind),
      ddl: typeof ddl === 'string' ? ddl : null,
      columns,
      foreignKeys: copies(db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(name)),
      indexes: copies(db.prepare('SELECT * FROM pragma_index_list(?)').all(name)),
      triggers: copies(
        db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?").all(name)
      ),
    };
  });
  return {
    memoryVersion: schemaVersion(db),
    boardVersion: boardVersion(db),
    tables,
    objects: copies(db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all()),
  };
}

/** The typed value of what a statement of `exactStatement` hands over. */
function cellValue(raw: unknown): InspectionValue {
  if (raw === null || raw === undefined) return inspectionValueOf('null', null);
  if (typeof raw === 'bigint') return inspectionValueOf('integer', raw);
  if (typeof raw === 'number') return inspectionValueOf('real', raw);
  if (typeof raw === 'string') return inspectionValueOf('text', raw);
  return inspectionValueOf('blob', raw);
}

/** The length of `prefix` without a last character the cut left unfinished. */
function boundaryInPrefix(prefix: Uint8Array): number {
  for (let back = 1; back <= 4 && back <= prefix.length; back += 1) {
    const byte = prefix[prefix.length - back] ?? 0;
    if ((byte & 0xc0) === 0x80) continue;
    const size = byte < 0x80 ? 1 : byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
    return back < size ? prefix.length - back : prefix.length;
  }
  return prefix.length;
}

/** The select of a row: each cell as `c<n>`, shortened past `excerptBytes` with its class and length in `x<n>`, the key and rowid. */
function selectList(shape: TableShape, excerptBytes: number | null): string {
  const parts = shape.visible.flatMap((column, index) => {
    const name = quoted(column);
    if (excerptBytes === null) return [`${name} AS "c${index}"`];
    const long = `typeof(${name}) IN ('text', 'blob') AND length(CAST(${name} AS BLOB)) > ${excerptBytes}`;
    return [
      `CASE WHEN ${long} THEN substr(CAST(${name} AS BLOB), 1, ${excerptBytes}) ELSE ${name} END AS "c${index}"`,
      `CASE WHEN ${long} THEN typeof(${name}) || ':' || length(CAST(${name} AS BLOB)) END AS "x${index}"`,
    ];
  });
  shape.key.forEach((column, index) => parts.push(`${quoted(column)} AS "k${index}"`));
  if (shape.rowidAlias !== null) parts.push(`${shape.rowidAlias} AS "rid"`);
  return parts.join(', ');
}

function cellOf(row: Row, column: string, index: number): InspectionCell {
  const raw = row[`c${index}`];
  const shortened = row[`x${index}`];
  if (typeof shortened !== 'string') return { column, value: cellValue(raw) };
  const [storage, total] = shortened.split(':');
  const totalBytes = Number(total);
  const prefix = raw instanceof Uint8Array ? raw : new Uint8Array(0);
  const kept = storage === 'text' ? boundaryInPrefix(prefix) : prefix.length;
  const part = prefix.subarray(0, kept);
  const value: InspectionValue =
    storage === 'text' ? { kind: 'text', value: lenient.decode(part) } : inspectionValueOf('blob', part);
  return { column, value, excerpt: { totalBytes, remainingBytes: totalBytes - kept, nextOffset: kept } };
}

function locatorOf(shape: TableShape, row: Row, snapshot: string, position: bigint): RowLocator {
  const key = shape.key.map((column, index) => ({ column, value: cellValue(row[`k${index}`]) }));
  if (key.length > 0 && key.every((one) => one.value.kind !== 'null')) return { kind: 'primary', values: key };
  if (shape.rowidAlias !== null) return { kind: 'rowid', alias: shape.rowidAlias, value: String(row.rid) };
  return { kind: 'snapshot-position', snapshot, position: position.toString() };
}

function rowOf(shape: TableShape, row: Row, snapshot: string, position: bigint): InspectionRow {
  return {
    locator: locatorOf(shape, row, snapshot, position),
    values: shape.visible.map((column, index) => cellOf(row, column, index)),
  };
}

/** Marks the cells of `row` whose text lost bytes on its way to a string: rare, so only a replacement character costs a read. */
function withExactBytes(db: Db, shape: TableShape, row: InspectionRow): InspectionRow {
  for (const cell of row.values) {
    const typed = cell.value;
    if (typed.kind !== 'text' || cell.excerpt !== undefined || !typed.value.includes('\uFFFD')) continue;
    const clause = locatorClause(shape, row.locator);
    const read = db
      .prepare(
        `SELECT CAST(${quoted(cell.column)} AS BLOB) AS bytes FROM ${quoted(shape.name)} ${whereOf([clause.sql])} ${clause.tail}`
      )
      .get(...clause.params)?.bytes;
    if (read instanceof Uint8Array && !Buffer.from(read).equals(Buffer.from(typed.value)))
      cell.exactBytes = Buffer.from(read).toString('base64');
  }
  return row;
}

function filterClause(shape: TableShape, filters: InspectionRead['filters']): { sql: string; params: Array<unknown> } {
  const params: Array<unknown> = [];
  const parts = filters.map(({ column, value }) => {
    if (!shape.visible.includes(column)) throw coded('INSPECTION_UNKNOWN_COLUMN', 'no such column in this table');
    params.push(sqlValueOf(value));
    return `${quoted(column)} IS ?`;
  });
  return { sql: parts.join(' AND '), params };
}

/** Where a page goes on: after a rowid or a position, as decimal text, or after a primary key's typed values. */
type Position = string | Array<InspectionValue> | null;

/** The clause that goes on after `position`, and the order that makes it total. */
function keysetOf(shape: TableShape, position: Position): { sql: string; params: Array<unknown>; order: string } {
  if (shape.rowidAlias !== null) {
    const order = `ORDER BY ${shape.rowidAlias}`;
    if (typeof position !== 'string') return { sql: '', params: [], order };
    return { sql: `${shape.rowidAlias} > ?`, params: [BigInt(position)], order };
  }
  if (shape.withoutRowid) {
    const columns = shape.key.map(quoted).join(', ');
    const order = `ORDER BY ${columns}`;
    if (!Array.isArray(position)) return { sql: '', params: [], order };
    const values = position.map((one) => sqlValueOf(one));
    return { sql: `(${columns}) > (${values.map(() => '?').join(', ')})`, params: values, order };
  }
  return { sql: '', params: [], order: '' };
}

function validPosition(shape: TableShape, position: unknown): Position {
  const bad = coded('INSPECTION_BAD_CURSOR', 'that cursor does not belong to this read');
  if (position === null) return null;
  if (shape.withoutRowid) {
    if (!Array.isArray(position) || position.length !== shape.key.length || !position.every(isInspectionValue))
      throw bad;
    return position;
  }
  if (typeof position !== 'string' || !/^-?\d+$/.test(position)) throw bad;
  return position;
}

const whereOf = (parts: ReadonlyArray<string>): string => {
  const kept = parts.filter((part) => part !== '');
  return kept.length === 0 ? '' : `WHERE ${kept.join(' AND ')}`;
};

/** One page of a table under `options`; `readRows` is this with no snapshot and whole cells. */
export function readRowPage(db: Db, request: InspectionRead, options: RowReadOptions = {}): InspectionPage {
  const shape = shapeOf(db, request.table);
  const limit = checkLimit(request.limit);
  const filter = filterClause(shape, request.filters);
  const snapshot = options.snapshot ?? '';
  const binding = { reader: 'inspection.rows', table: request.table, filters: request.filters, snapshot };
  const position = validPosition(shape, positionOf(request.cursor, binding));
  const keyset = keysetOf(shape, position);
  const excerptBytes = options.excerptBytes ?? null;
  const count = db.prepare(`SELECT COUNT(*) AS n FROM ${quoted(shape.name)} ${whereOf([filter.sql])}`);
  const total = Number(count.get(...filter.params)?.n);
  const offset = keyset.order === '' && typeof position === 'string' ? BigInt(position) : 0n;
  const statement = exactStatement(
    db,
    `SELECT ${selectList(shape, excerptBytes)} FROM ${quoted(shape.name)} ${whereOf([filter.sql, keyset.sql])} ${keyset.order} LIMIT ? OFFSET ?`
  );
  const rows = statement.all(...filter.params, ...keyset.params, limit + 1, offset);
  const items = rows
    .slice(0, limit)
    .map((row, index) => withExactBytes(db, shape, rowOf(shape, row, snapshot, offset + BigInt(index))));
  const next =
    rows.length > limit ? cursorOf(binding, nextPosition(shape, rows[limit - 1], offset + BigInt(limit))) : null;
  const shortened = items.some((row) => row.values.some((cell) => cell.excerpt !== undefined));
  return {
    items,
    snapshot,
    next,
    total,
    truncated: next !== null || shortened,
    reason: next !== null ? 'page' : shortened ? 'value' : null,
  };
}

function nextPosition(shape: TableShape, last: Row | undefined, offset: bigint): unknown {
  if (shape.rowidAlias !== null) return String(last?.rid);
  if (shape.withoutRowid) return shape.key.map((_, index) => cellValue(last?.[`k${index}`]));
  return offset.toString();
}

/** The rows of `table`, one page, each value whole. */
export function readRows(db: Db, request: InspectionRead): InspectionPage {
  return readRowPage(db, request);
}

/** The clause that names exactly the row of `locator`; a locator that could name several, or none knowably, is refused. */
function locatorClause(shape: TableShape, locator: RowLocator): { sql: string; params: Array<unknown>; tail: string } {
  const ambiguous = coded('INSPECTION_AMBIGUOUS_LOCATOR', 'that locator names no single row');
  if (locator.kind === 'rowid') {
    if (locator.alias !== shape.rowidAlias || !/^-?\d+$/.test(locator.value)) throw ambiguous;
    return { sql: `${shape.rowidAlias} = ?`, params: [BigInt(locator.value)], tail: '' };
  }
  if (locator.kind === 'snapshot-position') {
    if (!/^\d+$/.test(locator.position)) throw ambiguous;
    return { sql: '', params: [], tail: `LIMIT 1 OFFSET ${locator.position}` };
  }
  for (const { column } of locator.values)
    if (!shape.visible.includes(column)) throw coded('INSPECTION_UNKNOWN_COLUMN', 'no such column in this table');
  const names = locator.values.map((one) => one.column);
  const whole = names.length === shape.key.length && shape.key.every((column) => names.includes(column));
  if (!whole || locator.values.some((one) => one.value.kind === 'null')) throw ambiguous;
  return {
    sql: names.map((column) => `${quoted(column)} = ?`).join(' AND '),
    params: locator.values.map((one) => sqlValueOf(one.value)),
    tail: '',
  };
}

/** The one row of `locator`, under `options`. */
export function readRowAt(
  db: Db,
  request: { table: string; locator: RowLocator },
  options: RowReadOptions = {}
): InspectionRow {
  const shape = shapeOf(db, request.table);
  const clause = locatorClause(shape, request.locator);
  const row = exactStatement(
    db,
    `SELECT ${selectList(shape, options.excerptBytes ?? null)} FROM ${quoted(shape.name)} ${whereOf([clause.sql])} ${clause.tail}`
  ).get(...clause.params);
  if (row === undefined) throw coded('INSPECTION_ROW_NOT_FOUND', 'no row at that locator');
  const position = request.locator.kind === 'snapshot-position' ? BigInt(request.locator.position) : 0n;
  return withExactBytes(db, shape, rowOf(shape, row, options.snapshot ?? '', position));
}

/** The one row of `locator`, each value whole. */
export function readRow(db: Db, request: { table: string; locator: RowLocator }): InspectionRow {
  return readRowAt(db, request);
}

/** Every row of `table` where `column` equals `id`, whole. For the domain readers, which name their own tables. */
export function rowsWithValue(db: Db, table: string, column: string, id: string, limit: number): Array<InspectionRow> {
  return readRowPage(db, { table, filters: [{ column, value: { kind: 'text', value: id } }], limit, cursor: null })
    .items;
}

/** One bounded chunk of a text or blob, read through its bytes so nothing is decoded before it is cut. */
export function readValueChunk(db: Db, request: InspectionValueRead): InspectionValueChunk {
  const shape = shapeOf(db, request.table);
  if (!shape.visible.includes(request.column)) throw coded('INSPECTION_UNKNOWN_COLUMN', 'no such column in this table');
  const { offset } = request;
  const badOffset = coded('INSPECTION_BAD_OFFSET', 'that offset is outside the value');
  if (!Number.isSafeInteger(offset) || offset < 0) throw badOffset;
  const clause = locatorClause(shape, request.locator);
  const column = quoted(request.column);
  const row = db
    .prepare(
      `SELECT typeof(${column}) AS storage, length(CAST(${column} AS BLOB)) AS total,
         substr(CAST(${column} AS BLOB), ?, ?) AS part
       FROM ${quoted(shape.name)} ${whereOf([clause.sql])} ${clause.tail}`
    )
    .get(offset + 1, VALUE_CHUNK_BYTES, ...clause.params);
  if (row === undefined) throw coded('INSPECTION_ROW_NOT_FOUND', 'no row at that locator');
  if (row.storage !== 'text' && row.storage !== 'blob')
    throw coded('INSPECTION_NOT_A_VALUE', 'only a text or a blob is read in chunks');
  const totalBytes = Number(row.total);
  if (offset > totalBytes) throw badOffset;
  const part = row.part instanceof Uint8Array ? row.part : new Uint8Array(0);
  return row.storage === 'blob' ? blobChunk(part, offset, totalBytes) : textChunk(part, offset, totalBytes);
}

const nextOffsetOf = (offset: number, length: number, total: number): number | null =>
  offset + length < total ? offset + length : null;

function blobChunk(part: Uint8Array, offset: number, totalBytes: number): InspectionValueChunk {
  return {
    valueKind: 'blob',
    encoding: 'base64',
    value: Buffer.from(part).toString('base64'),
    nextOffset: nextOffsetOf(offset, part.length, totalBytes),
    totalBytes,
  };
}

/** A text chunk ends on a whole character when it can. Bytes that are no UTF-8 go as base64, exact. */
function textChunk(part: Uint8Array, offset: number, totalBytes: number): InspectionValueChunk {
  const atEnd = offset + part.length >= totalBytes;
  const kept = atEnd ? part : part.subarray(0, boundaryInPrefix(part));
  try {
    return {
      valueKind: 'text',
      encoding: 'utf8',
      value: exact.decode(kept),
      nextOffset: nextOffsetOf(offset, kept.length, totalBytes),
      totalBytes,
    };
  } catch {
    return {
      valueKind: 'text',
      encoding: 'base64',
      value: Buffer.from(part).toString('base64'),
      nextOffset: nextOffsetOf(offset, part.length, totalBytes),
      totalBytes,
    };
  }
}
