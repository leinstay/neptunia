// The owner's binding of accounts to people. A person may hold any number of accounts on any interfaces, the owner and
// the persona included. Only the owner's `/memory bind` command writes here, through the memory writer, with `by` set
// to `owner`: no model proposal, name match or claimed id creates a link. `linkedDmScopes` tells a DM context the DMs of
// the same person, so a DM reads the person's history while each row keeps the scope of the conversation it came from.
// One `people` row carries the shared affinity score. Called by session-write.ts (the writes), service.ts (the context)
// and src/interface/commands/console.ts.

import { SELF_PERSON, dmPlaceOfPerson, personId } from './ids.ts';
import type { Db, MemoryHandle } from './types.ts';
import { dbOf } from './types.ts';

type Row = Record<string, unknown>;
type AccountRow = { id: string; iface: string; native: string; person_id: string | null };
export type LinkedDm = { iface: string; person: string; place: string | null };

function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function accountOf(db: Db, iface: unknown, native: unknown): AccountRow | undefined {
  return db
    .prepare(
      `SELECT id, iface, COALESCE(native_key, native_id) AS native, person_id FROM accounts
       WHERE iface = ? AND (native_key = ? OR native_id = ?) ORDER BY generation DESC LIMIT 1`
    )
    .get(iface, native, native) as AccountRow | undefined;
}

/** The person of an account, made from the account's own DM person when it has none yet. */
function personOf(db: Db, account: AccountRow, at: string): string {
  if (account.person_id) return account.person_id;
  const person = personId(account.iface, account.native);
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

function link(db: Db, accountId: string, person: string, at: string): void {
  closeLinks(db, accountId, at);
  db.prepare(
    `INSERT INTO account_person_links (id, account_id, person_id, state, by, reason, valid_from_at, recorded_at)
     VALUES (?, ?, ?, 'verified', 'owner', 'owner command', ?, ?)`
  ).run(`link:${accountId}:${person}:${at}`, accountId, person, at, at);
  db.prepare(
    "UPDATE accounts SET person_id = ?, link = 'verified', linked_by = 'owner', linked_at = ? WHERE id = ?"
  ).run(person, at, accountId);
}

/** The one write of a binding, on the writer connection. Throws `UNKNOWN_ACCOUNT` for an account she has not met. */
export function applyPersonLinkWrite(handle: MemoryHandle, update: Row): { ok: true; person: string | null } {
  const at = new Date(typeof update.now === 'number' ? update.now : Date.now()).toISOString();
  return handle.transaction(() => {
    const db = dbOf(handle);
    const account = accountOf(db, update.iface, update.native);
    if (account === undefined) throw coded('UNKNOWN_ACCOUNT');
    if (update.op === 'unbind') {
      closeLinks(db, account.id, at);
      const own = personId(account.iface, account.native);
      db.prepare('INSERT OR IGNORE INTO people (id, first_seen_at) VALUES (?, ?)').run(own, at);
      link(db, account.id, own, at);
      return { ok: true as const, person: own };
    }
    const target = update.target as { self?: boolean; iface?: unknown; native?: unknown };
    let person: string = SELF_PERSON;
    if (target.self !== true) {
      const other = accountOf(db, target.iface, target.native);
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
  const account = accountOf(db, iface, native);
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

/** The other DMs of the person behind a DM's `person:<iface>:<native>`; empty for an account nobody bound. */
export function linkedDmScopes(db: Db, iface: string, dmPerson: string): Array<LinkedDm> {
  const prefix = `person:${iface}:`;
  if (!dmPerson.startsWith(prefix)) return [];
  const { accounts } = accountLinks(db, iface, dmPerson.slice(prefix.length));
  return accounts
    .map((one) => ({ iface: one.iface, person: personId(one.iface, one.native) }))
    .filter((one) => one.person !== dmPerson)
    .map((one) => ({ ...one, place: dmPlaceOfPerson(one.person, one.iface) }));
}
