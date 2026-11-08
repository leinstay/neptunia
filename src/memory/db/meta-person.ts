// The read adapter of the meta-person (plan 2026-11-08-meta-person, slice 3). A meta-person is a `people` row with
// `meta` 1, and `person_accounts` holds its accounts, each under exactly one meta-person (schema version 40). Until the
// offline migration fills that table and the writers write it, most accounts still reach their person through the old
// copy in `accounts.person_id` with `link` `verified` (src/memory/db/person-links.ts). Both readers here answer from
// `person_accounts` first and from those old links after, so the readers of the engine move to the new rows one by one.
// A row of `person_accounts` wins over the old link of the same account. Pure reads over the connection given.

import type { Db } from './types.ts';

/** One account of a person: its node id, its interface and its id on that platform. */
export type PersonAccount = { id: string; iface: string; platformId: string };

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
  const rows = db
    .prepare(
      `SELECT id, iface, platform_id AS platformId FROM person_accounts WHERE person_id = ?
       UNION
       SELECT a.id, a.iface, COALESCE(a.native_key, a.native_id) AS platformId FROM accounts a
       WHERE a.person_id = ? AND a.link = 'verified' AND a.retired_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM person_accounts m WHERE m.id = a.id)
       ORDER BY iface, id`
    )
    .all(personId, personId);
  return rows.map((row) => ({ id: String(row.id), iface: String(row.iface), platformId: String(row.platformId) }));
}
