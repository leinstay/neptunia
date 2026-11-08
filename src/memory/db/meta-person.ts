// The read adapter of the meta-person (plan 2026-11-08-meta-person, slice 3). A meta-person is a `people` row with
// `meta` 1, and `person_accounts` holds its accounts, each under exactly one meta-person (schema version 40). Until the
// offline migration fills that table and the writers write it, most accounts still reach their person through the old
// copy in `accounts.person_id` with `link` `verified` (src/memory/db/person-links.ts). Both readers here answer from
// `person_accounts` first and from those old links after, so the readers of the engine move to the new rows one by one.
// A row of `person_accounts` wins over the old link of the same account. `profileOfAccount` assembles what she reads of a
// person seen on one account (plan slice 7): the meta-person's own fields, every account of the person with that
// account's own fields, and the seen account among them. Pure reads over the connection given.

import { survivorOf } from './ids.ts';
import { namesIn } from './names.ts';
import type { Db, Row } from './types.ts';

/** One account of a person: its node id, its interface and its id on that platform. */
export type PersonAccount = { id: string; iface: string; platformId: string };

/** An account with the fields that belong to it alone; the avatar is the stored JSON text. */
export type ProfileAccount = PersonAccount & {
  handle: string | null;
  displayName: string | null;
  avatar: string | null;
  profileText: string | null;
};

/** A person as seen on one account: the meta-person's fields, every account of the person, and the seen account. */
export type AssembledProfile = {
  personId: string;
  realName: string | null;
  affinity: number | null;
  accounts: Array<ProfileAccount>;
  seen: ProfileAccount | null;
};

/** The person of an account: its meta-person in `person_accounts`, else its verified old link, else null. */
export function personOfAccount(db: Db, accountId: string): string | null {
  const meta = db.prepare('SELECT person_id FROM person_accounts WHERE id = ?').get(accountId);
  if (typeof meta?.person_id === 'string') return meta.person_id;
  const old = db
    .prepare("SELECT person_id FROM accounts WHERE id = ? AND link = 'verified' AND person_id IS NOT NULL")
    .get(accountId);
  return typeof old?.person_id === 'string' && old.person_id !== '' ? old.person_id : null;
}

/**
 * The accounts of a person, ordered by interface and id: its rows in `person_accounts` and the live accounts whose
 * verified old link names it, each account once. An account that `person_accounts` puts under another person is left out.
 */
export function accountsOfPerson(db: Db, personId: string): Array<PersonAccount> {
  return profileAccountsOf(db, personId).map(({ id, iface, platformId }) => ({ id, iface, platformId }));
}

const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** The accounts of a person as `accountsOfPerson` lists them, each with its own fields; a missing display name is the account's newest name. */
export function profileAccountsOf(db: Db, personId: string): Array<ProfileAccount> {
  const rows = db
    .prepare(
      `SELECT m.id, m.iface, m.platform_id AS platformId, m.handle, m.display_name AS displayName, a.names,
         COALESCE(m.avatar, a.avatar) AS avatar, m.profile_text AS profileText
       FROM person_accounts m LEFT JOIN accounts a ON a.id = m.id WHERE m.person_id = ?
       UNION
       SELECT a.id, a.iface, COALESCE(a.native_key, a.native_id) AS platformId, NULL, NULL, a.names, a.avatar, NULL
       FROM accounts a
       WHERE a.person_id = ? AND a.link = 'verified' AND a.retired_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM person_accounts m WHERE m.id = a.id)
       ORDER BY iface, id`
    )
    .all(personId, personId);
  return rows.map((row: Row) => ({
    id: String(row.id),
    iface: String(row.iface),
    platformId: String(row.platformId),
    handle: textOrNull(row.handle),
    displayName: textOrNull(row.displayName) ?? namesIn(row.names)[0] ?? null,
    avatar: textOrNull(row.avatar),
    profileText: textOrNull(row.profileText),
  }));
}

/**
 * What she reads of the person behind `accountId`: the survivor of the account's person with its real name and
 * affinity, every account of that person with its own fields, and the seen account. Null for an account with no person.
 */
export function profileOfAccount(db: Db, accountId: string): AssembledProfile | null {
  const linked = personOfAccount(db, accountId);
  if (linked === null) return null;
  const personId = survivorOf(db, linked);
  const person = db.prepare('SELECT real_name, affinity FROM people WHERE id = ?').get(personId);
  const accounts = profileAccountsOf(db, personId);
  return {
    personId,
    realName: namesIn(person?.real_name)[0] ?? null,
    affinity: typeof person?.affinity === 'number' ? person.affinity : null,
    accounts,
    seen: accounts.find((account) => account.id === accountId) ?? null,
  };
}

/** The stored account of a platform id on an interface, its newest generation first; null when none is stored. */
function accountOfPlatformId(db: Db, iface: string, platformId: string): string | null {
  const row = db
    .prepare('SELECT id FROM accounts WHERE iface = ? AND native_id = ? ORDER BY generation DESC, id LIMIT 1')
    .get(iface, platformId);
  return typeof row?.id === 'string' ? row.id : null;
}

/** The person of the account a platform id names on an interface (`personOfAccount`), null when none is stored. */
export function personOfPlatformId(db: Db, iface: string, platformId: string): string | null {
  const account = accountOfPlatformId(db, iface, platformId);
  return account === null ? null : personOfAccount(db, account);
}

/** A stored direct chat: its place id and the partner person the place names, null for one nobody linked. */
export type StoredDm = { id: string; partnerPerson: string | null };

/** The live direct chat stored with `accountId` as its partner, the most recently seen of several; null when none is. */
export function dmOfAccount(db: Db, accountId: string): StoredDm | null {
  const place = db
    .prepare(
      `SELECT id, partner_person FROM places WHERE partner_account = ? AND (kind = 'dm' OR chat = 'dm')
       AND retired_at IS NULL ORDER BY COALESCE(seen_to_at, '') DESC, id LIMIT 1`
    )
    .get(accountId);
  if (typeof place?.id !== 'string') return null;
  return { id: place.id, partnerPerson: typeof place.partner_person === 'string' ? place.partner_person : null };
}

/** The live direct chat of the account a platform id names on an interface (`dmOfAccount`), null when none is stored. */
export function dmOfPlatformId(db: Db, iface: string, platformId: string): StoredDm | null {
  const account = accountOfPlatformId(db, iface, platformId);
  return account === null ? null : dmOfAccount(db, account);
}
