// The two identities the engine knows without asking anyone: her own accounts and the owner's command line. The
// observation (observe.ts) links an account whose author is she to `person:self` on any interface, by the author being
// she and never by a name. The command line (`iface: 'cli'`) is spoken only by the `cli` principal, the owner, so its
// account is linked to the owner's person (`bot.ownerPerson`, handed in by the core with the line) from its first line;
// a tentative person she proposed for it merges into his, unless that person also holds a verified account of someone
// else. On a raw install the core mints the owner's person with the first line, and the accounts listed in `bot.owners`
// are linked to it in the same transaction, so nobody loses owner rights when the setting appears. An install that
// stored the command line under `cli/global` has those rows moved to its native authority (`cli/local`,
// src/protocol/identity.ts#nativeAuthorityOf) when the next line arrives, so the line finds its account and its place.
// Used by observe.ts and scripts/memory-repair-identity.ts. Counts and codes only.

import { nativeAuthorityOf } from '../../protocol/identity.ts';
import { projectRow } from './graph.ts';
import { rescopeDmPlacesOfAccount } from './dm-rescope.ts';
import { SELF_PERSON, survivorOf } from './ids.ts';
import { mergePersonInto } from './person-merge.ts';
import { linkAccount, ownerLinkedPerson } from './person-links.ts';
import type { Db } from './types.ts';

/** The interface of the owner's command line. */
export const OWNER_CONSOLE_IFACE = 'cli';

/** What a link to her or to the owner did: whether the account's link changed, and the people merged on the way. */
export type IdentityLinked = { linked: boolean; merged: Array<string> };

/** The person of an account's live verified link, whoever wrote it, or null. */
function verifiedPerson(db: Db, accountId: string): string | null {
  const row = db
    .prepare(
      `SELECT person_id FROM account_person_links WHERE account_id = ? AND state = 'verified' AND valid_to_at IS NULL
       ORDER BY recorded_at DESC, id DESC LIMIT 1`
    )
    .get(accountId);
  return typeof row?.person_id === 'string' ? row.person_id : null;
}

/** Links one of her own accounts to her person, made when a raw install has none yet. A link in place stays. */
export function linkSelfAccount(db: Db, accountId: string, at: string): boolean {
  db.prepare("INSERT OR IGNORE INTO people (id, kind, status, first_seen_at) VALUES (?, 'self', 'active', ?)").run(
    SELF_PERSON,
    at
  );
  if (verifiedPerson(db, accountId) === SELF_PERSON) return false;
  linkAccount(db, accountId, SELF_PERSON, at, { by: 'observation', reason: 'her own account' });
  projectRow(db, 'accounts', { id: accountId }, { at });
  return true;
}

/**
 * The people she proposed for an account that may merge into the owner's: a live proposal by her whose person holds no
 * other account and was merged into nobody. A merge guard reads both the link rows and the account columns: whatever
 * names the person as someone else's keeps it apart.
 */
function proposedPeople(db: Db, accountId: string, owner: string): Array<string> {
  const proposals = db
    .prepare(
      `SELECT DISTINCT person_id FROM account_person_links WHERE account_id = ? AND state = 'proposed' AND by = 'her'
       AND valid_to_at IS NULL ORDER BY person_id`
    )
    .all(accountId)
    .map((row) => String(row.person_id));
  const holdsOther = db.prepare(
    `SELECT 1 AS ok FROM account_person_links WHERE person_id = ?1 AND state = 'verified' AND valid_to_at IS NULL
     AND account_id <> ?2 UNION ALL SELECT 1 FROM accounts WHERE person_id = ?1 AND id <> ?2
     UNION ALL SELECT 1 FROM people_merges WHERE from_person = ?1 LIMIT 1`
  );
  return proposals.filter((person) => person !== owner && person !== SELF_PERSON && !holdsOther.get(person, accountId));
}

/**
 * Links `accountId` to the owner's person `owner` as the owner's own word, the person made when nobody stored it. Her
 * proposals for the account are closed, and each tentative person of hers that holds nothing else merges into the owner.
 * The account's DM places name the owner as their partner, and so do the rows those DMs already hold.
 */
export function linkOwnerAccount(db: Db, accountId: string, owner: string, at: string): IdentityLinked {
  db.prepare("INSERT OR IGNORE INTO people (id, kind, status, first_seen_at) VALUES (?, 'person', 'active', ?)").run(
    owner,
    at
  );
  const merging = proposedPeople(db, accountId, owner);
  const current = ownerLinkedPerson(db, accountId);
  const linked = current === null || survivorOf(db, current) !== survivorOf(db, owner);
  if (linked) {
    linkAccount(db, accountId, survivorOf(db, owner), at, { by: 'owner', reason: 'the owner command line' });
    db.prepare('UPDATE places SET partner_person = ? WHERE partner_account = ?').run(survivorOf(db, owner), accountId);
    rescopeDmPlacesOfAccount(db, accountId);
    projectRow(db, 'accounts', { id: accountId }, { at });
  }
  for (const person of merging)
    mergePersonInto(db, { from: person, into: owner, by: 'owner', reason: 'the owner command line', at });
  return { linked, merged: merging };
}

/**
 * The person another account of the owner holds before a raw install's link (a unit write's copy, a link of an older
 * owner command): it merges into the owner's new person, so his memory stays one.
 */
export function earlierPersonOf(db: Db, accountId: string): string | null {
  const person =
    verifiedPerson(db, accountId) ??
    db.prepare('SELECT person_id FROM accounts WHERE id = ?').get(accountId)?.person_id;
  if (typeof person !== 'string' || person === '' || person === SELF_PERSON) return null;
  return db.prepare('SELECT 1 AS ok FROM people WHERE id = ?').get(person) ? person : null;
}

/** The tables whose rows carry the authority that issued their native key. */
const AUTHORITY_TABLES = [
  'accounts',
  'places',
  'sources',
  'participants',
  'connections',
  'message_families',
  'external_keys',
] as const;

/**
 * Moves the rows an interface stored under `<iface>/global` to its native authority when the two differ (the command
 * line and the core). A row whose key the native authority already holds stays where it is. Returns how many rows of
 * each table moved; nothing to move costs three lookups.
 */
export function adoptNativeAuthority(db: Db, iface: string): Record<string, number> {
  const from = `${iface}/global`;
  const to = nativeAuthorityOf(iface);
  if (to === from) return {};
  const left = db.prepare(
    `SELECT 1 AS ok FROM accounts WHERE authority_id = ?1 UNION ALL SELECT 1 FROM places WHERE authority_id = ?1
     UNION ALL SELECT 1 FROM external_keys WHERE authority_id = ?1 LIMIT 1`
  );
  if (!left.get(from)) return {};
  db.prepare('INSERT OR IGNORE INTO authorities (id, iface, namespace) VALUES (?, ?, ?)').run(
    to,
    iface,
    to.slice(iface.length + 1)
  );
  const moved: Record<string, number> = {};
  for (const table of AUTHORITY_TABLES)
    moved[table] = Number(
      db.prepare(`UPDATE OR IGNORE "${table}" SET authority_id = ? WHERE authority_id = ?`).run(to, from).changes
    );
  return moved;
}
