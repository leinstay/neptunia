// The intention store's reads from the database (src/intentions/store.ts reads through them): the list is the live
// `intentions` rows with `archived` 0 in position order, the archive the live rows with `archived` 1 in position order
// (intentions-write.ts writes both). Pure functions over a read connection.

import type { Db } from '../types.ts';

/** The persona's active intentions (`{ found, value }`; not found: no live record in the list). */
export function intentionsValue(db: Db): { found: true; value: unknown } | { found: false } {
  const records = db
    .prepare('SELECT record FROM intentions WHERE archived = 0 AND retired_at IS NULL ORDER BY position, rowid')
    .all()
    .map((row) => JSON.parse(String(row.record)) as unknown);
  return records.length > 0 ? { found: true, value: { intentions: records } } : { found: false };
}

/** The lines (JSON text) of the persona's archived intentions, in order. */
export const intentionsArchiveLines = (db: Db): Array<string> =>
  db
    .prepare('SELECT record FROM intentions WHERE archived = 1 AND retired_at IS NULL ORDER BY position, rowid')
    .all()
    .map((row) => String(row.record));
