// Whose a line is: the record, the journal and the archive keep each row's owner in the row itself, in `writer`
// (`record`, `journal` or `archive`), `holder_id` (the place that holds the record, the journal or the archive, or
// `persona:local` for hers) and `period` (the UTC day of a record or journal line, the month of an archive entry). The
// writers stamp these columns beside the row's unit (record-lines.ts, journal-lines.ts, archive-lines.ts, observe.ts,
// message-families.ts), and the readers and the next position of a day or a month run on them. Version step 46 derives
// them from the units of the rows already stored (`ownLineRows`). An archive entry's retired claim carries `writer`
// alone.

import type { StorageKey } from './storage-keys.ts';
import type { Db, Row } from './types.ts';

/** The writers whose rows own themselves through these columns. */
export type LineWriter = 'record' | 'journal' | 'archive';

/** The owner columns of a line. */
export type LineOwner = { writer: LineWriter; holder_id: string; period: string };

/** The tables each writer writes its lines into, which share one sequence of positions per holder and period. */
export const LINE_TABLES: Record<LineWriter, ReadonlyArray<string>> = {
  record: ['sources'],
  journal: ['day', 'decisions', 'sources', 'affinity_events'],
  archive: ['claim_versions'],
};

/**
 * The tables whose rows hold a line's own position. A journal turn's answer shares its `day` row's position, and an
 * attitude row holds its index in the line, so a day's last line is the highest of `day` and `decisions`.
 */
const POSITION_TABLES: Record<LineWriter, ReadonlyArray<string>> = {
  record: ['sources'],
  journal: ['day', 'decisions'],
  archive: ['claim_versions'],
};

/** The statements of a connection, prepared once: a write asks the next position of its day for every line. */
const statements = new WeakMap<Db, Map<string, ReturnType<Db['prepare']>>>();
function prepared(db: Db, sql: string): ReturnType<Db['prepare']> {
  let cache = statements.get(db);
  if (!cache) statements.set(db, (cache = new Map<string, ReturnType<Db['prepare']>>()));
  let statement = cache.get(sql);
  if (!statement) cache.set(sql, (statement = db.prepare(sql)));
  return statement;
}

const isLineWriter = (kind: unknown): kind is LineWriter =>
  kind === 'record' || kind === 'journal' || kind === 'archive';

/** The owner columns of the unit `key` of a record or journal day or an archive month, else null. */
export function lineOwnerOf(key: StorageKey): LineOwner | null {
  if (!isLineWriter(key.kind) || !key.partition) return null;
  return { writer: key.kind, holder_id: key.subject.id, period: key.partition };
}

/** The owner columns of a day or a month named by its key's JSON (storage-keys.ts#keyText), else null. */
export function lineOwnerOfText(text: string | null | undefined): LineOwner | null {
  if (typeof text !== 'string' || !text.startsWith('{')) return null;
  try {
    return lineOwnerOf(JSON.parse(text) as StorageKey);
  } catch {
    return null;
  }
}

/** The columns a row of `owner` is written with (none for a row no line owner holds). */
export const lineColumns = (owner: LineOwner | null): Row =>
  owner ? { writer: owner.writer, holder_id: owner.holder_id, period: owner.period } : {};

/** The next position of a day or a month: one past the highest line it holds, retired ones included. */
export function nextLinePosition(db: Db, owner: LineOwner): number {
  const tables = POSITION_TABLES[owner.writer];
  const sql = tables
    .map((table) => `SELECT MAX(position) AS p FROM "${table}" WHERE writer = ? AND holder_id = ? AND period = ?`)
    .join(' UNION ALL ');
  const args = tables.flatMap(() => [owner.writer, owner.holder_id, owner.period]);
  const top = prepared(db, `SELECT MAX(p) AS p FROM (${sql})`).get(...args)?.p;
  return typeof top === 'number' ? top + 1 : 0;
}

/** The live rows of a day or a month in `table`, in the order they were written. */
export function lineRows(db: Db, owner: LineOwner, table: string): Array<Row> {
  return prepared(
    db,
    `SELECT * FROM "${table}" WHERE holder_id = ? AND period = ? AND writer = ? AND retired_at IS NULL
       ORDER BY position, rowid`
  )
    .all(owner.holder_id, owner.period, owner.writer)
    .map((row) => ({ ...row }));
}

/** The periods a holder's lines span (every holder's with null), in order, each with its holder. */
export function linePeriods(
  db: Db,
  writer: LineWriter,
  holder: string | null = null
): Array<{ holder: string; period: string }> {
  const [table] = LINE_TABLES[writer];
  const sql = `SELECT DISTINCT holder_id AS holder, period FROM "${table}" WHERE writer = ?${holder === null ? '' : ' AND holder_id = ?'}
    ORDER BY holder_id, period`;
  const rows = holder === null ? db.prepare(sql).all(writer) : db.prepare(sql).all(writer, holder);
  return rows.map((row) => ({ holder: String(row.holder), period: String(row.period) }));
}

/**
 * Version step 46: every row a record, journal or archive unit owns takes that unit's owner columns, and an archive
 * entry's retired claim its writer. Rows owned by no such unit stay as they are.
 */
export function ownLineRows(db: Db): void {
  const tables = new Set(Object.values(LINE_TABLES).flat());
  for (const table of tables)
    db.exec(`UPDATE "${table}" SET writer = u.kind, holder_id = u.subject_id, period = u.partition
      FROM storage_units u WHERE u.id = "${table}".owner_key AND u.kind IN ('record', 'journal', 'archive')`);
  db.exec(`UPDATE claims SET writer = 'archive'
    FROM storage_units u WHERE u.id = claims.owner_key AND u.kind = 'archive'`);
}
