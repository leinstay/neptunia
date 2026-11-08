// The writes that keep the meta-person's rows current (plan 2026-11-08-meta-person, slice 5). An account's row in
// `person_accounts` and the `author_person` of its lines follow the account's verified link, the one source of truth
// (person-links.ts#linkAccount). A person whose id spells no interface (her own `person:self`, a `person:<uuid>`) is a
// meta-person, marked where it stands as the offline migration marks it (meta-person-migrate.ts). An account linked to
// a person of the old shape, `person:<iface>:<native>`, which no migration has moved yet, has no row in
// `person_accounts`: the adapter reaches that person through the old link (meta-person.ts). Called by person-links.ts
// (a link), observe.ts and rows.ts (an account or a line written) and upsert.ts (a unit's accounts).

import { legacyPersonNative, newPersonId, survivorOf } from './ids.ts';
import { personOfAccount } from './meta-person.ts';
import type { Db } from './types.ts';

/**
 * A new meta-person with no kind, which the profile unit of its account adopts on its first write (upsert.ts), and no
 * profile owner yet. Returns its id.
 */
export function mintMetaPerson(db: Db, at: string, newId?: () => string): string {
  const person = newPersonId(newId);
  if (hasMetaSchema(db))
    db.prepare("INSERT INTO people (id, meta, status, first_seen_at) VALUES (?, 1, 'active', ?)").run(person, at);
  else db.prepare('INSERT INTO people (id, first_seen_at) VALUES (?, ?)').run(person, at);
  return person;
}

/** Whether the database holds the meta-person's structures (schema version 40); an older one is left as it is. */
export const hasMetaSchema = (db: Db): boolean =>
  db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'person_accounts'").get() !== undefined;

/** Whether `person` is a meta-person, marking one whose id spells no interface and that nobody merged away. */
function metaPerson(db: Db, person: string): boolean {
  const row = db.prepare('SELECT meta, status FROM people WHERE id = ?').get(person);
  if (row === undefined) return false;
  if (row.meta === 1) return true;
  const merged = typeof row.status === 'string' && row.status.startsWith('merged_into:');
  if (legacyPersonNative(person) !== null || merged) return false;
  db.prepare('UPDATE people SET meta = 1 WHERE id = ?').run(person);
  return true;
}

/** The first display name of an account's `names`, or null. */
function displayNameOf(names: unknown): string | null {
  if (typeof names !== 'string') return null;
  try {
    const list: unknown = JSON.parse(names);
    return Array.isArray(list) && typeof list[0] === 'string' && list[0] !== '' ? list[0] : null;
  } catch {
    return null;
  }
}

/**
 * The account's row in `person_accounts` from its stored account: under the meta-person its verified link ends in, with
 * its interface, platform id, generation, display name and avatar. An account whose person is not a meta-person loses
 * its row, so the adapter answers from the old link. A display name or avatar the account no longer holds stays.
 */
export function syncPersonAccount(db: Db, accountId: string, at: string): void {
  if (!hasMetaSchema(db)) return;
  const account = db
    .prepare(
      `SELECT id, iface, COALESCE(native_key, native_id, id) AS platform, COALESCE(generation, 1) AS generation, names,
         avatar, person_id, link FROM accounts WHERE id = ?`
    )
    .get(accountId);
  if (account === undefined) return;
  const linked = account.link === 'verified' && typeof account.person_id === 'string' && account.person_id !== '';
  const person = linked ? survivorOf(db, account.person_id) : null;
  if (person === null || !metaPerson(db, person)) {
    db.prepare('DELETE FROM person_accounts WHERE id = ?').run(accountId);
    return;
  }
  db.prepare(
    `INSERT OR IGNORE INTO person_accounts (id, person_id, iface, platform_id, generation, display_name, avatar, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET person_id = excluded.person_id,
       display_name = COALESCE(excluded.display_name, display_name), avatar = COALESCE(excluded.avatar, avatar)`
  ).run(
    accountId,
    person,
    String(account.iface),
    String(account.platform),
    Number(account.generation),
    displayNameOf(account.names),
    typeof account.avatar === 'string' ? account.avatar : null,
    at
  );
}

/** The person a line of `accountId` names as its author: the survivor of the account's person, or null for none. */
export function authorPersonOf(db: Db, accountId: unknown): string | null {
  if (typeof accountId !== 'string' || accountId === '' || !hasMetaSchema(db)) return null;
  const person = personOfAccount(db, accountId);
  if (person === null) return null;
  const survivor = survivorOf(db, person);
  return db.prepare('SELECT 1 AS ok FROM people WHERE id = ?').get(survivor) ? survivor : null;
}

/** After a link of `accountId` changed: its account row and the author person of every line it wrote follow. */
export function followAccount(db: Db, accountId: string, at: string): void {
  if (!hasMetaSchema(db)) return;
  syncPersonAccount(db, accountId, at);
  const person = authorPersonOf(db, accountId);
  db.prepare('UPDATE sources SET author_person = ?1 WHERE author_account = ?2 AND author_person IS NOT ?1').run(
    person,
    accountId
  );
}
