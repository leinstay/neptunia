// A member's private layer: what she learned about the member in their direct chat (src/memory/store.ts,
// `getPrivate`, `applyPrivateOps`, `addPrivateEpisodes`), owned by the unit `accountCollection('private', <account
// id>)`. The store writes it through the write kind `private-layer` (session-write.ts) and reads it back through
// `privateLayerValue` below. No `people` or `accounts` row: those belong to the account's profile (account-profile.ts).
//
//   claims, episodes, descriptions (relationship), affinity_events    as in a profile, scoped to the stored DM place
//                                of the account, or to the person's own DM before the place exists
//   operational (kind private)   the rest: the affinity score, reason and decay stamp, first/last seen, detailsSeq,
//                                relationshipScore, `replies`, `buffer`, ...
//
// A write replaces the layer: the rows the value no longer holds are retired (upsert.ts#retireAbsent), and what her
// session wrote last stays as she wrote it (session-rows.ts#sessionHold). A read adds what her session wrote about the
// person in the direct chat (session-rows.ts#addSessionRows).

import { personId } from './ids.ts';
import { dmScope } from './scope.ts';
import { historyFrom, profileFrom, profileRows } from './map/lists.ts';
import { ifaceOf, isPlainObject, parseExtra, put, rowsOf } from './map/common.ts';
import { storageContext } from './map/index.ts';
import { dmPlaceScope } from './map/scope-parts.ts';
import { dmOfAccount } from './meta-person.ts';
import { addSessionRows } from './session-rows.ts';
import { accountCollection, keyText } from './storage-keys.ts';
import type { StorageKey } from './storage-keys.ts';
import { ensureUnit } from './storage-units.ts';
import { writeMapping } from './upsert.ts';
import { heldRows, holdsAny, profileOwnerOf, retireProfileAbsent, stampProfileRows } from './profile-owner.ts';
import { noteUnit } from './unit-write.ts';
import { dbOf, isFiniteNumber } from './types.ts';
import type { Db, MemoryHandle, Row, Rows } from './types.ts';

/** One write of the kind: the whole private layer of one account. */
export type PrivateLayerWrite = { accountId: string; value: Row };

/** What a write answers: the rows it wrote and the rows it retired. */
export type PrivateLayerResult = { upserted: number; retired: number };

/** The tables a private layer's rows live in. */
const TABLES = ['claims', 'descriptions', 'description_versions', 'episodes', 'affinity_events', 'operational'];

const FIELDS = ['relationship'];

const coded = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** The rows of a private layer `value` of the unit `key`, owned by `owner` (the unit's id). */
function privateLayerRows(db: Db, key: StorageKey, value: Row, owner: string): Rows {
  const ctx = storageContext(db, key);
  const iface = ifaceOf(ctx);
  const person = ctx.subjectPersonId ?? personId(iface, ctx.subjectNativeId ?? owner);
  const place = key.subject.type === 'account' ? dmOfAccount(db, key.subject.id) : (ctx.dmPlace ?? null);
  const rows: Rows = {};
  const { rest, affinity } = profileRows(rows, value, {
    rel: owner,
    person,
    owner: `${person}:dm`,
    tag: ':dm',
    scope: place ? dmPlaceScope(iface, place) : dmScope(person, iface),
    descFields: FIELDS,
  });
  if (affinity) rest.affinity = affinity;
  // The layer's operational row keeps the owner it was first stored under.
  const holder = profileOwnerOf(key)!; // a `private` unit always has its owner columns (profile-owner.ts)
  const stored = db
    .prepare(
      "SELECT owner FROM operational WHERE kind = 'private' AND writer = ? AND holder_id = ? ORDER BY rowid LIMIT 1"
    )
    .get(holder.writer, holder.holder_id);
  put(rows, 'operational', {
    kind: 'private',
    owner: stored ? stored.owner : person,
    value: JSON.stringify(rest),
    owner_key: owner,
  });
  // The shared profile pieces name their unit as `owner_file` (map/lists.ts): the unit's id is their owner.
  for (const list of Object.values(rows))
    for (const row of list) {
      if (row.owner_file === undefined) continue;
      delete row.owner_file;
      row.owner_key = owner;
    }
  return stampProfileRows(rows, holder);
}

/** The private layer its rows give back. */
function privateLayerOf(rows: Rows): Row {
  const row = rowsOf(rows, 'operational')[0];
  const rest = parseExtra(row?.value);
  const has: Array<string> = Array.isArray(rest.$has) ? (rest.$has as Array<string>) : [];
  delete rest.$has;
  const affinity = has.includes('affinity') && isPlainObject(rest.affinity) ? rest.affinity : null;
  const obj: Row = { ...rest };
  if (has.includes('affinity')) delete obj.affinity;
  Object.assign(obj, profileFrom(rows, has));
  if (has.includes('affinity')) {
    const merged: Row = { ...(affinity ?? {}) };
    if (has.includes('affinity.history')) merged.history = historyFrom(rows);
    obj.affinity = merged;
  }
  return obj;
}

/**
 * Stores the whole private layer the unit `key` holds (an account's `private` unit) inside the caller's transaction and
 * retires what it no longer holds. `legacyOwner` is an owner path of an older release.
 */
export function writePrivateLayer(
  db: Db,
  key: StorageKey,
  value: Row,
  { at, legacyOwner }: { at: string; legacyOwner?: string }
): PrivateLayerResult {
  const id = ensureUnit(db, key);
  if (legacyOwner) {
    db.prepare('INSERT OR IGNORE INTO legacy_unit_aliases(path,unit_id) VALUES (?,?)').run(legacyOwner, id);
    db.prepare('INSERT OR IGNORE INTO files(path,kind) VALUES (?,?)').run(legacyOwner, 'private');
  }
  const mapping = privateLayerRows(db, key, value, id);
  if (legacyOwner) for (const list of Object.values(mapping)) for (const row of list) row.owner_file = legacyOwner;
  const upserted = writeMapping(db, mapping, id, { at });
  const retired = retireProfileAbsent(db, profileOwnerOf(key)!, mapping, at); // as above
  noteUnit(db, id, 'private', { at });
  return { upserted, retired };
}

/** A write as the writer receives it, checked. */
export function privateLayerWriteOf(update: Row): PrivateLayerWrite {
  if (!filled(update.accountId)) throw coded('PRIVATE_LAYER_ACCOUNT');
  if (!isPlainObject(update.value)) throw coded('PRIVATE_LAYER_VALUE');
  return { accountId: update.accountId, value: update.value };
}

/** Whether `key` names a private layer. */
export const isPrivateLayerKey = (key: StorageKey): boolean => key.kind === 'private';

/**
 * The write of a unit update of a private layer (a value write of the account's own `private` unit), else null. Any
 * other key of the kind stays a unit write, which the writer stores through the same path.
 */
export function privateLayerOfUnit(update: Row): PrivateLayerWrite | null {
  const key = update.key as StorageKey | undefined;
  if (update.op !== 'value' || key?.kind !== 'private' || key.subject?.type !== 'account') return null;
  if (keyText(accountCollection('private', key.subject.id)) !== keyText(key)) return null;
  return privateLayerWriteOf({ accountId: key.subject.id, value: update.value ?? {} });
}

/** The write kind `private-layer` on the writer connection (session-write.ts). */
export function applyPrivateLayerWrite(handle: MemoryHandle, update: Row): PrivateLayerResult {
  const write = privateLayerWriteOf(update);
  const at = new Date(isFiniteNumber(update.now) ? update.now : Date.now()).toISOString();
  const key = accountCollection('private', write.accountId);
  return handle.transaction(() => writePrivateLayer(dbOf(handle), key, write.value, { at }));
}

/** The private layer the unit `key` holds, or not found when the database holds no such unit. */
export function privateLayerValue(db: Db, key: StorageKey): { found: true; value: unknown } | { found: false } {
  const holder = profileOwnerOf(key);
  if (!holder || !holdsAny(db, holder, 'operational')) return { found: false };
  const rows = heldRows(db, holder, TABLES);
  addSessionRows(db, 'private', rows, key.subject.type === 'account' ? key.subject.id : null);
  return { found: true, value: privateLayerOf(rows) };
}
