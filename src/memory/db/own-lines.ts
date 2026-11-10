// Her own lines stored twice (version step 54, schema.ts): before the message pipeline of 2026-10-26 the record also
// stored the echo of a line of hers as a member's `seen` line under her own account, beside her `said` line. A read of
// that chat showed the line twice. The step retires each such `seen` line: one of an account of `person:self` whose
// chat holds a live `said` line of the same text, and its graph node follows.

import { projectRow } from './graph.ts';
import type { Db } from './types.ts';

/** Retires her lines stored again as `seen` lines of her own account; answers how many. */
export function retireOwnLinesSeenTwice(db: Db, at: string): number {
  const ids = db
    .prepare(
      `SELECT s.id FROM sources s JOIN accounts a ON a.id = s.author_account
       WHERE s.kind = 'seen' AND s.retired_at IS NULL AND a.person_id = 'person:self'
         AND (s.place_id, s.text) IN (SELECT place_id, text FROM sources WHERE kind = 'said' AND retired_at IS NULL)`
    )
    .all()
    .map((row) => String(row.id));
  const retire = db.prepare('UPDATE sources SET retired_at = ? WHERE id = ?');
  for (const id of ids) {
    retire.run(at, id);
    projectRow(db, 'sources', { id }, { at });
  }
  return ids.length;
}
