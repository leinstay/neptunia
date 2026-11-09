// Whose a place's row is: the notes of a place (place-notes.ts) and a channel's entry of the server map
// (channel-entry.ts) keep each row's owner in the row itself, in `writer` (`place` or `channel`) and `holder_id` (the
// place). A row the notes of two places map, such as a self fact two roots both hold, stays the first place's, and the
// second place is listed in `co_owners` by the same two columns: its notes read the row, its write leaves the row as
// the first place wrote it, and when the first place's notes drop the row it goes to the second instead of being
// retired. The writers stamp these columns beside the row's unit, the shared write rules of upsert.ts#writeRow read
// them, and the readers, the retirement of what a value no longer holds and the hand-over run on them. Version step 48
// derives them from the units of the rows and the `co_owners` rows already stored (`ownPlaceRows`).

import { projectRow } from './graph.ts';
import type { StorageKey } from './storage-keys.ts';
import type { Db, Row, Rows } from './types.ts';

/** The writers whose rows own themselves through these columns. */
export type PlaceWriter = 'place' | 'channel';

/** The owner columns of a place's row. */
export type PlaceOwner = { writer: PlaceWriter; holder_id: string };

/** The tables a place's notes and a channel's entry write. */
export const PLACE_TABLES = ['places', 'claims', 'descriptions', 'description_versions', 'operational'] as const;

/** The primary key of each place table. */
const keyOf = (table: string): ReadonlyArray<string> => (table === 'operational' ? ['kind', 'owner'] : ['id']);

/** A row's primary key as `co_owners` spells it: the key's columns joined by a zero character. */
const keyText = (table: string, row: Row): string =>
  keyOf(table)
    .map((col) => String(row[col]))
    .join('\u0000');
/**
 * The rows of `table` that `co_owners` lists for an owner (bound as tbl, writer, holder): a two-column key is matched
 * through its parts, so the lookup stays on the primary key instead of scanning the table.
 */
const sharedSql = (table: string): string =>
  table === 'operational'
    ? `rowid IN (SELECT t.rowid FROM co_owners c JOIN operational t ON t.kind = substr(c.key, 1, instr(c.key, char(0)) - 1)
         AND t.owner = substr(c.key, instr(c.key, char(0)) + 1) WHERE c.tbl = ? AND c.writer = ? AND c.holder_id = ?)`
    : `"id" IN (SELECT key FROM co_owners WHERE tbl = ? AND writer = ? AND holder_id = ?)`;

/** The statements of a connection, prepared once: every write and read of a place runs the same few. */
const statements = new WeakMap<Db, Map<string, ReturnType<Db['prepare']>>>();
export function preparedPlace(db: Db, sql: string): ReturnType<Db['prepare']> {
  let cache = statements.get(db);
  if (!cache) statements.set(db, (cache = new Map<string, ReturnType<Db['prepare']>>()));
  let statement = cache.get(sql);
  if (!statement) cache.set(sql, (statement = db.prepare(sql)));
  return statement;
}

/** The tables whose rows a read gives in their `position` order. */
const POSITIONED = new Set(['claims', 'description_versions']);

export const isPlaceWriter = (writer: unknown): writer is PlaceWriter => writer === 'place' || writer === 'channel';

/** The owner columns of the unit `key` of a place's notes or a channel's entry, else null. */
export function placeOwnerOf(key: StorageKey): PlaceOwner | null {
  return isPlaceWriter(key.kind) ? { writer: key.kind, holder_id: key.subject.id } : null;
}

/** `rows` with the owner columns of `owner` on every row. */
export function stampPlaceRows(rows: Rows, owner: PlaceOwner): Rows {
  for (const list of Object.values(rows))
    for (const row of list) Object.assign(row, { writer: owner.writer, holder_id: owner.holder_id });
  return rows;
}

/** The live rows `owner` holds or shares in each of `tables`, in the order a read gives them. */
export function heldPlaceRows(db: Db, owner: PlaceOwner, tables: ReadonlyArray<string>): Rows {
  const rows: Rows = {};
  for (const table of tables)
    rows[table] = preparedPlace(
      db,
      `SELECT * FROM "${table}" WHERE ((writer = ? AND holder_id = ?) OR ${sharedSql(table)})
         AND retired_at IS NULL ORDER BY ${POSITIONED.has(table) ? 'position, rowid' : 'rowid'}`
    )
      .all(owner.writer, owner.holder_id, table, owner.writer, owner.holder_id)
      .map((row) => ({ ...row }));
  return rows;
}

/** Whether `owner` holds a live row in `table`: whether its value is stored at all. */
export function holdsPlace(db: Db, owner: PlaceOwner, table: string): boolean {
  return (
    preparedPlace(
      db,
      `SELECT 1 AS ok FROM "${table}" WHERE writer = ? AND holder_id = ? AND retired_at IS NULL LIMIT 1`
    ).get(owner.writer, owner.holder_id) !== undefined
  );
}

/** Lists `owner` (with its unit `unitId`) beside the place that holds the row `key` of `table`. */
export function sharePlaceRow(db: Db, table: string, key: string, owner: PlaceOwner, unitId: unknown): void {
  preparedPlace(
    db,
    'INSERT OR IGNORE INTO co_owners (tbl, key, owner_key, writer, holder_id) VALUES (?, ?, ?, ?, ?)'
  ).run(table, key, unitId ?? null, owner.writer, owner.holder_id);
}

/** Takes `owner` off the list of places that share the row `key` of `table`. */
export function unsharePlaceRow(db: Db, table: string, key: string, owner: PlaceOwner): void {
  preparedPlace(db, 'DELETE FROM co_owners WHERE tbl = ? AND key = ? AND writer = ? AND holder_id = ?').run(
    table,
    key,
    owner.writer,
    owner.holder_id
  );
}

/**
 * Hands the row `row` of `table` to the first other owner that shares it; false when none does. A unit of a place is
 * never retired (only a month of line vectors is, line-vectors.ts), so every listed owner is a live one.
 */
function handOver(db: Db, table: string, row: Row, owner: PlaceOwner): boolean {
  const key = keyText(table, row);
  const heir = preparedPlace(
    db,
    `SELECT rowid, owner_key, writer, holder_id FROM co_owners WHERE tbl = ? AND key = ?
       AND NOT (writer IS ? AND holder_id IS ?) ORDER BY holder_id, owner_key LIMIT 1`
  ).get(table, key, owner.writer, owner.holder_id);
  if (!heir) return false;
  db.prepare(
    `UPDATE "${table}" SET owner_key = ?, writer = ?, holder_id = ? WHERE ${keyOf(table)
      .map((col) => `"${col}" = ?`)
      .join(' AND ')}`
  ).run(heir.owner_key, heir.writer, heir.holder_id, ...keyOf(table).map((col) => row[col]));
  db.prepare('DELETE FROM co_owners WHERE rowid = ?').run(heir.rowid);
  return true;
}

/**
 * Retires the live rows `owner` holds that `mapping` (a whole value's rows) no longer holds, a row another place shares
 * going to that place instead, and takes `owner` off the rows it shared and no longer maps. Returns how many it retired.
 */
export function retirePlaceAbsent(db: Db, owner: PlaceOwner, mapping: Rows, at: string): number {
  let count = 0;
  for (const table of PLACE_TABLES) {
    const key = keyOf(table);
    const keep = new Set((mapping[table] ?? []).map((row) => keyText(table, row)));
    const update = preparedPlace(
      db,
      `UPDATE "${table}" SET retired_at = ? WHERE ${key.map((col) => `"${col}" = ?`).join(' AND ')}`
    );
    for (const row of preparedPlace(
      db,
      `SELECT ${key.map((col) => `"${col}"`).join(', ')} FROM "${table}" WHERE writer = ? AND holder_id = ? AND retired_at IS NULL`
    ).all(owner.writer, owner.holder_id)) {
      if (keep.has(keyText(table, row)) || handOver(db, table, row, owner)) continue;
      update.run(at, ...key.map((col) => row[col]));
      projectRow(db, table, row, { at });
      count += 1;
    }
    for (const shared of preparedPlace(
      db,
      'SELECT key FROM co_owners WHERE tbl = ? AND writer = ? AND holder_id = ?'
    ).all(table, owner.writer, owner.holder_id))
      if (!keep.has(String(shared.key))) unsharePlaceRow(db, table, String(shared.key), owner);
  }
  return count;
}

/**
 * Version step 48: every row a place's notes or a channel's entry unit owns, and every `co_owners` row of such a unit,
 * takes that unit's owner columns.
 */
export function ownPlaceRows(db: Db): void {
  for (const table of [...PLACE_TABLES, 'co_owners'])
    db.exec(`UPDATE "${table}" SET writer = u.kind, holder_id = u.subject_id
      FROM storage_units u WHERE u.id = "${table}".owner_key AND u.kind IN ('place', 'channel')`);
}
