// The vectors of the lines she saw and said: one `vectors` row per indexed line, under the place of the index it belongs
// to (`place_id`, a root or a DM place) and the month of its `occurred_at`. src/memory/vectors.ts writes them through
// the write kind `line-vectors` (session-write.ts) and reads them back through the readers below.
//
// A row keeps what the index wrote for its line: `item_id` and `occurred_at`, the int8 `bytes` with their `scale` and
// `norm`, `model` and `dims`, and in `context` the line's other fields (`row`, its position in the month, `kind`,
// `revision`, `placeId`, `by`, `participants`, `sourceIds`), with `$keys` when its keys were not in the index's own
// order. Its chunk key is `<kind>:<id>:<revision>`, `private:<partner>:` before it in a DM place, `-<n>` after it for
// the n-th line of one key in a month, and `#<n>` when another month holds the key. A DM place's rows take its audience,
// any other place's the interface's group. `source_rowid` links the line's stored message (upsert.ts#linkVectors).
//
//   op `append`   the lines after the month's stored ones
//   op `month`    the month whole: a stored line it does not name is retired
//
// An evicted vector (index-policy.ts: its `bytes` dropped) is left out of what the readers give.

import { chunkKey } from '../chunks.ts';
import { extraText, join, parseExtra, split } from './map/common.ts';
import type { Spec } from './map/common.ts';
import { storageContext } from './map/index.ts';
import { dmPlaceScope } from './map/scope-parts.ts';
import { deriveRow } from './rows.ts';
import { SCOPE_INTERNAL, groupScope } from './scope.ts';
import { placeCollection } from './storage-keys.ts';
import { linkVectors } from './upsert.ts';
import { asText, dbOf, isFiniteNumber } from './types.ts';
import type { Db, MemoryHandle, Row } from './types.ts';

/** One stored line of the index and its int8 bytes. */
export type StoredLine = { line: Row; bytes: Uint8Array };

/** One write of the kind (see the head of this file). */
export type LineVectorsWrite = {
  op: 'append' | 'month';
  placeId: string;
  month: string;
  model: string | null;
  lines: ReadonlyArray<StoredLine>;
};

/** A month as the index searches it: its lines in row order, their bytes end to end, and the vector size. */
export type LineVectorMonth = { metas: Array<Row>; data: Int8Array; dims: number; rows: number; model: string | null };

const SPEC: Array<Spec> = [
  { col: 'item_id', key: 'id', type: 'text' },
  { col: 'occurred_at', key: 'occurredAt', type: 'text' },
  { col: 'scale', key: 'scale', type: 'num' },
  { col: 'norm', key: 'norm', type: 'num' },
];

/** The key order the index writes a line in; keys it does not know follow in their own order. */
const CANONICAL = [
  'row',
  'kind',
  'id',
  'revision',
  'occurredAt',
  'placeId',
  'by',
  'participants',
  'sourceIds',
  'scale',
  'norm',
];

const MONTH_RE = /^\d{4}-\d{2}$/;
const coded = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const isRecord = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);

const canonicalOrder = (keys: ReadonlyArray<string>): Array<string> => [
  ...CANONICAL.filter((key) => keys.includes(key)),
  ...keys.filter((key) => !CANONICAL.includes(key)),
];

/** The bounds of a month's `occurred_at`: from its first day up to the next month. */
function monthRange(month: string): [string, string] {
  const [year, number] = month.split('-').map(Number);
  const next = number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`;
  return [month, next];
}

/** A write as the writer receives it, checked. */
export function lineVectorsWriteOf(update: Row): LineVectorsWrite {
  if (update.op !== 'append' && update.op !== 'month') throw coded('LINE_VECTORS_OP');
  if (typeof update.placeId !== 'string' || update.placeId === '') throw coded('LINE_VECTORS_PLACE');
  if (typeof update.month !== 'string' || !MONTH_RE.test(update.month)) throw coded('LINE_VECTORS_MONTH');
  const lines = (Array.isArray(update.lines) ? (update.lines as Array<unknown>) : []).map((given) => {
    if (!isRecord(given) || !isRecord(given.line) || !(given.bytes instanceof Uint8Array))
      throw coded('LINE_VECTORS_LINE');
    return { line: given.line, bytes: given.bytes };
  });
  return {
    op: update.op,
    placeId: update.placeId,
    month: update.month,
    model: typeof update.model === 'string' ? update.model : null,
    lines,
  };
}

/**
 * What every row of a place shares: its chunk key prefix and its scope. A place no row holds may be a direct chat, so
 * its rows are internal until the place is stored.
 */
function placeShape(db: Db, placeId: string): { prefix: string; scope: Row } {
  const ctx = storageContext(db, placeCollection('vectors', placeId));
  if (!ctx.subjectPlace) return { prefix: '', scope: { ...SCOPE_INTERNAL } };
  const iface = ctx.iface ?? '';
  if (!ctx.dmPlace) return { prefix: '', scope: groupScope(iface) };
  const user = ctx.privateAccountId ?? null;
  return { prefix: user === null ? '' : `private:${user}:`, scope: dmPlaceScope(iface, ctx.dmPlace) };
}

/** The statements of one connection, prepared once. */
const statements = new WeakMap<Db, Map<string, ReturnType<Db['prepare']>>>();
function prepared(db: Db, sql: string): ReturnType<Db['prepare']> {
  let map = statements.get(db);
  if (!map) statements.set(db, (map = new Map<string, ReturnType<Db['prepare']>>()));
  let statement = map.get(sql);
  if (!statement) map.set(sql, (statement = db.prepare(sql)));
  return statement;
}

const IN_MONTH = 'place_id = ? AND occurred_at >= ? AND occurred_at < ?';

/** The chunk key a line takes in its month: `-<n>` past the first line of a key, `#<n>` past a key another month holds. */
function keyer(db: Db, write: LineVectorsWrite): (base: string) => string {
  const [from, to] = monthRange(write.month);
  const seen = new Set(
    write.op === 'append'
      ? prepared(db, `SELECT chunk_key FROM vectors WHERE ${IN_MONTH}`)
          .all(write.placeId, from, to)
          .map((row) => String(row.chunk_key))
      : []
  );
  const holder = prepared(db, 'SELECT place_id, occurred_at FROM vectors WHERE chunk_key = ? AND retired_at IS NULL');
  const taken = new Set<string>();
  const mine = (key: string): boolean => {
    const row = holder.get(key);
    if (!row) return true;
    const at = asText(row.occurred_at);
    return row.place_id === write.placeId && at >= from && at < to;
  };
  return (base) => {
    let unique = base;
    for (let n = 2; seen.has(unique); n += 1) unique = `${base}-${n}`;
    seen.add(unique);
    let key = unique;
    for (let n = 2; taken.has(key) || !mine(key); n += 1) key = `${unique}#${n}`;
    taken.add(key);
    return key;
  };
}

/** Stores one checked write inside the caller's transaction; returns how many rows it wrote and retired. */
export function writeLineVectors(db: Db, write: LineVectorsWrite, at: string): { written: number; retired: number } {
  const { prefix, scope } = placeShape(db, write.placeId);
  const keyOf = keyer(db, write);
  const rows = write.lines.map(({ line, bytes }): Row => {
    const keys = Object.keys(line);
    const part = split(line, SPEC);
    if (keys.join('\u0000') !== canonicalOrder(keys).join('\u0000')) part.rest.$keys = keys;
    return {
      source_rowid: null,
      ...part.cols,
      chunk_key: keyOf(`${prefix}${chunkKey(line)}`),
      model: write.model,
      dims: bytes.length,
      bytes,
      context: extraText(part.rest),
      ...scope,
      place_id: write.placeId,
      retired_at: null,
    };
  });
  linkVectors(db, rows);
  for (const row of rows) {
    const derived = deriveRow(db, 'vectors', row);
    const cols = Object.keys(derived);
    prepared(
      db,
      `INSERT INTO vectors (${cols.map((col) => `"${col}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
       ON CONFLICT(chunk_key) DO UPDATE SET ${cols
         .filter((col) => col !== 'chunk_key')
         .map((col) => `"${col}" = excluded."${col}"`)
         .join(', ')}`
    ).run(...cols.map((col) => derived[col] ?? null));
  }
  let retired = 0;
  if (write.op === 'month') {
    const named = new Set(rows.map((row) => row.chunk_key));
    const [from, to] = monthRange(write.month);
    const retire = prepared(db, 'UPDATE vectors SET retired_at = ? WHERE chunk_key = ?');
    for (const row of prepared(db, `SELECT chunk_key FROM vectors WHERE ${IN_MONTH} AND retired_at IS NULL`).all(
      write.placeId,
      from,
      to
    )) {
      if (named.has(row.chunk_key)) continue;
      retire.run(at, row.chunk_key);
      retired += 1;
    }
  }
  return { written: rows.length, retired };
}

/**
 * The stored lines of a month's files (`{ manifest, meta, i8 }`, what an older index wrote): each complete jsonl line
 * the index would write the same way, with its `dims` bytes. Null when the text is not such lines, or the manifest names
 * no vector size or fewer bytes than the lines need.
 */
export function monthLines(files: Row): Array<StoredLine> | null {
  const manifest = isRecord(files.manifest) ? files.manifest : {};
  const dims = manifest.dims;
  if (typeof dims !== 'number' || !Number.isInteger(dims) || dims <= 0) return null;
  const meta = Buffer.isBuffer(files.meta) ? files.meta.toString('utf8') : asText(files.meta ?? '');
  const i8 = Buffer.from((files.i8 as ArrayLike<number> | undefined) ?? []);
  if (meta === '') return [];
  if (!meta.endsWith('\n')) return null;
  const lines: Array<StoredLine> = [];
  for (const text of meta.slice(0, -1).split('\n')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isRecord(value) || JSON.stringify(value) !== text) return null;
    const offset = lines.length * dims;
    if (i8.length < offset + dims) return null;
    lines.push({ line: value, bytes: new Uint8Array(i8.subarray(offset, offset + dims)) });
  }
  return lines;
}

/** The write kind `line-vectors` on the writer connection (session-write.ts). */
export function applyLineVectorsWrite(handle: MemoryHandle, update: Row): { written: number; retired: number } {
  const write = lineVectorsWriteOf(update);
  const at = new Date(isFiniteNumber(update.now) ? update.now : Date.now()).toISOString();
  return handle.transaction(() => writeLineVectors(dbOf(handle), write, at));
}

/** Puts a line's keys in the order `keys` names; keys it does not name follow in their own order. */
function inOrder(line: Row, keys: unknown): Row {
  if (!Array.isArray(keys)) return line;
  const out: Row = {};
  for (const key of keys as Array<string>) if (Object.hasOwn(line, key)) out[key] = line[key];
  for (const key of Object.keys(line)) if (!Object.hasOwn(out, key)) out[key] = line[key];
  return out;
}

/** The line of a stored row, as the index wrote it and as a JSON round trip of it reads. */
function lineOf(row: Row): Row {
  const context = parseExtra(row.context);
  const keys = context.$keys;
  delete context.$keys;
  const joined = join(row, context, SPEC);
  return JSON.parse(JSON.stringify(inOrder(inOrder(joined, canonicalOrder(Object.keys(joined))), keys))) as Row;
}

/** The months of a place that hold a live line, in order. */
export function lineVectorMonths(db: Db, placeId: string): Array<string> {
  return prepared(
    db,
    `SELECT DISTINCT substr(occurred_at, 1, 7) AS month FROM vectors
     WHERE place_id = ? AND retired_at IS NULL AND bytes IS NOT NULL ORDER BY month`
  )
    .all(placeId)
    .map((row) => String(row.month));
}

/**
 * What tells a cached month from the stored one: its live lines' count, newest row and total scale, and how many of them
 * were evicted (index-policy.ts sets `evicted_at` with the bytes it drops), per month of a place.
 */
export function lineVectorStamps(db: Db, placeId: string): Map<string, string> {
  const stamps = new Map<string, string>();
  for (const row of prepared(
    db,
    `SELECT substr(occurred_at, 1, 7) AS month, COUNT(*) AS n, MAX(rowid) AS top, TOTAL(scale) AS scales,
       SUM(evicted_at IS NOT NULL) AS evicted
     FROM vectors WHERE place_id = ? AND retired_at IS NULL GROUP BY month ORDER BY month`
  ).all(placeId))
    stamps.set(String(row.month), `${asText(row.n)}|${asText(row.top)}|${asText(row.scales)}|${asText(row.evicted)}`);
  return stamps;
}

/** A month of a place with its live lines in row order and their bytes, or null when it holds none. */
export function lineVectorMonth(db: Db, placeId: string, month: string): LineVectorMonth | null {
  const [from, to] = monthRange(month);
  const rows = prepared(
    db,
    `SELECT rowid, item_id, occurred_at, scale, norm, context, model, dims, bytes FROM vectors
     WHERE ${IN_MONTH} AND retired_at IS NULL AND bytes IS NOT NULL ORDER BY rowid`
  )
    .all(placeId, from, to)
    .map((row, index) => ({ row, index, order: Number(parseExtra(row.context).row) }))
    .sort((a, b) => (Number.isFinite(a.order) && Number.isFinite(b.order) ? a.order - b.order : 0) || a.index - b.index)
    .map(({ row }) => row);
  if (rows.length === 0) return null;
  const dims = Number(rows[0].dims);
  const data = new Int8Array(rows.length * dims);
  rows.forEach((row, index) =>
    data.set(new Int8Array((row.bytes as Uint8Array).buffer, (row.bytes as Uint8Array).byteOffset, dims), index * dims)
  );
  return {
    metas: rows.map(lineOf),
    data,
    dims,
    rows: rows.length,
    model: typeof rows[0].model === 'string' ? rows[0].model : null,
  };
}

/** The chunk keys (`<kind>:<id>:<revision>`, src/memory/chunks.ts) of the live lines of a month of a place. */
export function lineVectorKeys(db: Db, placeId: string, month: string): Set<string> {
  const [from, to] = monthRange(month);
  const keys = new Set<string>();
  for (const row of prepared(
    db,
    `SELECT item_id, occurred_at, scale, norm, context FROM vectors
     WHERE ${IN_MONTH} AND retired_at IS NULL AND bytes IS NOT NULL`
  ).all(placeId, from, to))
    keys.add(chunkKey(lineOf(row)));
  return keys;
}

/** The vector size and model of the month's stored lines, or null for an empty month. */
export function lineVectorShape(
  db: Db,
  placeId: string,
  month: string
): { dims: number; model: string | null; rows: number } | null {
  const [from, to] = monthRange(month);
  const row = prepared(
    db,
    `SELECT dims, model, COUNT(*) AS n FROM vectors WHERE ${IN_MONTH} AND retired_at IS NULL AND bytes IS NOT NULL`
  ).get(placeId, from, to);
  if (!row || Number(row.n) === 0) return null;
  return { dims: Number(row.dims), model: typeof row.model === 'string' ? row.model : null, rows: Number(row.n) };
}

/**
 * Schema version 45 (schema.ts): each line vector a month unit held names that unit's place in `place_id`, which an
 * index serves with the month, and loses `owner_key`. The months' `operational` manifests go, and their units are
 * retired.
 */
export function placeLineVectors(db: Db): void {
  db.exec('ALTER TABLE vectors ADD COLUMN place_id TEXT');
  // The stamps of a place's months read from this index alone (`lineVectorStamps`), so a warm search costs no row read.
  db.exec(
    'CREATE INDEX IF NOT EXISTS vectors_place ON vectors(place_id, occurred_at, retired_at, evicted_at, scale) WHERE place_id IS NOT NULL'
  );
  db.exec(`UPDATE vectors SET place_id = (SELECT subject_id FROM storage_units s WHERE s.id = vectors.owner_key),
    owner_key = NULL WHERE owner_key IN (SELECT id FROM storage_units WHERE kind = 'vectors')`);
  db.exec("DELETE FROM operational WHERE kind = 'vectors'");
  db.prepare("UPDATE storage_units SET retired_at = ? WHERE kind = 'vectors' AND retired_at IS NULL").run(
    new Date().toISOString()
  );
}
