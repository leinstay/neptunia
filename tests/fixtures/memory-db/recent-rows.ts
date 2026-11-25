// A place's recent lines as rows in the format earlier versions of the engine stored them (src/memory/db/recent-lines.ts
// reads them): one `recent_line` claim per line and one `recent` operational row with the rest of the value, every row
// held by the writer `recent` and the place. The engine has no writer of them, so the tests of their readers seed them
// here with `insertRows`. A seed replaces the lines the place held before. Synthetic data only.
import { itemOrDerivedId, uniqueIds } from '../../../src/memory/db/ids.ts';
import { channelColumn } from '../../../src/memory/db/native-rows.ts';
import { stampPlaceRows } from '../../../src/memory/db/place-holder.ts';
import { extraText, isPlainObject, put, split } from '../../../src/memory/db/row-columns.ts';
import type { Spec } from '../../../src/memory/db/row-columns.ts';
import { insertRows } from '../../../src/memory/db/rows.ts';
import { groupScope } from '../../../src/memory/db/scope.ts';
import { collectionId, placeCollection } from '../../../src/memory/db/unit-keys.ts';
import type { Db, Row, Rows } from '../../../src/memory/db/types.ts';

const specOf = (db: Db): Array<Spec> => [
  channelColumn(db, 'subject_id'),
  { col: 'text', key: 'text', type: 'text' },
  { col: 'weight', key: 'weight', type: 'num' },
  { col: 'created_at', key: 'addedAt', type: 'text' },
];

/** The rows of the recent lines `value` of the place `placeId`, as they were stored. */
function recentRows(db: Db, placeId: string, value: Row, iface: string): Rows {
  const spec = specOf(db);
  const rows: Rows = {};
  const rest = { ...value };
  const has = [];
  if (Array.isArray(value.lines) && value.lines.every(isPlainObject)) {
    const uniq = uniqueIds();
    value.lines.forEach((line: Row, position: number) => {
      const part = split(line, spec, iface);
      const itemId = typeof line.itemId === 'string' && line.itemId ? line.itemId : null;
      // A derived id is never read back; the holder in it keeps two places' equal lines apart under insertRows.
      const base =
        itemId ?? itemOrDerivedId(null, 'recent_line', placeId, line.placeId ?? '', line.at ?? '', line.id ?? position);
      const id = uniq(base);
      if (itemId && id === base) delete part.rest.itemId;
      else part.rest.$derived = true;
      put(rows, 'claims', {
        id,
        ...part.cols,
        subject_kind: 'place',
        kind: 'recent_line',
        extra: extraText(part.rest),
        how: 'legacy',
        author: 'import',
        truth: 'current',
        shown: 1,
        ...groupScope(iface),
        position,
      });
    });
    delete rest.lines;
    has.push('lines');
  }
  rest.$has = has;
  put(rows, 'operational', {
    kind: 'recent',
    owner: collectionId(placeCollection('recent', placeId)),
    value: JSON.stringify(rest),
  });
  return stampPlaceRows(rows, { writer: 'recent', holder_id: placeId });
}

/**
 * Stores `value` as the recent lines of `placeId` on the connection `db`, retiring the rows of the lines the place held
 * before. `iface` is the interface of the lines' chats, `at` the moment the rows are stamped with.
 */
export function seedRecentLines(
  db: Db,
  placeId: string,
  value: Row,
  { iface = 'discord', at = new Date().toISOString() }: { iface?: string; at?: string } = {}
): void {
  for (const table of ['claims', 'operational'])
    db.prepare(
      `UPDATE "${table}" SET retired_at = ? WHERE writer = 'recent' AND holder_id = ? AND retired_at IS NULL`
    ).run(at, placeId);
  insertRows(db, recentRows(db, placeId, value, iface), { at });
}
