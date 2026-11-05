// The owner's binding of accounts to people. A person may hold any number of accounts on any interfaces, the owner and
// the persona included. Only the owner's `/memory bind` command writes here, through the memory writer, with `by` set
// to `owner`: no model proposal, name match or claimed id creates a link. `personMembers` follows merges and verified
// links to the accounts of one person. `linkedDmScopes` tells a DM context the stored DM places of those accounts, so a
// DM reads the person's history while each row keeps the scope of the conversation it came from. A merge written by the
// owner widens a DM context and a merge written by anyone else never does. One `people` row carries the shared affinity
// score. `createOwnerAccounts` answers the owner check over the same links (src/tools/impl/grants.ts#isOwnerId): the live
// row of `account_person_links` is the one source of truth, and the account's `link` and `linked_by` columns are its copy
// for the readers that join accounts. Called by session-write.ts (the writes), service.ts (the context), private-read.ts
// (the private view), identity-links.ts and person-merge.ts (the links they write), core.ts and
// src/interface/commands/console.ts.

import { currentIface } from './current-iface.ts';
import { SELF_PERSON, newPersonId, survivorOf } from './ids.ts';
import type { AccountAddress } from '../../protocol/identity.ts';
import type { StorageKey } from './storage-keys.ts';
import type { Db, MemoryHandle } from './types.ts';
import { dbOf } from './types.ts';

type Row = Record<string, unknown>;
type AccountRow = {
  id: string;
  iface: string;
  native: string;
  person_id: string | null;
  link: string | null;
};
export type LinkedDm = { iface: string; person: string; place: string | null };
/** One person as the stored rows hold them: the final survivor, the people merged into it and their accounts. */
export type PersonMembers = { survivor: string; mergedFrom: Array<string>; accounts: Array<Row> };

function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function accountById(db: Db, id: unknown): AccountRow | undefined {
  return db
    .prepare('SELECT id, iface, COALESCE(native_key, native_id) AS native, person_id, link FROM accounts WHERE id = ?')
    .get(id) as AccountRow | undefined;
}

/** The newest generation of a native id on an interface: what an owner's words name. */
function accountByNative(db: Db, iface: unknown, native: unknown): AccountRow | undefined {
  return db
    .prepare(
      `SELECT id, iface, COALESCE(native_key, native_id) AS native, person_id, link FROM accounts
       WHERE iface = ? AND (native_key = ? OR native_id = ?) ORDER BY generation DESC LIMIT 1`
    )
    .get(iface, native, native) as AccountRow | undefined;
}

/** The account node of exactly this interface, authority, native id and generation, or null. */
export function accountNodeOf(db: Db, address: AccountAddress): string | null {
  const row = db
    .prepare(
      `SELECT id FROM accounts WHERE iface = ? AND authority_id = ? AND generation = ?
       AND (native_key = ? OR native_id = ?) LIMIT 1`
    )
    .get(address.interfaceId, address.authorityId, address.generation, address.nativeId, address.nativeId);
  return typeof row?.id === 'string' ? row.id : null;
}

/** The person of an account, made from the account's own DM person when it has none yet. */
function personOf(db: Db, account: AccountRow, at: string): string {
  if (account.person_id) return account.person_id;
  const person = newPersonId();
  db.prepare('INSERT OR IGNORE INTO people (id, first_seen_at) VALUES (?, ?)').run(person, at);
  link(db, account.id, person, at);
  return person;
}

function closeLinks(db: Db, accountId: string, at: string): void {
  db.prepare('UPDATE account_person_links SET valid_to_at = ? WHERE account_id = ? AND valid_to_at IS NULL').run(
    at,
    accountId
  );
}

/** Who wrote a link and why: the owner's command unless a caller names another writer. */
export type LinkAuthor = { by: string; reason: string; state?: 'verified' | 'proposed' };

const OWNER_COMMAND: LinkAuthor = { by: 'owner', reason: 'owner command' };

/**
 * Links `accountId` to `person`: its live links closed, one new row in `account_person_links`, and the account's columns
 * copied from it (a proposal leaves `person_id` empty, as `people:add` does).
 */
export function linkAccount(db: Db, accountId: string, person: string, at: string, author: LinkAuthor): void {
  const state = author.state ?? 'verified';
  closeLinks(db, accountId, at);
  db.prepare(
    `INSERT INTO account_person_links (id, account_id, person_id, state, by, reason, valid_from_at, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(`link:${accountId}:${person}:${at}`, accountId, person, state, author.by, author.reason, at, at);
  if (state === 'verified')
    db.prepare("UPDATE accounts SET person_id = ?, link = 'verified', linked_by = ?, linked_at = ? WHERE id = ?").run(
      person,
      author.by,
      at,
      accountId
    );
}

function link(db: Db, accountId: string, person: string, at: string): void {
  linkAccount(db, accountId, person, at, OWNER_COMMAND);
}

/**
 * The one write of a binding, on the writer connection: `{ op, accountId, target }`, the target `{ accountId }`,
 * `{ personId }`, `{ self: true }` or `{ owner: true }`. Throws `UNKNOWN_ACCOUNT` or `UNKNOWN_PERSON` for a name nobody
 * stored. An unbind leaves the account with a person of its own.
 */
export function applyPersonLinkWrite(handle: MemoryHandle, update: Row): { ok: true; person: string | null } {
  const at = new Date(typeof update.now === 'number' ? update.now : Date.now()).toISOString();
  return handle.transaction(() => {
    const db = dbOf(handle);
    const account = accountById(db, update.accountId);
    if (account === undefined) throw coded('UNKNOWN_ACCOUNT');
    if (update.op === 'unbind') {
      closeLinks(db, account.id, at);
      const own = newPersonId();
      db.prepare('INSERT OR IGNORE INTO people (id, first_seen_at) VALUES (?, ?)').run(own, at);
      link(db, account.id, own, at);
      return { ok: true as const, person: own };
    }
    const target = update.target as { self?: boolean; owner?: boolean; accountId?: unknown; personId?: unknown };
    if (target.owner === true) {
      // The owner names his own account: it keeps its person and its memory, and the link becomes his own word.
      const own = personOf(db, account, at);
      if (account.person_id) link(db, account.id, own, at);
      return { ok: true as const, person: own };
    }
    let person: string = SELF_PERSON;
    if (typeof target.personId === 'string') {
      const known = db.prepare('SELECT 1 AS ok FROM people WHERE id = ?').get(target.personId);
      if (!known) throw coded('UNKNOWN_PERSON');
      person = target.personId;
    } else if (target.self !== true) {
      const other = accountById(db, target.accountId);
      if (other === undefined) throw coded('UNKNOWN_ACCOUNT');
      person = personOf(db, other, at);
    }
    link(db, account.id, person, at);
    return { ok: true as const, person };
  });
}

/** Every account that shares the person of `iface`/`native`, itself included, in a stable order. */
export function accountLinks(
  db: Db,
  iface: string,
  native: string
): { person: string | null; accounts: Array<{ iface: string; native: string }> } {
  const account = accountByNative(db, iface, native);
  if (account === undefined || !account.person_id) return { person: null, accounts: [{ iface, native }] };
  const rows = db
    .prepare(
      `SELECT iface, COALESCE(native_key, native_id) AS native FROM accounts
       WHERE person_id = ? AND link = 'verified' ORDER BY iface, native`
    )
    .all(account.person_id) as Array<{ iface: string; native: string }>;
  const accounts = rows.map((row) => ({ iface: row.iface, native: row.native }));
  return { person: account.person_id, accounts: accounts.length > 0 ? accounts : [{ iface, native }] };
}

/**
 * The profile unit of the person an account is linked to, when another account's unit holds it: the unit that owns the
 * person's `people` row. Null for an account with no person, a person whose row no unit owns, and a row its own account
 * owns in another community. What a linked account writes through its own unit stays account-specific (map/user.ts).
 */
export function linkedProfileUnit(db: Db, accountId: string): { id: string; key: StorageKey } | null {
  const person = db.prepare('SELECT person_id FROM accounts WHERE id = ?').get(accountId)?.person_id;
  if (typeof person !== 'string' || !person) return null;
  const unit = db
    .prepare(
      `SELECT u.id, u.key_json FROM people p JOIN storage_units u ON u.id = p.owner_key
       WHERE p.id = ? AND p.retired_at IS NULL AND u.kind = 'user' AND u.retired_at IS NULL AND u.subject_id != ?`
    )
    .get(survivorOf(db, person), accountId);
  return unit ? { id: String(unit.id), key: JSON.parse(String(unit.key_json)) as StorageKey } : null;
}

/** The account a legacy person id spells: `person:<account id>`, which S10's conversion retires. Opaque ids name none. */
function spelledAccount(db: Db, person: string): Row | undefined {
  return db.prepare('SELECT * FROM accounts WHERE id = substr(?, 8)').get(person);
}

const placeholders = (values: ReadonlyArray<unknown>): string => values.map(() => '?').join(', ');

/**
 * Who `person` stands for: the survivor of its merges, every person merged into that survivor and their verified
 * accounts, joined through stored rows. `ownerMergesOnly` is for an outward context: a merge by anyone but the owner
 * neither moves the person nor adds to it. An account that has no person yet belongs to the legacy id that spells it.
 */
export function personMembers(
  db: Db,
  person: string,
  { ownerMergesOnly }: { ownerMergesOnly: boolean }
): PersonMembers {
  const own = spelledAccount(db, person);
  const whose = ownerMergesOnly ? " AND by = 'owner'" : '';
  const forward = db.prepare(`SELECT into_person AS next FROM people_merges WHERE from_person = ?${whose}`);
  const backward = db.prepare(
    `SELECT from_person AS next FROM people_merges WHERE into_person = ?${whose} ORDER BY from_person`
  );
  let survivor = own?.link === 'verified' && typeof own.person_id === 'string' ? own.person_id : person;
  const walked = new Set([survivor]);
  for (let row = forward.get(survivor); row && !walked.has(String(row.next)); row = forward.get(survivor)) {
    survivor = String(row.next);
    walked.add(survivor);
  }
  const members = new Set([survivor]);
  for (const member of members) for (const row of backward.all(member)) members.add(String(row.next));
  const ids = [...members];
  const accounts = db
    .prepare(
      `SELECT * FROM accounts WHERE person_id IN (${placeholders(ids)}) AND link = 'verified' AND retired_at IS NULL
       ORDER BY iface, id`
    )
    .all(...ids);
  const unbound = own !== undefined && (own.person_id === null || own.person_id === '');
  return { survivor, mergedFrom: ids.slice(1), accounts: unbound ? [...accounts, own] : accounts };
}

/** The live DM places whose stored partner is one of `accountIds`, whoever the place's partner person says it was. */
export function dmPlacesOfAccounts(db: Db, accountIds: ReadonlyArray<unknown>): Array<Row> {
  if (accountIds.length === 0) return [];
  return db
    .prepare(
      `SELECT * FROM places WHERE partner_account IN (${placeholders(accountIds)})
       AND (kind = 'dm' OR conversation = 'dm') AND retired_at IS NULL ORDER BY iface, id`
    )
    .all(...accountIds);
}

/**
 * The person a linked place's scope columns name: its stored partner, unless that partner is now somebody else's. After
 * an account moves to another person, the old partner on its place would otherwise open the old person's scope columns.
 */
function scopePersonOf(db: Db, place: Row, account: Row, members: PersonMembers): string {
  const partner = place.partner_person;
  const current = String(account.person_id);
  if (typeof partner !== 'string' || partner === '') return current;
  if (partner === members.survivor || members.mergedFrom.includes(partner)) return partner;
  const held = db
    .prepare("SELECT 1 AS ok FROM accounts WHERE person_id = ? AND link = 'verified' AND id != ? LIMIT 1")
    .get(partner, account.id);
  return held ? current : partner;
}

/**
 * The DM places of the person behind a DM's person id, read from the stored accounts and places, without the DM of the
 * account that id spells. service.ts leaves out the issued context's own place, which an opaque id does not spell. Empty
 * for a person with no verified account and no observed DM.
 */
export function linkedDmScopes(db: Db, iface: string, dmPerson: string): Array<LinkedDm> {
  const members = personMembers(db, dmPerson, { ownerMergesOnly: true });
  const byId = new Map(members.accounts.map((account) => [account.id, account]));
  const linked: Array<LinkedDm> = [];
  for (const place of dmPlacesOfAccounts(db, [...byId.keys()])) {
    const account = byId.get(place.partner_account);
    if (account === undefined || (account.iface === iface && `person:${String(account.id)}` === dmPerson)) continue;
    linked.push({
      iface: String(place.iface),
      person: scopePersonOf(db, place, account, members),
      place: String(place.id),
    });
  }
  return linked;
}

/** The person of an account's live verified link the owner wrote, or null. */
export function ownerLinkedPerson(db: Db, accountId: string): string | null {
  const row = db
    .prepare(
      `SELECT person_id FROM account_person_links WHERE account_id = ? AND state = 'verified' AND by = 'owner'
       AND valid_to_at IS NULL ORDER BY recorded_at DESC, id DESC LIMIT 1`
    )
    .get(accountId);
  return typeof row?.person_id === 'string' ? row.person_id : null;
}

/**
 * The owner check's reader over a read connection. Only a live link the owner wrote counts: a memory session proposes
 * links and an import carries them, and neither hands out his rights. The account's columns are never read, and a
 * person merged away stands for the person it was merged into. The interface is the current event's or turn's, the
 * home interface on a wake. Closed memory passes nobody.
 */
export function createOwnerAccounts({ database, home }: { database: () => Db | null; home: () => string }): {
  isBoundTo(person: string, native: string): boolean;
  onHomeInterface(): boolean;
} {
  return {
    isBoundTo(person, native) {
      const db = database();
      if (db === null) return false;
      const account = accountByNative(db, currentIface() ?? home(), native);
      const linked = account === undefined ? null : ownerLinkedPerson(db, account.id);
      return linked !== null && survivorOf(db, linked) === survivorOf(db, person);
    },
    onHomeInterface() {
      const iface = currentIface();
      return iface === null || iface === home();
    },
  };
}
