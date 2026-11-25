// The lines the persona said lately in a place and does not want to repeat (src/memory/recent.ts), owned by the unit
// `placeCollection('recent', <place id>)`. The engine has no writer of them: the rows a database holds came from earlier
// versions, and `recentLinesValue` below reads them back for the store (src/memory/store.ts#getRecent).
//
//   claims        one per line, kind recent_line, subject the line's chat: its text, weight and `addedAt`; the line's
//                 numeric `id`, `at` and `who` in `extra`; its `itemId` as the claim id, a derived id marked `$derived`
//                 when it had none
//   operational   kind recent: the rest of the value (`nextId`, ...)

import { join, ordered, parseExtra, rowsOf } from './row-columns.ts';
import type { Spec } from './row-columns.ts';
import { channelColumn } from './native-rows.ts';
import { heldPlaceRows, holdsPlace, placeHolderOf } from './place-holder.ts';
import type { UnitKey } from './unit-keys.ts';
import type { Db, Row, Rows } from './types.ts';

/** The columns of an item: its chat by the chat's place (native-rows.ts#channelColumn). */
const specOf = (db: Db): Array<Spec> => [
  channelColumn(db, 'subject_id'),
  { col: 'text', key: 'text', type: 'text' },
  { col: 'weight', key: 'weight', type: 'num' },
  { col: 'created_at', key: 'addedAt', type: 'text' },
];

/** The recent lines their rows give back. */
function recentLinesOf(db: Db, rows: Rows): Row {
  const spec = specOf(db);
  const rest = parseExtra(rowsOf(rows, 'operational')[0]?.value);
  const has = Array.isArray(rest.$has) ? rest.$has : [];
  delete rest.$has;
  const obj = { ...rest };
  if (has.includes('lines')) {
    obj.lines = ordered(rows, 'claims').map((row) => {
      const extra = parseExtra(row.extra);
      const derived = extra.$derived === true;
      delete extra.$derived;
      const line = join(row, extra, spec);
      if (!derived) line.itemId = row.id;
      return line;
    });
  }
  return obj;
}

/** The recent lines the unit `key` holds (a place's `recent` unit), or not found when the database holds none. */
export function recentLinesValue(db: Db, key: UnitKey): { found: true; value: unknown } | { found: false } {
  const holder = placeHolderOf(key);
  if (!holder || !holdsPlace(db, holder, 'operational')) return { found: false };
  return { found: true, value: recentLinesOf(db, heldPlaceRows(db, holder, ['claims', 'operational'])) };
}
