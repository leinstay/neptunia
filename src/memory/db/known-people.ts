// Who memory knows: a person it holds a description, a claim or an attitude change of, who stands (not retired, not
// merged away), with the accounts that are their own. The heartbeat's `<people>` list (heartbeat-lists.ts) lists these
// people, and a post or an intention aimed at a person (src/tools/operations/person-chat.ts) is refused for anyone
// else. Read only.

import { PERSONA_ID } from './ids.ts';
import { profileAccountsOf } from './meta-person.ts';
import type { ProfileAccount } from './meta-person.ts';
import type { Db } from './types.ts';

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

/** A known person who stands: their last seen moment (epoch ms, null when none) and their own accounts. */
export type KnownPerson = { lastSeenAt: number | null; accounts: Array<ProfileAccount> };

/** The people memory holds a description, a claim or an attitude change of, she aside, in id order. */
export function knownPersonIds(db: Db): Array<string> {
  return db
    .prepare(
      `SELECT d.subject_id AS id FROM descriptions d
         WHERE d.subject_kind = 'person' AND d.retired_at IS NULL AND d.current_version IS NOT NULL
       UNION SELECT c.subject_id FROM claims c WHERE c.subject_kind = 'person' AND c.retired_at IS NULL
       UNION SELECT e.person_id FROM affinity_events e WHERE e.person_id IS NOT NULL AND e.retired_at IS NULL
       ORDER BY id`
    )
    .all()
    .flatMap((row) => {
      const id = text(row.id);
      return id === null || id === PERSONA_ID ? [] : [id];
    });
}

/** Whether an account is a person's own, no bot's and no shared one. */
function userAccount(db: Db, accountId: string): boolean {
  const row = db.prepare('SELECT kind, retired_at FROM accounts WHERE id = ?').get(accountId);
  return row !== undefined && row.retired_at === null && (row.kind === null || row.kind === 'user');
}

/**
 * The person `personId` as memory knows them, for one of `knownPersonIds`: null for a retired or merged person and for
 * one with no account of their own.
 */
export function knownPersonOf(db: Db, personId: string): KnownPerson | null {
  const row = db
    .prepare(
      `SELECT p.last_seen_at FROM people p WHERE p.id = ? AND p.retired_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM people_merges m WHERE m.from_person = p.id)`
    )
    .get(personId);
  if (row === undefined) return null;
  const accounts = profileAccountsOf(db, personId).filter((one) => userAccount(db, one.id));
  if (accounts.length === 0) return null;
  const at = typeof row.last_seen_at === 'string' ? Date.parse(row.last_seen_at) : NaN;
  return { lastSeenAt: Number.isFinite(at) ? at : null, accounts };
}
