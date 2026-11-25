// Whose a place's row is: the notes of a place (place-notes.ts), a channel's entry of the server map
// (channel-entry.ts), a place's lorebook (place-lore.ts), the stretches of a chat the persona took part in
// (participation-episodes.ts) and the lines they said lately in it (recent-lines.ts) keep each row's holder in the row
// itself, in `writer` (`place`, `channel`, `lore`, `participation` or `recent`) and `holder_id` (the place). An
// episode's message links (`episode_sources`) carry the columns of their episode. A row the values of two places map,
// such as a self fact two roots both hold, stays the first place's, and the second place is listed in `co_owners` by
// the same two columns: its value reads the row, its write leaves the row as the first place wrote it, and when the
// first place's value drops the row it goes to the second instead of being retired. The writers stamp these columns
// beside the row's unit, the shared write rules of upsert.ts#writeRow read them, and the readers, the retirement of what
// a value no longer holds and the hand-over run on them.

import { projectRow } from './graph.ts';
import { deriveMirrorPublication } from './publish.ts';
import type { UnitKey } from './unit-keys.ts';
import { asText } from './types.ts';
import type { Db, Row, Rows } from './types.ts';

/** The writers whose rows own themselves through these columns. */
export type PlaceWriter = 'place' | 'channel' | 'lore' | 'participation' | 'recent' | 'diary';

/** The holder columns of a place's row. */
export type PlaceHolder = { writer: PlaceWriter; holder_id: string };

/** The tables each writer writes. */
const TABLES_OF: Record<PlaceWriter, ReadonlyArray<string>> = {
  place: ['places', 'claims', 'descriptions', 'description_versions', 'operational'],
  channel: ['places', 'descriptions', 'description_versions', 'operational'],
  lore: ['claims'],
  participation: ['episodes', 'operational'],
  recent: ['claims', 'operational'],
  diary: ['diary', 'operational'],
};

/** The links a writer's rows hold under them: the table, its parent table, the parent's column and a link's key. */
type Links = { table: string; parent: string; link: string; key: ReadonlyArray<string> };
const LINKS_OF: Partial<Record<PlaceWriter, Links>> = {
  participation: { table: 'episode_sources', parent: 'episodes', link: 'episode_id', key: ['episode_id', 'position'] },
  diary: {
    table: 'diary_mirrors',
    parent: 'diary',
    link: 'diary_id',
    key: ['diary_id', 'iface', 'place_id'],
  },
};

/** The place the holder columns name, null for the persona, whose diary no place shares. */
export const placeOfHolder = (holder: { writer?: unknown; holder_id?: unknown }): string | null =>
  isPlaceWriter(holder.writer) && holder.writer !== 'diary' && typeof holder.holder_id === 'string'
    ? holder.holder_id
    : null;

/** The primary key of each place table. */
const keyOf = (table: string): ReadonlyArray<string> => (table === 'operational' ? ['kind', 'owner'] : ['id']);

/** A row's primary key as `co_owners` spells it: the key's columns joined by a zero character. */
const keyText = (table: string, row: Row): string =>
  keyOf(table)
    .map((col) => String(row[col]))
    .join('\u0000');
/**
 * The rows of `table` that `co_owners` lists for a holder (bound as tbl, writer, holder): a two-column key is matched
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
const POSITIONED = new Set(['claims', 'description_versions', 'episodes']);

export const isPlaceWriter = (writer: unknown): writer is PlaceWriter =>
  typeof writer === 'string' && Object.hasOwn(TABLES_OF, writer);

/**
 * The holder columns of the unit `key` of a place's notes, a channel's entry, a lorebook, a participation or recent
 * lines, else null.
 */
export function placeHolderOf(key: UnitKey): PlaceHolder | null {
  return isPlaceWriter(key.kind) ? { writer: key.kind, holder_id: key.subject.id } : null;
}

/** `rows` with the given holder columns on every row. */
export function stampPlaceRows(rows: Rows, holder: PlaceHolder): Rows {
  for (const list of Object.values(rows))
    for (const row of list) Object.assign(row, { writer: holder.writer, holder_id: holder.holder_id });
  return rows;
}

/** The live rows the given holder holds or shares in each of `tables`, in the order a read gives them. */
export function heldPlaceRows(db: Db, holder: PlaceHolder, tables: ReadonlyArray<string>): Rows {
  const rows: Rows = {};
  for (const table of tables)
    rows[table] = preparedPlace(
      db,
      `SELECT * FROM "${table}" WHERE ((writer = ? AND holder_id = ?) OR ${sharedSql(table)})
         AND retired_at IS NULL ORDER BY ${POSITIONED.has(table) ? 'position, rowid' : 'rowid'}`
    )
      .all(holder.writer, holder.holder_id, table, holder.writer, holder.holder_id)
      .map((row) => ({ ...row }));
  return rows;
}

/** Whether the given holder holds a live row in `table`: whether its value is stored at all. */
export function holdsPlace(db: Db, holder: PlaceHolder, table: string): boolean {
  return (
    preparedPlace(
      db,
      `SELECT 1 AS ok FROM "${table}" WHERE writer = ? AND holder_id = ? AND retired_at IS NULL LIMIT 1`
    ).get(holder.writer, holder.holder_id) !== undefined
  );
}

/** The holder columns of a writer that shares a row: a place's, or a line's or a prose history's of a place. */
export type SharingHolder = { writer: string; holder_id: string | null };

/** Lists the given holder beside the place that holds the row `key` of `table`, once. */
export function sharePlaceRow(db: Db, table: string, key: string, holder: SharingHolder): void {
  preparedPlace(
    db,
    `INSERT INTO co_owners (tbl, key, writer, holder_id) SELECT ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM co_owners WHERE tbl = ? AND key = ? AND writer IS ? AND holder_id IS ?)`
  ).run(table, key, holder.writer, holder.holder_id, table, key, holder.writer, holder.holder_id);
}

/** Takes the given holder off the list of places that share the row `key` of `table`. */
export function unsharePlaceRow(db: Db, table: string, key: string, holder: SharingHolder): void {
  preparedPlace(db, 'DELETE FROM co_owners WHERE tbl = ? AND key = ? AND writer = ? AND holder_id = ?').run(
    table,
    key,
    holder.writer,
    holder.holder_id
  );
}

/**
 * Hands the row `row` of `table` to the first other holder that shares it; false when none does. A unit of a place is
 * never retired (only a month of line vectors is, line-vectors.ts), so every listed holder is a live one.
 */
function handOver(db: Db, table: string, row: Row, holder: PlaceHolder): boolean {
  const key = keyText(table, row);
  const heir = preparedPlace(
    db,
    `SELECT rowid, writer, holder_id FROM co_owners WHERE tbl = ? AND key = ?
       AND NOT (writer IS ? AND holder_id IS ?) ORDER BY holder_id, rowid LIMIT 1`
  ).get(table, key, holder.writer, holder.holder_id);
  if (!heir) return false;
  db.prepare(
    `UPDATE "${table}" SET writer = ?, holder_id = ? WHERE ${keyOf(table)
      .map((col) => `"${col}" = ?`)
      .join(' AND ')}`
  ).run(heir.writer, heir.holder_id, ...keyOf(table).map((col) => row[col]));
  db.prepare('DELETE FROM co_owners WHERE rowid = ?').run(heir.rowid);
  // An episode's message links follow it.
  if (table === 'episodes')
    preparedPlace(
      db,
      'UPDATE episode_sources SET writer = ?, holder_id = ? WHERE episode_id = ? AND writer = ? AND holder_id = ?'
    ).run(heir.writer, heir.holder_id, row.id, holder.writer, holder.holder_id);
  return true;
}

/**
 * Retires the live links the given holder holds that `mapping` no longer holds, unless another holder holds their live
 * parent. A link is told apart by its key (an episode's message by its episode and position, a mirror by its entry,
 * interface and place); a retired mirror takes its publication with it. Returns how many it retired.
 */
function retireLinksAbsent(db: Db, holder: PlaceHolder, links: Links, mapping: Rows, at: string): number {
  const keyOf = (row: Row): string => links.key.map((col) => (row[col] == null ? '' : asText(row[col]))).join('\u0000');
  const keep = new Set((mapping[links.table] ?? []).map(keyOf));
  let count = 0;
  for (const row of preparedPlace(
    db,
    `SELECT rowid, ${links.key.join(', ')} FROM "${links.table}" c WHERE writer = ? AND holder_id = ? AND retired_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM "${links.parent}" p WHERE p.id = c."${links.link}" AND p.retired_at IS NULL
         AND p.writer IS NOT NULL AND p.writer != 'session'
         AND NOT (p.writer IS ? AND p.holder_id IS ?))`
  ).all(holder.writer, holder.holder_id, holder.writer, holder.holder_id)) {
    if (keep.has(keyOf(row))) continue;
    preparedPlace(db, `UPDATE "${links.table}" SET retired_at = ? WHERE rowid = ?`).run(at, row.rowid);
    if (links.table === 'diary_mirrors') deriveMirrorPublication(db, row, { at });
    projectRow(db, links.table, row, { at });
    count += 1;
  }
  return count;
}

/**
 * Retires the live rows the given holder holds that `mapping` (a whole value's rows) no longer holds, a row another
 * place shares going to that place instead, and takes the holder off the rows it shared and no longer maps. Returns how
 * many it retired.
 */
export function retirePlaceAbsent(db: Db, holder: PlaceHolder, mapping: Rows, at: string): number {
  let count = 0;
  for (const table of TABLES_OF[holder.writer]) {
    const key = keyOf(table);
    const keep = new Set((mapping[table] ?? []).map((row) => keyText(table, row)));
    const update = preparedPlace(
      db,
      `UPDATE "${table}" SET retired_at = ? WHERE ${key.map((col) => `"${col}" = ?`).join(' AND ')}`
    );
    for (const row of preparedPlace(
      db,
      `SELECT ${key.map((col) => `"${col}"`).join(', ')} FROM "${table}" WHERE writer = ? AND holder_id = ? AND retired_at IS NULL`
    ).all(holder.writer, holder.holder_id)) {
      if (keep.has(keyText(table, row)) || handOver(db, table, row, holder)) continue;
      update.run(at, ...key.map((col) => row[col]));
      projectRow(db, table, row, { at });
      count += 1;
    }
    for (const shared of preparedPlace(
      db,
      'SELECT key FROM co_owners WHERE tbl = ? AND writer = ? AND holder_id = ?'
    ).all(table, holder.writer, holder.holder_id))
      if (!keep.has(String(shared.key))) unsharePlaceRow(db, table, String(shared.key), holder);
  }
  const links = LINKS_OF[holder.writer];
  return links ? count + retireLinksAbsent(db, holder, links, mapping, at) : count;
}
