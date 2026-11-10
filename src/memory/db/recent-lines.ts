// The lines she said lately in a place and does not want to repeat (src/memory/store.ts, `recentEntry`, and
// src/memory/recent.ts), owned by the unit `placeCollection('recent', <place id>)`. The store writes them through the
// write kind `recent-lines` (session-write.ts) and reads them back through `recentLinesValue` below.
//
//   claims        one per line, kind recent_line, subject the line's chat: its text, weight and `addedAt`; the line's
//                 numeric `id`, `at` and `who` in `extra`; its `itemId` as the claim id, a derived id marked `$derived`
//                 when it has none
//   operational   kind recent: the rest of the value (`nextId`, ...)
//
// A write replaces the lines: the ones it no longer holds are retired (place-owner.ts#retirePlaceAbsent).

import { itemOrDerivedId, uniqueIds } from './ids.ts';
import { groupScope } from './scope.ts';
import { extraText, ifaceOf, isPlainObject, join, ordered, parseExtra, put, rowsOf, split } from './row-columns.ts';
import type { Spec } from './row-columns.ts';
import { storageContext } from './storage-context.ts';
import { channelColumn } from './native-rows.ts';
import {
  heldPlaceRows,
  holdsPlace,
  placeOwnerOf,
  preparedPlace,
  retirePlaceAbsent,
  stampPlaceRows,
} from './place-owner.ts';
import type { PlaceOwner } from './place-owner.ts';
import { placeCollection, keyText, collectionId } from './unit-keys.ts';
import { namedIface } from './live-iface.ts';
import type { UnitKey } from './unit-keys.ts';
import { writeMapping } from './upsert.ts';
import { dbOf, isFiniteNumber } from './types.ts';
import type { Db, MemoryHandle, Row, Rows } from './types.ts';

/** One write of the kind: the whole recent lines of one place. */
export type RecentLinesWrite = { placeId: string; value: Row };

/** What a write answers: the rows it wrote and the rows it retired. */
export type RecentLinesResult = { upserted: number; retired: number };

/** The columns of an item: its chat by the chat's place (native-rows.ts#channelColumn). */
const specOf = (db: Db): Array<Spec> => [
  channelColumn(db, 'subject_id'),
  { col: 'text', key: 'text', type: 'text' },
  { col: 'weight', key: 'weight', type: 'num' },
  { col: 'created_at', key: 'addedAt', type: 'text' },
];

const coded = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** The rows of the recent lines `value` of the unit `key`, owned by `holder`, `owner` the unit's id. */
function recentLinesRows(
  db: Db,
  key: UnitKey,
  value: Row,
  owner: string,
  holder: PlaceOwner,
  writeIface?: string
): Rows {
  const spec = specOf(db);
  const iface = ifaceOf(storageContext(db, key, writeIface));
  const rows: Rows = {};
  const rest = { ...value };
  const has = [];
  if (Array.isArray(value.lines) && value.lines.every(isPlainObject)) {
    const uniq = uniqueIds();
    value.lines.forEach((line: Row, position: number) => {
      const part = split(line, spec, iface);
      const itemId = typeof line.itemId === 'string' && line.itemId ? line.itemId : null;
      const base =
        itemId ?? itemOrDerivedId(null, 'recent_line', line.placeId ?? '', line.at ?? '', line.id ?? position);
      const id = uniq(base);
      if (itemId && id === base) delete part.rest.itemId;
      else part.rest.$derived = true;
      put(rows, 'claims', {
        id,
        ...part.cols,
        subject_kind: 'place',
        kind: 'recent_line',
        extra: extraText(part.rest),
        first_seen_at: null,
        last_seen_at: null,
        valid_to: null,
        superseded_by: null,
        how: 'legacy',
        author: 'import',
        from_person: null,
        truth: 'current',
        shown: 1,
        ...groupScope(iface),
        retired_at: null,
        position,
      });
    });
    delete rest.lines;
    has.push('lines');
  }
  rest.$has = has;
  // The operational row keeps the owner it was first stored under, the unit's id.
  const stored = preparedPlace(
    db,
    "SELECT owner FROM operational WHERE kind = 'recent' AND writer = ? AND holder_id = ? ORDER BY rowid LIMIT 1"
  ).get(holder.writer, holder.holder_id);
  put(rows, 'operational', {
    kind: 'recent',
    owner: stored ? stored.owner : owner,
    value: JSON.stringify(rest),
  });
  return stampPlaceRows(rows, holder);
}

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

/**
 * Stores the whole recent lines the unit `key` holds (a place's `recent` unit) inside the caller's transaction and
 * retires what they no longer hold.
 */
export function writeRecentLines(
  db: Db,
  key: UnitKey,
  value: Row,
  { at, iface }: { at: string; iface?: string }
): RecentLinesResult {
  const id = collectionId(key);
  const holder = placeOwnerOf(key)!; // a `recent` unit always has its owner columns (place-owner.ts)
  const mapping = recentLinesRows(db, key, value, id, holder, iface);
  const upserted = writeMapping(db, mapping, { at });
  const retired = retirePlaceAbsent(db, holder, mapping, at);
  return { upserted, retired };
}

/** A write as the writer receives it, checked. */
export function recentLinesWriteOf(update: Row): RecentLinesWrite {
  if (!filled(update.placeId)) throw coded('RECENT_LINES_PLACE');
  // A value of another shape, such as a list a hand edit left, is stored as its fields and read back malformed.
  if (typeof update.value !== 'object' || update.value === null) throw coded('RECENT_LINES_VALUE');
  return { placeId: update.placeId, value: update.value as Row };
}

/** Whether `key` names a place's recent lines. */
export const isRecentLinesKey = (key: UnitKey | undefined): boolean =>
  key?.kind === 'recent' && key.subject?.type === 'place';

/** The write of a unit update of recent lines (a value write of the place's own `recent` unit), else null. */
export function recentLinesOfUnit(update: Row): RecentLinesWrite | null {
  const key = update.key as UnitKey | undefined;
  if (update.op !== 'value' || !key || !isRecentLinesKey(key)) return null;
  if (keyText(placeCollection('recent', key.subject.id)) !== keyText(key)) return null;
  return recentLinesWriteOf({ placeId: key.subject.id, value: update.value ?? {} });
}

/** The write kind `recent-lines` on the writer connection (session-write.ts). */
export function applyRecentLinesWrite(handle: MemoryHandle, update: Row): RecentLinesResult {
  const write = recentLinesWriteOf(update);
  const at = new Date(isFiniteNumber(update.now) ? update.now : Date.now()).toISOString();
  const key = placeCollection('recent', write.placeId);
  return handle.transaction(() =>
    writeRecentLines(dbOf(handle), key, write.value, { at, iface: namedIface(update) ?? undefined })
  );
}

/** The recent lines the unit `key` holds (a place's `recent` unit), or not found when the database holds none. */
export function recentLinesValue(db: Db, key: UnitKey): { found: true; value: unknown } | { found: false } {
  const holder = placeOwnerOf(key);
  if (!holder || !holdsPlace(db, holder, 'operational')) return { found: false };
  return { found: true, value: recentLinesOf(db, heldPlaceRows(db, holder, ['claims', 'operational'])) };
}
