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
// A write replaces the layer: the rows the value no longer holds are retired (profile-owner.ts#retireProfileAbsent), and what her
// session wrote last stays as she wrote it (session-rows.ts#sessionHold). A read adds what her session wrote about the
// person in the direct chat (session-rows.ts#addSessionRows).

import { mintMetaPerson } from './meta-person-write.ts';
import { ensureAccountPerson } from './person-links.ts';
import { dmScope } from './scope.ts';
import { historyFrom, profileFrom, profileRows } from './profile-lists.ts';
import { ifaceOf, isPlainObject, parseExtra, put, rowsOf } from './row-columns.ts';
import { storageContext } from './storage-context.ts';
import { dmPlaceScope } from './scope-parts.ts';
import { dmOfAccount } from './meta-person.ts';
import { addSessionRows } from './session-rows.ts';
import { accountCollection, keyText } from './unit-keys.ts';
import { namedIface } from './live-iface.ts';
import type { UnitKey } from './unit-keys.ts';
import { writeMapping } from './upsert.ts';
import { heldRows, holdsAny, profileOwnerOf, retireProfileAbsent, stampProfileRows } from './profile-owner.ts';
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

/**
 * The person of a layer whose account names none: the stored account's meta-person, made when it has none, or a new
 * meta-person for an account no row holds; never one spelled from the account's native id.
 */
function personOfLayer(db: Db, key: UnitKey, at: string): string {
  const account = key.subject.type === 'account' ? key.subject.id : null;
  const stored = account !== null && db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(account) !== undefined;
  return (account !== null && stored ? ensureAccountPerson(db, account, at) : null) ?? mintMetaPerson(db, at);
}

/** The rows of a private layer `value` of the unit `key`, written at `at`. */
function privateLayerRows(db: Db, key: UnitKey, value: Row, at: string, writeIface?: string): Rows {
  const ctx = storageContext(db, key, writeIface);
  const iface = ifaceOf(ctx);
  const person = ctx.subjectPersonId ?? personOfLayer(db, key, at);
  const place = key.subject.type === 'account' ? dmOfAccount(db, key.subject.id) : (ctx.dmPlace ?? null);
  const rows: Rows = {};
  const { rest, affinity } = profileRows(rows, value, {
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
  });
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
 * retires what it no longer holds.
 */
export function writePrivateLayer(
  db: Db,
  key: UnitKey,
  value: Row,
  { at, iface }: { at: string; iface?: string }
): PrivateLayerResult {
  const mapping = privateLayerRows(db, key, value, at, iface);
  const upserted = writeMapping(db, mapping, { at });
  const retired = retireProfileAbsent(db, profileOwnerOf(key)!, mapping, at); // as above
  return { upserted, retired };
}

/** A write as the writer receives it, checked. */
export function privateLayerWriteOf(update: Row): PrivateLayerWrite {
  if (!filled(update.accountId)) throw coded('PRIVATE_LAYER_ACCOUNT');
  if (!isPlainObject(update.value)) throw coded('PRIVATE_LAYER_VALUE');
  return { accountId: update.accountId, value: update.value };
}

/**
 * The write of a unit update of a private layer (a value write of the account's own `private` unit), else null. Any
 * other key of the kind stays a unit write, which the writer stores through the same path.
 */
export function privateLayerOfUnit(update: Row): PrivateLayerWrite | null {
  const key = update.key as UnitKey | undefined;
  if (update.op !== 'value' || key?.kind !== 'private' || key.subject?.type !== 'account') return null;
  if (keyText(accountCollection('private', key.subject.id)) !== keyText(key)) return null;
  return privateLayerWriteOf({ accountId: key.subject.id, value: update.value ?? {} });
}

/** The write kind `private-layer` on the writer connection (session-write.ts). */
export function applyPrivateLayerWrite(handle: MemoryHandle, update: Row): PrivateLayerResult {
  const write = privateLayerWriteOf(update);
  const at = new Date(isFiniteNumber(update.now) ? update.now : Date.now()).toISOString();
  const key = accountCollection('private', write.accountId);
  return handle.transaction(() =>
    writePrivateLayer(dbOf(handle), key, write.value, { at, iface: namedIface(update) ?? undefined })
  );
}

/** Whether the database holds the private layer the unit `key` names. */
export function privateLayerHeld(db: Db, key: UnitKey): boolean {
  const holder = profileOwnerOf(key);
  return holder !== null && holdsAny(db, holder, 'operational');
}

/** The private layer the unit `key` holds, or not found when the database holds no such unit. */
export function privateLayerValue(db: Db, key: UnitKey): { found: true; value: unknown } | { found: false } {
  const holder = profileOwnerOf(key);
  if (!holder || !privateLayerHeld(db, key)) return { found: false };
  const rows = heldRows(db, holder, TABLES);
  addSessionRows(db, 'private', rows, key.subject.type === 'account' ? key.subject.id : null);
  return { found: true, value: privateLayerOf(rows) };
}
