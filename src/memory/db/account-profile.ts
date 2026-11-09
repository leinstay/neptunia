// An account's profile: what the store keeps about a member (src/memory/store.ts, `getUser`, `touchUser`,
// `updateUser`), owned by the unit `accountCollection('user', <account id>)`. The store writes it through the write
// kind `account-profile` (session-write.ts) and reads it back through `accountProfileValue` below.
//
//   people          the member (first/last seen, message count, real name, the affinity score, reason, decay stamp;
//                   `affinity.moveId`, her session's last move the profile was read with, stays in `extra`)
//   accounts        the platform account (id, display names, avatar)
//   memberships     the membership, only when the profile has `addressedAs`
//   claims          details, interests, aliases (current) and closed items (truth historical)
//   descriptions    character, style, relationship with their text as one legacy version
//   episodes        the profile's episodes (kind profile)
//   affinity_events the affinity history
//
// Every other field (counters, portrait stamps, detailsSeq, `updatedAt`, ...) is in `people.extra`.
//
// An account linked to a person whose profile another unit holds (person-links.ts#linkedProfileUnit) writes only
// `accounts` and `memberships`: its names, avatar and address. Its `people` row, when it has one from before the link,
// stays dormant under its own id until an unlink. A linked account's row keeps the link the database holds. A stored
// account with no person gets its meta-person before its first profile is written (plan 2026-11-08-meta-person).
//
// A write replaces the profile: the rows the value no longer holds are retired (upsert.ts#retireAbsent), and what her
// session wrote last stays as she wrote it (session-rows.ts#sessionHold). A read adds what her session wrote about the
// person in the profile's scope (session-rows.ts#addSessionRows).

import { personId } from './ids.ts';
import { groupScope } from './scope.ts';
import { AFFINITY_SPEC, affinityFrom, profileFrom, profileRows } from './map/lists.ts';
import { extraText, ifaceOf, isPlainObject, join, parseExtra, put, rowsOf, split } from './map/common.ts';
import type { MapContext, Spec } from './map/common.ts';
import { storageContext } from './map/index.ts';
import { ensureAccountPerson, linkedProfileUnit } from './person-links.ts';
import { addSessionRows } from './session-rows.ts';
import { accountCollection, keyText } from './storage-keys.ts';
import type { StorageKey } from './storage-keys.ts';
import { ensureUnit } from './storage-units.ts';
import { writeMapping } from './upsert.ts';
import { heldRows, holdsAny, profileOwnerOf, retireProfileAbsent, stampProfileRows } from './profile-owner.ts';
import type { ProfileOwner } from './profile-owner.ts';
import { noteUnit } from './unit-write.ts';
import { dbOf, isFiniteNumber } from './types.ts';
import type { Db, MemoryHandle, Row, Rows } from './types.ts';

/** One write of the kind: the whole profile of one account. */
export type AccountProfileWrite = { accountId: string; value: Row };

/** What a write answers: the rows it wrote and the rows it retired. */
export type AccountProfileResult = { upserted: number; retired: number };

/** The tables a profile's rows live in. */
const TABLES = [
  'people',
  'accounts',
  'memberships',
  'claims',
  'descriptions',
  'description_versions',
  'episodes',
  'affinity_events',
];

const PEOPLE_SPEC: Array<Spec> = [
  { col: 'first_seen_at', key: 'firstSeen', type: 'text' },
  { col: 'last_seen_at', key: 'lastSeen', type: 'text' },
  { col: 'message_count', key: 'messageCount', type: 'num' },
  { col: 'real_name', key: 'realName', type: 'json' },
];
const ACCOUNT_SPEC: Array<Spec> = [
  { col: 'native_id', key: 'id', type: 'text' },
  { col: 'names', key: 'names', type: 'json' },
  { col: 'avatar', key: 'avatar', type: 'json' },
];
const MEMBERSHIP_SPEC: Array<Spec> = [{ col: 'addressed_as', key: 'addressedAs', type: 'json' }];

const FIELDS = ['character', 'style', 'relationship'];

const coded = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** What a profile's rows are written under: the account and its person, read from the database. */
type ProfileContext = {
  iface: string;
  accountId: string;
  person: string;
  accountOnly: boolean;
  link: Row;
  membership: { id: string; placeId: string | null } | null;
};

/** The one membership row a profile writes: its id and place, as stored. */
function membershipOf(db: Db, accountId: string): ProfileContext['membership'] {
  const row = db
    .prepare('SELECT id, place_id FROM memberships WHERE account_id = ? ORDER BY id LIMIT 1')
    .get(accountId);
  return typeof row?.id === 'string'
    ? { id: row.id, placeId: typeof row.place_id === 'string' ? row.place_id : null }
    : null;
}

/**
 * What the profile unit `id` of `accountId` writes under: the person whose `people` row it owns (a linked account's
 * dormant row keeps its own id), or only the account's own facts when another unit holds the person's profile. A stored
 * account with no person gets a meta-person first, never one spelled from its native id. The account row keeps the
 * link the database holds.
 */
function profileContext(db: Db, id: string, key: StorageKey, holder: ProfileOwner): ProfileContext {
  const accountId = key.subject.id;
  const base: MapContext = storageContext(db, key);
  const iface = ifaceOf(base);
  const [owned] = heldRows(db, holder, ['people']).people ?? [];
  const stored = db.prepare('SELECT person_id FROM accounts WHERE id = ?').get(accountId);
  const minted =
    typeof owned?.id !== 'string' && stored !== undefined && !filled(stored.person_id)
      ? ensureAccountPerson(db, accountId, new Date().toISOString())
      : null;
  const account = db.prepare('SELECT person_id, link, linked_by, linked_at FROM accounts WHERE id = ?').get(accountId);
  const link = filled(account?.person_id)
    ? { person_id: account.person_id, link: account.link, linked_by: account.linked_by, linked_at: account.linked_at }
    : null;
  const accountOnly = typeof owned?.id !== 'string' && linkedProfileUnit(db, accountId) !== null;
  const person =
    (typeof owned?.id === 'string' ? owned.id : accountOnly ? null : minted) ??
    base.subjectPersonId ??
    personId(iface, base.subjectNativeId ?? id);
  return {
    iface,
    accountId,
    person,
    accountOnly,
    link: link ?? { person_id: person, link: 'verified', linked_by: null, linked_at: null },
    membership: membershipOf(db, accountId),
  };
}

/** The rows of what belongs to the account itself; returns the fields of `value` that are not. */
function putAccount(rows: Rows, value: Row, ctx: ProfileContext, owner: string): Row {
  const account = split(value, ACCOUNT_SPEC);
  const left = account.rest;
  const account_id = ctx.accountId;
  put(rows, 'accounts', {
    id: account_id,
    iface: ctx.iface,
    ...account.cols,
    ...ctx.link,
    extra: null,
    owner_key: owner,
  });
  if (Object.hasOwn(left, 'addressedAs')) {
    const membership = split({ addressedAs: left.addressedAs }, MEMBERSHIP_SPEC);
    delete left.addressedAs;
    put(rows, 'memberships', {
      id: ctx.membership?.id ?? `mem:${account_id}`,
      account_id,
      place_id: ctx.membership?.placeId ?? null,
      nick: null,
      roles: null,
      pings_off: null,
      ...membership.cols,
      extra: extraText(membership.rest),
      valid_from_at: null,
      valid_to_at: null,
      owner_key: owner,
    });
  }
  return left;
}

/** The rows of a profile `value` in the unit `owner`. */
export function accountProfileRows(value: Row, ctx: ProfileContext, owner: string): Rows {
  const rows: Rows = {};
  if (ctx.accountOnly) {
    putAccount(rows, value, ctx, owner);
    return rows;
  }
  const { rest, affinity } = profileRows(rows, value, {
    rel: owner,
    person: ctx.person,
    owner: ctx.person,
    tag: '',
    scope: groupScope(ctx.iface),
    descFields: FIELDS,
  });
  const people = split(rest, PEOPLE_SPEC);
  const left = people.rest;
  let affinityCols: Row = { affinity: null, affinity_reason: null, affinity_decayed_at: null };
  if (affinity) {
    const part = split(affinity, AFFINITY_SPEC);
    affinityCols = part.cols;
    if (Object.keys(part.rest).length) left.affinity = part.rest;
  }
  const accountLeft = putAccount(rows, left, ctx, owner);
  put(rows, 'people', {
    id: ctx.person,
    kind: 'member',
    ...people.cols,
    ...affinityCols,
    extra: extraText(accountLeft),
    retired_at: null,
    owner_key: owner,
  });
  // The shared profile pieces name their unit as `owner_file` (map/lists.ts): the unit's id is their owner.
  for (const list of Object.values(rows))
    for (const row of list) {
      if (row.owner_file === undefined) continue;
      delete row.owner_file;
      row.owner_key = owner;
    }
  return rows;
}

/** `obj` with what belongs to the account itself. A unit that holds a person but lost its account row reads without. */
function accountFrom(rows: Rows, obj: Row): Row {
  const accountRow = rowsOf(rows, 'accounts')[0];
  if (accountRow) Object.assign(obj, join(accountRow, accountRow.extra, ACCOUNT_SPEC));
  const membership = rowsOf(rows, 'memberships')[0];
  if (membership) Object.assign(obj, join(membership, membership.extra, MEMBERSHIP_SPEC));
  return obj;
}

/** The profile its rows give back. */
export function accountProfileOf(rows: Rows): Row {
  const personRow = rowsOf(rows, 'people')[0];
  if (personRow === undefined) return accountFrom(rows, {});
  const rest = parseExtra(personRow.extra);
  const has = Array.isArray(rest.$has) ? rest.$has : [];
  delete rest.$has;
  const affinityLeft = has.includes('affinity') && isPlainObject(rest.affinity) ? rest.affinity : {};
  if (has.includes('affinity')) delete rest.affinity;
  const obj = join(personRow, rest, PEOPLE_SPEC);
  accountFrom(rows, obj);
  Object.assign(obj, profileFrom(rows, has));
  if (has.includes('affinity')) obj.affinity = affinityFrom(rows, personRow, affinityLeft, has);
  return obj;
}

/**
 * Stores the whole profile the unit `key` holds (an account's `user` unit) inside the caller's transaction and retires
 * what it no longer holds. `legacyOwner` is an owner path of an older release.
 */
export function writeAccountProfile(
  db: Db,
  key: StorageKey,
  value: Row,
  { at, legacyOwner }: { at: string; legacyOwner?: string }
): AccountProfileResult {
  const id = ensureUnit(db, key);
  if (legacyOwner) {
    db.prepare('INSERT OR IGNORE INTO legacy_unit_aliases(path,unit_id) VALUES (?,?)').run(legacyOwner, id);
    db.prepare('INSERT OR IGNORE INTO files(path,kind) VALUES (?,?)').run(legacyOwner, 'user');
  }
  const holder = profileOwnerOf(key)!; // an account's `user` unit always has its owner columns (profile-owner.ts)
  const mapping = stampProfileRows(accountProfileRows(value, profileContext(db, id, key, holder), id), holder);
  if (legacyOwner) for (const list of Object.values(mapping)) for (const row of list) row.owner_file = legacyOwner;
  const upserted = writeMapping(db, mapping, id, { at });
  const retired = retireProfileAbsent(db, holder, mapping, at);
  noteUnit(db, id, 'user', { at });
  return { upserted, retired };
}

/** A write as the writer receives it, checked. */
export function accountProfileWriteOf(update: Row): AccountProfileWrite {
  if (!filled(update.accountId)) throw coded('ACCOUNT_PROFILE_ACCOUNT');
  if (!isPlainObject(update.value)) throw coded('ACCOUNT_PROFILE_VALUE');
  return { accountId: update.accountId, value: update.value };
}

/** Whether `key` names an account's profile. */
export const isAccountProfileKey = (key: StorageKey | undefined): boolean =>
  key?.kind === 'user' && key.subject?.type === 'account';

/**
 * The write of a unit update of an account's profile (a value write of the account's own `user` unit), else null. A
 * key with a root or a partition of an older layout stays a unit write, which the writer stores through the same path.
 */
export function accountProfileOfUnit(update: Row): AccountProfileWrite | null {
  const key = update.key as StorageKey | undefined;
  if (update.op !== 'value' || !key || !isAccountProfileKey(key)) return null;
  if (keyText(accountCollection('user', key.subject.id)) !== keyText(key)) return null;
  return accountProfileWriteOf({ accountId: key.subject.id, value: update.value ?? {} });
}

/** The write kind `account-profile` on the writer connection (session-write.ts). */
export function applyAccountProfileWrite(handle: MemoryHandle, update: Row): AccountProfileResult {
  const write = accountProfileWriteOf(update);
  const at = new Date(isFiniteNumber(update.now) ? update.now : Date.now()).toISOString();
  const key = accountCollection('user', write.accountId);
  return handle.transaction(() => writeAccountProfile(dbOf(handle), key, write.value, { at }));
}

/** The profile the unit `key` holds (an account's `user` unit), or not found when the database holds no such unit. */
export function accountProfileValue(db: Db, key: StorageKey): { found: true; value: unknown } | { found: false } {
  const holder = profileOwnerOf(key);
  if (!holder || (!holdsAny(db, holder, 'accounts') && !holdsAny(db, holder, 'people'))) return { found: false };
  const rows = heldRows(db, holder, TABLES);
  addSessionRows(db, 'user', rows, key.subject.type === 'account' ? key.subject.id : null);
  return { found: true, value: accountProfileOf(rows) };
}
