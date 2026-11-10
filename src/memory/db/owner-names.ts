// A name the owner gives a person (`/memory users names add|remove`, src/interface/commands/console.ts) through the
// writer's kind `owner-name` (session-write.ts): an `alias` claim with `author` `owner`, added once or retired, in the
// audience a member's profile gives its aliases. A name her memory session or the analyzer writes has another author, so
// the two never mix; `ownerNamesOf` in people-read.ts reads them back.

import { projectRow } from './graph.ts';
import { ensureAudience } from './rows.ts';
import { SCOPE_INTERNAL, audienceOf, groupScope } from './scope.ts';
import type { Scope } from './scope.ts';
import { SESSION_COLUMNS } from './profile-owner.ts';
import { dbOf, isFiniteNumber } from './types.ts';
import type { Db, MemoryHandle, Row } from './types.ts';

const coded = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });

/**
 * The scope of a name the owner gives a person: the groups of the person's interface, the scope a member's profile gives
 * its aliases (account-profile.ts). `iface` is the interface the command came from, for a person with no account; with
 * neither the name is internal. Which interface of several makes no difference to who reads it: every group audience
 * reads alike (scope.ts#allowedAudience).
 */
export function ownerNameScope(db: Db, personId: string, iface: unknown): Scope & { audience_id: string } {
  const account = db
    .prepare("SELECT iface FROM accounts WHERE person_id = ? AND link = 'verified' AND retired_at IS NULL ORDER BY id")
    .get(personId)?.iface;
  const found = account ?? iface;
  return audienceOf(typeof found === 'string' && found !== '' ? groupScope(found) : SCOPE_INTERNAL);
}

/**
 * A name the owner gave a person (`/memory users names add|remove`): an `alias` claim with `author` `owner`, added once or
 * retired. A name her memory session or the analyzer writes has another author, so the two never mix.
 */
export function writeOwnerName(db: Db, update: Row, at: string): { personId: string; name: string; stored: boolean } {
  const personId = typeof update.personId === 'string' ? update.personId : '';
  const name = typeof update.name === 'string' ? update.name.trim() : '';
  if (!personId || !name) throw coded('OWNER_NAME_BAD');
  const live = db
    .prepare(
      "SELECT id FROM claims WHERE subject_id = ? AND kind = 'alias' AND author = 'owner' AND retired_at IS NULL AND lower(text) = lower(?)"
    )
    .get(personId, name) as { id?: string } | undefined;
  if (update.remove === true) {
    if (live?.id) {
      db.prepare('UPDATE claims SET retired_at = ? WHERE id = ?').run(at, live.id);
      projectRow(db, 'claims', { id: live.id }, { at });
    }
    return { personId, name, stored: false };
  }
  if (!live?.id) {
    const id = `claim:owner-name:${personId}:${name.toLowerCase()}:${at}`;
    const scope = ownerNameScope(db, personId, update.iface);
    ensureAudience(db, scope);
    db.prepare(
      `INSERT INTO claims (id, subject_kind, subject_id, kind, text, weight, first_seen_at, last_seen_at, how, author,
        truth, created_at, scope_kind, scope_iface, scope_dm, audience_id, writer)
        VALUES (?, 'person', ?, 'alias', ?, 1, ?, ?, 'owner', 'owner', 'current', ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      personId,
      name,
      at,
      at,
      at,
      scope.scope_kind,
      scope.scope_iface,
      scope.scope_dm,
      scope.audience_id,
      SESSION_COLUMNS.writer
    );
    projectRow(db, 'claims', { id }, { at });
  }
  return { personId, name, stored: true };
}

/** The write kind `owner-name` on the writer connection. */
export function applyOwnerNameWrite(
  handle: MemoryHandle,
  update: Row
): { personId: string; name: string; stored: boolean } {
  const at = new Date(isFiniteNumber(update.now) ? update.now : Date.now()).toISOString();
  return handle.transaction(() => writeOwnerName(dbOf(handle), update, at));
}
