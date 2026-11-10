// A place's lorebook: the entries the owner and she keep about a place (src/memory/store.ts, `getLore`, `setLore` and
// the lore tool), owned by the unit `placeCollection('lore', <place id>)`. The store writes it through the write kind
// `place-lore` (session-write.ts) and reads it back through `placeLoreValue` below.
//
//   claims   one per entry, kind lore, subject the place: the entry's text, its weight, `createdAt` and `updatedAt` as
//            the first and last seen stamps, and `source` as the author; the title, keys and the always flag in
//            `extra`; the entry's own id after `lore:` in the claim id
//
// A write replaces the lorebook: the entries it no longer holds are retired (place-owner.ts#retirePlaceAbsent). A
// lorebook with no entry holds no row, so it reads as not found, which the store reads as the empty lorebook.

import { uniqueIds } from './ids.ts';
import { groupScope } from './scope.ts';
import { extraText, ifaceOf, isPlainObject, join, ordered, parseExtra, put, split } from './row-columns.ts';
import type { Spec } from './row-columns.ts';
import { storageContext } from './storage-context.ts';
import { heldPlaceRows, placeOwnerOf, retirePlaceAbsent, stampPlaceRows } from './place-owner.ts';
import type { PlaceOwner } from './place-owner.ts';
import { placeCollection, keyText, collectionId } from './unit-keys.ts';
import { namedIface } from './live-iface.ts';
import type { UnitKey } from './unit-keys.ts';
import { writeMapping } from './upsert.ts';
import { dbOf, isFiniteNumber } from './types.ts';
import type { Db, MemoryHandle, Row, Rows } from './types.ts';

/** One write of the kind: the whole lorebook of one place, its list of entries or `{ entries }`. */
export type PlaceLoreWrite = { placeId: string; value: ReadonlyArray<Row> | Row };

/** What a write answers: the rows it wrote and the rows it retired. */
export type PlaceLoreResult = { upserted: number; retired: number };

const SPEC: Array<Spec> = [
  { col: 'text', key: 'text', type: 'text' },
  { col: 'weight', key: 'weight', type: 'num' },
  { col: 'first_seen_at', key: 'createdAt', type: 'text' },
  { col: 'last_seen_at', key: 'updatedAt', type: 'text' },
  { col: 'author', key: 'source', type: 'text' },
];

const PREFIX = 'lore:';

const coded = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** The rows of the lorebook `value` of the unit `key`, owned by `holder`, `owner` the unit's id. */
function placeLoreRows(
  db: Db,
  key: UnitKey,
  value: PlaceLoreWrite['value'],
  owner: string,
  holder: PlaceOwner,
  writeIface?: string
): Rows {
  const entries: ReadonlyArray<Row> = Array.isArray(value)
    ? value
    : ((value as { entries?: ReadonlyArray<Row> }).entries ?? []);
  const ctx = storageContext(db, key, writeIface);
  const iface = ifaceOf(ctx);
  const rows: Rows = {};
  const uniq = uniqueIds();
  const placeId = ctx.subjectId ?? owner;
  entries.forEach((entry: Row, position: number) => {
    const part = split(entry, SPEC);
    const wanted = typeof entry.id === 'string' && entry.id !== '' ? `${PREFIX}${entry.id}` : null;
    const id = uniq(wanted ?? `${PREFIX}#${position}`);
    if (wanted && id === wanted) delete part.rest.id;
    else part.rest.$noId = true;
    put(rows, 'claims', {
      id,
      subject_kind: 'place',
      subject_id: placeId,
      kind: 'lore',
      from_person: null,
      how: 'legacy',
      truth: 'current',
      shown: 1,
      ...part.cols,
      extra: extraText(part.rest),
      ...groupScope(iface),
      created_at: null,
      retired_at: null,
      position,
    });
  });
  return stampPlaceRows(rows, holder);
}

/** The lorebook its rows give back. */
function placeLoreOf(rows: Rows): Array<Row> {
  return ordered(rows, 'claims').map((row) => {
    const rest = parseExtra(row.extra);
    const noId = rest.$noId === true;
    delete rest.$noId;
    const obj = join(row, rest, SPEC);
    if (!noId) obj.id = String(row.id).slice(PREFIX.length);
    return obj;
  });
}

/**
 * Stores the whole lorebook the unit `key` holds (a place's `lore` unit) inside the caller's transaction and retires
 * what it no longer holds.
 */
export function writePlaceLore(
  db: Db,
  key: UnitKey,
  value: PlaceLoreWrite['value'],
  { at, iface }: { at: string; iface?: string }
): PlaceLoreResult {
  const id = collectionId(key);
  const holder = placeOwnerOf(key)!; // a `lore` unit always has its owner columns (place-owner.ts)
  const mapping = placeLoreRows(db, key, value, id, holder, iface);
  const upserted = writeMapping(db, mapping, { at });
  const retired = retirePlaceAbsent(db, holder, mapping, at);
  return { upserted, retired };
}

/** A write as the writer receives it, checked. */
export function placeLoreWriteOf(update: Row): PlaceLoreWrite {
  if (!filled(update.placeId)) throw coded('PLACE_LORE_PLACE');
  if (!Array.isArray(update.value) && !isPlainObject(update.value)) throw coded('PLACE_LORE_VALUE');
  return { placeId: update.placeId, value: update.value as PlaceLoreWrite['value'] };
}

/** Whether `key` names a place's lorebook. */
export const isPlaceLoreKey = (key: UnitKey | undefined): boolean =>
  key?.kind === 'lore' && key.subject?.type === 'place';

/** The write of a unit update of a lorebook (a value write of the place's own `lore` unit), else null. */
export function placeLoreOfUnit(update: Row): PlaceLoreWrite | null {
  const key = update.key as UnitKey | undefined;
  if (update.op !== 'value' || !key || !isPlaceLoreKey(key)) return null;
  if (keyText(placeCollection('lore', key.subject.id)) !== keyText(key)) return null;
  return placeLoreWriteOf({ placeId: key.subject.id, value: update.value ?? [] });
}

/** The write kind `place-lore` on the writer connection (session-write.ts). */
export function applyPlaceLoreWrite(handle: MemoryHandle, update: Row): PlaceLoreResult {
  const write = placeLoreWriteOf(update);
  const at = new Date(isFiniteNumber(update.now) ? update.now : Date.now()).toISOString();
  const key = placeCollection('lore', write.placeId);
  return handle.transaction(() =>
    writePlaceLore(dbOf(handle), key, write.value, { at, iface: namedIface(update) ?? undefined })
  );
}

/** The lorebook the unit `key` holds (a place's `lore` unit), or not found when the database holds no entry of it. */
export function placeLoreValue(db: Db, key: UnitKey): { found: true; value: unknown } | { found: false } {
  const holder = placeOwnerOf(key);
  const rows = holder ? heldPlaceRows(db, holder, ['claims']) : {};
  return rows.claims?.length ? { found: true, value: placeLoreOf(rows) } : { found: false };
}
