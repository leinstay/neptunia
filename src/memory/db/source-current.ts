// Which rows of `sources` are a chat line as it stands now, as SQL. A leaf, because the store of media and recall both read it.
import type { Db, Row } from './types.ts';

/** The rows `t` of the same message as the row `s`. */
const SOURCE_FAMILY = `t.native_id IS s.native_id AND t.iface IS s.iface AND t.place_id IS s.place_id
  AND COALESCE(t.authority_id, t.iface || '/global') IS COALESCE(s.authority_id, s.iface || '/global')
  AND COALESCE(t.native_kind, 'message') IS COALESCE(s.native_kind, 'message')
  AND COALESCE(t.generation, 1) IS COALESCE(s.generation, 1)`;
/** The newest revision of a chat line, once, deleted or not. Needs the alias `s`. */
export const CURRENT_REVISION = `s.kind IN ('seen', 'said') AND s.retired_at IS NULL
  AND s.revision IS (SELECT MAX(t.revision) FROM sources t WHERE ${SOURCE_FAMILY} AND t.kind IN ('seen', 'said') AND t.retired_at IS NULL)
  AND s.rowid = (SELECT MIN(t.rowid) FROM sources t WHERE ${SOURCE_FAMILY} AND t.kind IN ('seen', 'said') AND t.retired_at IS NULL AND t.revision IS s.revision)`;
/**
 * `column` of the first stored revision of the message of the row `s`, for a row that is a later revision and whose first
 * revision is stored, else of `s` itself. The first revision says who wrote a line and when; the newest gives its text. A
 * row of the first revision costs no read. Needs the alias `s`.
 */
const OF_FIRST_REVISION = (column: string): string => {
  const earlier = `${SOURCE_FAMILY} AND t.kind IN ('seen', 'said') AND t.retired_at IS NULL AND t.revision IS NOT NULL`;
  return `CASE WHEN s.revision > 1 AND EXISTS (SELECT 1 FROM sources t WHERE ${earlier} AND t.revision < s.revision)
    THEN (SELECT t.${column} FROM sources t WHERE ${earlier} ORDER BY t.revision, t.rowid LIMIT 1) ELSE s.${column} END`;
};
/** The moment a chat line was written: its first revision's, whatever moment a later revision carries. */
export const LINE_MOMENT = OF_FIRST_REVISION('occurred_at');
/** The first revision's `rowid`: where the line stands among lines of the same moment. */
export const LINE_ROWID = OF_FIRST_REVISION('rowid');
/** The kind of a chat line, `said` for her own: its first revision's, as every edit is stored `seen`. */
export const LINE_KIND = OF_FIRST_REVISION('kind');
/** The author's kind of a chat line, its first revision's. */
export const LINE_AUTHOR_KIND = OF_FIRST_REVISION('author_kind');
/** The author's account row of a chat line, its first revision's. */
export const LINE_AUTHOR_ACCOUNT = OF_FIRST_REVISION('author_account');
/** Whether a `deleted` line stands for the message of the row `s`. */
export const SOURCE_DELETED = `EXISTS (SELECT 1 FROM sources d WHERE d.native_id IS s.native_id AND d.iface IS s.iface
    AND d.place_id IS s.place_id AND d.kind = 'deleted' AND d.retired_at IS NULL
    AND (d.authority_id IS NULL OR d.authority_id IS COALESCE(s.authority_id, s.iface || '/global'))
    AND (d.native_kind IS NULL OR d.native_kind IS COALESCE(s.native_kind, 'message'))
    AND (d.generation IS NULL OR d.generation IS COALESCE(s.generation, 1)))`;
/** `current`: the newest revision of a chat line, once, and not a deleted message. Needs the alias `s`. */
export const CURRENT_SOURCE = `${CURRENT_REVISION}
  AND NOT ${SOURCE_DELETED}`;

/**
 * The row that says who wrote the line of `row` and when: its first stored revision, else `row` itself. One read for a
 * later revision, none for the first.
 */
export function writtenRowOf(db: Db, row: Row): Row {
  if (!(Number(row.revision) > 1)) return row;
  const first = db
    .prepare(
      `SELECT t.* FROM sources s JOIN sources t ON ${SOURCE_FAMILY}
       WHERE s.id = ? AND t.kind IN ('seen', 'said') AND t.retired_at IS NULL AND t.revision < s.revision
       ORDER BY t.revision, t.rowid LIMIT 1`
    )
    .get(row.id);
  return first ?? row;
}
