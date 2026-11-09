// The stretches of a place's chats she took part in (src/memory/store.ts, `participationEntry`, and
// src/memory/participation.ts), owned by the unit `placeCollection('participation', <place id>)`. The store writes
// them through the write kind `participation-episodes` (session-write.ts) and reads them back through
// `participationValue` below.
//
//   episodes          one per stretch, kind participation: its chat as the place, `startAt` and `lastAt` as start_ms
//                     and last_ms, the messages kept whole in `extra.messages`; its `itemId` as the episode id, a
//                     derived id marked `$derived` when it has none
//   episode_sources   one link per message id to the line the record holds (participation-sources.ts resolves it)
//   operational       kind participation: the rest of the value (`nextId`)
//
// A write replaces the stretches: the episodes and links it no longer holds are retired
// (place-owner.ts#retirePlaceAbsent).

import { channelPlaceId, itemOrDerivedId, nativeOf, nativeOfAny, uniqueIds } from './ids.ts';
import { LEGACY_IFACE } from './legacy-namespace.ts';
import { groupScope } from './scope.ts';
import { extraText, ifaceOf, isPlainObject, join, ordered, parseExtra, put, rowsOf, split } from './map/common.ts';
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
import { asText, dbOf, isFiniteNumber } from './types.ts';
import type { Db, MemoryHandle, Row, Rows } from './types.ts';

/** One write of the kind: the whole participation of one place. */
export type ParticipationWrite = { placeId: string; value: Row };

/** What a write answers: the rows it wrote and the rows it retired. */
export type ParticipationResult = { upserted: number; retired: number };

const SPEC: Array<Spec> = [
  {
    col: 'place_id',
    key: 'placeId',
    type: 'text',
    ok: (v: unknown) => nativeOf(channelPlaceId(LEGACY_IFACE, v)) === v,
    enc: (v: unknown, iface: string) => channelPlaceId(iface, v),
    dec: nativeOfAny,
  },
  { col: 'start_ms', key: 'startAt', type: 'num' },
  { col: 'last_ms', key: 'lastAt', type: 'num' },
];

/** The reference of a message's line that participation-sources.ts resolves. */
const messageSourceRef = (iface: string, messageId: unknown): string => `src:${iface}:${asText(messageId)}`;

const coded = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** The episode rows and message links of `episodes` into `rows`. */
function putEpisodes(rows: Rows, episodes: ReadonlyArray<Row>, iface: string, owner: string): void {
  const uniq = uniqueIds();
  episodes.forEach((episode: Row, position: number) => {
    const part = split(episode, SPEC, iface);
    const itemId = typeof episode.itemId === 'string' && episode.itemId ? episode.itemId : null;
    const base =
      itemId ??
      itemOrDerivedId(null, 'participation', episode.placeId ?? '', episode.startAt ?? '', episode.id ?? position);
    const id = uniq(base);
    if (itemId && id === base) delete part.rest.itemId;
    else part.rest.$derived = true;
    put(rows, 'episodes', {
      id,
      ...part.cols,
      kind: 'participation',
      subject_id: null,
      extra: extraText(part.rest),
      ...groupScope(iface),
      created_at: null,
      retired_at: null,
      owner_key: owner,
      position,
    });
    const messages: Array<unknown> = Array.isArray(episode.messages) ? episode.messages : [];
    messages.forEach((message, index) => {
      if (isPlainObject(message) && typeof message.id === 'string')
        put(rows, 'episode_sources', {
          episode_id: id,
          source_id: messageSourceRef(iface, message.id),
          position: index,
        });
    });
  });
}

/** The rows of the participation `value` of the unit `key`, owned by `owner` (the unit's id) and `holder`. */
function participationRows(db: Db, key: StorageKey, value: Row, owner: string, holder: PlaceOwner): Rows {
  const iface = ifaceOf(storageContext(db, key));
  const rows: Rows = {};
  const rest = { ...value };
  const has = [];
  if (Array.isArray(value.episodes) && value.episodes.every(isPlainObject)) {
    putEpisodes(rows, value.episodes, iface, owner);
    delete rest.episodes;
    has.push('episodes');
  }
  rest.$has = has;
  // The operational row keeps the owner it was first stored under, the unit's id.
  const stored = preparedPlace(
    db,
    "SELECT owner FROM operational WHERE kind = 'participation' AND writer = ? AND holder_id = ? ORDER BY rowid LIMIT 1"
  ).get(holder.writer, holder.holder_id);
  put(rows, 'operational', {
    kind: 'participation',
    owner: stored ? stored.owner : owner,
    value: JSON.stringify(rest),
    owner_key: owner,
  });
  return stampPlaceRows(rows, holder);
}

/** The participation its rows give back. */
function participationOf(rows: Rows): Row {
  const rest = parseExtra(rowsOf(rows, 'operational')[0]?.value);
  const has = Array.isArray(rest.$has) ? rest.$has : [];
  delete rest.$has;
  const obj = { ...rest };
  if (has.includes('episodes')) {
    obj.episodes = ordered(rows, 'episodes').map((row) => {
      const extra = parseExtra(row.extra);
      const derived = extra.$derived === true;
      delete extra.$derived;
      const episode = join(row, extra, SPEC);
      if (!derived) episode.itemId = row.id;
      return episode;
    });
  }
  return obj;
}

/**
 * Stores the whole participation the unit `key` holds (a place's `participation` unit) inside the caller's transaction
 * and retires what it no longer holds. `legacyOwner` is an owner path of an older release.
 */
export function writeParticipation(
  db: Db,
  key: StorageKey,
  value: Row,
  { at, legacyOwner }: { at: string; legacyOwner?: string }
): ParticipationResult {
  const id = ensureUnit(db, key);
  if (legacyOwner) {
    db.prepare('INSERT OR IGNORE INTO legacy_unit_aliases(path,unit_id) VALUES (?,?)').run(legacyOwner, id);
    db.prepare('INSERT OR IGNORE INTO files(path,kind) VALUES (?,?)').run(legacyOwner, 'participation');
  }
  const holder = placeOwnerOf(key)!; // a `participation` unit always has its owner columns (place-owner.ts)
  const mapping = participationRows(db, key, value, id, holder);
  if (legacyOwner) for (const list of Object.values(mapping)) for (const row of list) row.owner_file = legacyOwner;
  const upserted = writeMapping(db, mapping, id, { at, holder });
  const retired = retirePlaceAbsent(db, holder, mapping, at);
  noteUnit(db, id, 'participation', { at });
  return { upserted, retired };
}

/** A write as the writer receives it, checked. */
export function participationWriteOf(update: Row): ParticipationWrite {
  if (!filled(update.placeId)) throw coded('PARTICIPATION_PLACE');
  // A value of another shape, such as a list a hand edit left, is stored as its fields and read back malformed.
  if (typeof update.value !== 'object' || update.value === null) throw coded('PARTICIPATION_VALUE');
  return { placeId: update.placeId, value: update.value as Row };
}

/** Whether `key` names a place's participation. */
export const isParticipationKey = (key: StorageKey | undefined): boolean =>
  key?.kind === 'participation' && key.subject?.type === 'place';

/** The write of a unit update of a participation (a value write of the place's own unit), else null. */
export function participationOfUnit(update: Row): ParticipationWrite | null {
  const key = update.key as StorageKey | undefined;
  if (update.op !== 'value' || !key || !isParticipationKey(key)) return null;
  if (keyText(placeCollection('participation', key.subject.id)) !== keyText(key)) return null;
  return participationWriteOf({ placeId: key.subject.id, value: update.value ?? {} });
}

/** The write kind `participation-episodes` on the writer connection (session-write.ts). */
export function applyParticipationWrite(handle: MemoryHandle, update: Row): ParticipationResult {
  const write = participationWriteOf(update);
  const at = new Date(isFiniteNumber(update.now) ? update.now : Date.now()).toISOString();
  const key = placeCollection('participation', write.placeId);
  return handle.transaction(() => writeParticipation(dbOf(handle), key, write.value, { at }));
}

/** The participation the unit `key` holds (a place's `participation` unit), or not found when none is stored. */
export function participationValue(db: Db, key: StorageKey): { found: true; value: unknown } | { found: false } {
  const holder = placeOwnerOf(key);
  if (!holder || !holdsPlace(db, holder, 'operational')) return { found: false };
  return { found: true, value: participationOf(heldPlaceRows(db, holder, ['episodes', 'operational'])) };
}
