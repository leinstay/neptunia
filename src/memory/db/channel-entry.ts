// A channel's entry of the server map: what the store keeps about a channel or a thread (src/memory/store.ts,
// `getChannel`, `touchChannel`, `updateChannel`), owned by the unit `placeCollection('channel', <place id>)`. The store
// writes it through the write kind `channel-entry` (session-write.ts) and reads it back through `channelEntryValue`
// below.
//
//   places           the channel (name, topic), under the parent and with the kind the row holds
//   descriptions     purpose, topics, tone (subject: the channel's place), one legacy version each
//   operational      kind channel: everything else (day counts, message counts, first and last message, writers,
//                    notes stamps, ...), kept as it was
//
// A write replaces the entry: the rows the value no longer holds are retired (place-owner.ts#retirePlaceAbsent), and a
// description her session reviewed keeps her version while the entry brings the text it had
// (session-rows.ts#sessionHold).

import { groupScope } from './scope.ts';
import { ifaceOf, isPlainObject, join, parseExtra, put, rowsOf, split } from './map/common.ts';
import type { Spec } from './map/common.ts';
import { storageContext } from './map/index.ts';
import {
  heldPlaceRows,
  holdsPlace,
  placeOwnerOf,
  preparedPlace,
  retirePlaceAbsent,
  stampPlaceRows,
} from './place-owner.ts';
import type { PlaceOwner } from './place-owner.ts';
import { placeCollection, keyText } from './storage-keys.ts';
import type { StorageKey } from './storage-keys.ts';
import { ensureUnit } from './storage-units.ts';
import { writeMapping } from './upsert.ts';
import { noteUnit } from './unit-write.ts';
import { dbOf, isFiniteNumber } from './types.ts';
import type { Db, MemoryHandle, Row, Rows } from './types.ts';

/** One write of the kind: the whole entry of one channel. */
export type ChannelEntryWrite = { placeId: string; value: Row };

/** What a write answers: the rows it wrote and the rows it retired. */
export type ChannelEntryResult = { upserted: number; retired: number };

/** The tables an entry's rows live in. */
const TABLES = ['places', 'descriptions', 'description_versions', 'operational'];

const PLACE_SPEC: Array<Spec> = [
  { col: 'native_id', key: 'id', type: 'text' },
  { col: 'name', key: 'name', type: 'text' },
  { col: 'topic', key: 'topic', type: 'text' },
];
const FIELDS = ['purpose', 'topics', 'tone'];

const coded = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** The rows of the entry `value` of the unit `key`, owned by `owner` (the unit's id) and `holder`. */
function channelEntryRows(db: Db, key: StorageKey, value: Row, owner: string, holder: PlaceOwner): Rows {
  const ctx = storageContext(db, key);
  const iface = ifaceOf(ctx);
  const placeId = ctx.subjectId ?? owner;
  const rows: Rows = {};
  const { cols, rest } = split(value, PLACE_SPEC);
  const scope = groupScope(iface);
  put(rows, 'places', {
    id: placeId,
    iface,
    kind: typeof ctx.subjectPlace?.kind === 'string' ? ctx.subjectPlace.kind : 'channel',
    ...cols,
    parent_id: typeof ctx.subjectPlace?.parent_id === 'string' ? ctx.subjectPlace.parent_id : null,
    scope_kind: 'group',
    extra: null,
    retired_at: null,
    owner_key: owner,
  });
  for (const field of FIELDS) {
    const text = value[field];
    if (typeof text !== 'string') continue;
    const id = `desc:${placeId}:${field}`;
    put(rows, 'descriptions', {
      id,
      subject_kind: 'place',
      subject_id: placeId,
      field,
      ...scope,
      current_version: `${id}:legacy`,
      owner_key: owner,
    });
    put(rows, 'description_versions', {
      id: `${id}:legacy`,
      description_id: id,
      text,
      author: 'import',
      written_at: null,
      chars: [...text].length,
      kept: null,
      removed: null,
      added: null,
      reason: null,
      origin: 'legacy',
      extra: null,
      owner_key: owner,
      position: 0,
    });
    delete rest[field];
  }
  // The entry's operational row keeps the owner it was first stored under.
  const stored = preparedPlace(
    db,
    "SELECT owner FROM operational WHERE kind = 'channel' AND writer = ? AND holder_id = ? ORDER BY rowid LIMIT 1"
  ).get(holder.writer, holder.holder_id);
  put(rows, 'operational', {
    kind: 'channel',
    owner: stored ? stored.owner : placeId,
    value: JSON.stringify(rest),
    owner_key: owner,
  });
  return stampPlaceRows(rows, holder);
}

/** The entry its rows give back. */
function channelEntryOf(rows: Rows): Row {
  const place = rows.places[0];
  const operational = rowsOf(rows, 'operational')[0];
  const obj = join(place, parseExtra(operational?.value), PLACE_SPEC);
  const versions = new Map(rowsOf(rows, 'description_versions').map((row) => [row.description_id, row]));
  for (const description of rowsOf(rows, 'descriptions')) {
    const version = versions.get(description.id);
    if (version) obj[String(description.field)] = version.text;
  }
  return obj;
}

/**
 * Stores the whole entry the unit `key` holds (a place's `channel` unit) inside the caller's transaction and retires
 * what it no longer holds. `legacyOwner` is an owner path of an older release.
 */
export function writeChannelEntry(
  db: Db,
  key: StorageKey,
  value: Row,
  { at, legacyOwner }: { at: string; legacyOwner?: string }
): ChannelEntryResult {
  const id = ensureUnit(db, key);
  if (legacyOwner) {
    db.prepare('INSERT OR IGNORE INTO legacy_unit_aliases(path,unit_id) VALUES (?,?)').run(legacyOwner, id);
    db.prepare('INSERT OR IGNORE INTO files(path,kind) VALUES (?,?)').run(legacyOwner, 'channel');
  }
  const holder = placeOwnerOf(key)!; // a `channel` unit always has its owner columns (place-owner.ts)
  const mapping = channelEntryRows(db, key, value, id, holder);
  if (legacyOwner) for (const list of Object.values(mapping)) for (const row of list) row.owner_file = legacyOwner;
  const upserted = writeMapping(db, mapping, id, { at, holder });
  const retired = retirePlaceAbsent(db, holder, mapping, at);
  noteUnit(db, id, 'channel', { at });
  return { upserted, retired };
}

/** A write as the writer receives it, checked. */
export function channelEntryWriteOf(update: Row): ChannelEntryWrite {
  if (!filled(update.placeId)) throw coded('CHANNEL_ENTRY_PLACE');
  if (!isPlainObject(update.value)) throw coded('CHANNEL_ENTRY_VALUE');
  return { placeId: update.placeId, value: update.value };
}

/** Whether `key` names a channel's entry. */
export const isChannelEntryKey = (key: StorageKey | undefined): boolean => key?.kind === 'channel';

/** The write of a unit update of a channel's entry (a value write of the place's own `channel` unit), else null. */
export function channelEntryOfUnit(update: Row): ChannelEntryWrite | null {
  const key = update.key as StorageKey | undefined;
  if (update.op !== 'value' || !key || !isChannelEntryKey(key) || key.subject?.type !== 'place') return null;
  if (keyText(placeCollection('channel', key.subject.id)) !== keyText(key)) return null;
  return channelEntryWriteOf({ placeId: key.subject.id, value: update.value ?? {} });
}

/** The write kind `channel-entry` on the writer connection (session-write.ts). */
export function applyChannelEntryWrite(handle: MemoryHandle, update: Row): ChannelEntryResult {
  const write = channelEntryWriteOf(update);
  const at = new Date(isFiniteNumber(update.now) ? update.now : Date.now()).toISOString();
  const key = placeCollection('channel', write.placeId);
  return handle.transaction(() => writeChannelEntry(dbOf(handle), key, write.value, { at }));
}

/** The entry the unit `key` holds (a place's `channel` unit), or not found when the database holds none. */
export function channelEntryValue(db: Db, key: StorageKey): { found: true; value: unknown } | { found: false } {
  const holder = placeOwnerOf(key);
  if (!holder || !holdsPlace(db, holder, 'operational')) return { found: false };
  return { found: true, value: channelEntryOf(heldPlaceRows(db, holder, TABLES)) };
}
