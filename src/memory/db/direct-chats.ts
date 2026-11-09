// The direct chats of a person she names in a call (docs/memory.md, "Finding a place or a person"). A direct chat has
// no channel handle, so `conversation.read` takes the person and reads their chat (src/turn/in-turn-tools.ts).
//
//   directChatsOf(db, ctx, reference, settings, meaning?) -> DirectChats
//
// The reference is a member handle (`@u…`, the handle a request gives the account's platform id, handles.ts#handleOf) or
// a name the index holds exactly for one person under the context. Their chats are the live direct chats of every
// account of the person and of every person merged into them, on any interface, newest line first. Words that name
// nobody give the people the memory graph ranks for them (graph-find.ts#peopleFound), each with the handle of their
// first account. Whether a chat may be read is the reader's rule. Read only.

import { handleOf, HANDLE_PREFIX } from '../../behavior/handles.ts';
import { peopleFound } from './graph-find.ts';
import type { FindMeaning, FindSettings, FoundPerson } from './graph-find.ts';
import { accountsOfPerson } from './meta-person.ts';
import { matchName } from './names.ts';
import { dmPlacesOfAccounts, personMembers } from './person-links.ts';
import type { Context } from './scope.ts';
import type { Db } from './types.ts';

/** A person she may call again with: a found person and the handle of their first account. */
export type FoundPersonRef = FoundPerson & { handle: string | null };
export type DirectChats =
  | { kind: 'chats'; personId: string; places: Array<string> }
  | { kind: 'found'; people: Array<FoundPersonRef> }
  | { kind: 'none' };

const PERSON_NODE = 'person:';

/** The people whose account has the member handle `handle` (its prefix and base-36 digits). */
export function peopleOfHandle(db: Db, handle: string): Set<string> {
  const people = new Set<string>();
  if (!new RegExp(`^${HANDLE_PREFIX}[0-9a-z]+$`).test(handle)) return people;
  const digits = handle.length - HANDLE_PREFIX.length;
  const rows = db.prepare('SELECT id, native_id FROM accounts WHERE retired_at IS NULL').all();
  for (const row of rows) {
    if (typeof row.native_id !== 'string' || handleOf(row.native_id, digits) !== handle) continue;
    const person = personOfAccountRow(db, String(row.id));
    if (person !== null) people.add(person);
  }
  return people;
}

/** The person an account belongs to: its meta-person row, else its verified link. */
function personOfAccountRow(db: Db, account: string): string | null {
  const meta = db.prepare('SELECT person_id FROM person_accounts WHERE id = ?').get(account);
  if (typeof meta?.person_id === 'string') return meta.person_id;
  const old = db.prepare("SELECT person_id FROM accounts WHERE id = ? AND link = 'verified'").get(account);
  return typeof old?.person_id === 'string' && old.person_id !== '' ? old.person_id : null;
}

/** The handle of a person's first account, null when they have none. */
function handleOfPerson(db: Db, person: string): string | null {
  const first = accountsOfPerson(db, person)[0];
  return first === undefined ? null : handleOf(first.platformId);
}

/** The live direct chats of a person's accounts and of everyone merged into them, newest line first. */
function chatsOfPerson(db: Db, person: string): Array<string> {
  const members = personMembers(db, person, { ownerMergesOnly: false });
  const accounts = new Set<string>(members.accounts.map((account) => String(account.id)));
  for (const account of accountsOfPerson(db, members.survivor)) accounts.add(account.id);
  const places = new Set<string>(dmPlacesOfAccounts(db, [...accounts]).map((place) => String(place.id)));
  const partners = [members.survivor, ...members.mergedFrom];
  for (const row of db
    .prepare(
      `SELECT id FROM places WHERE partner_person IN (${partners.map(() => '?').join(', ')})
       AND (kind = 'dm' OR chat = 'dm') AND retired_at IS NULL`
    )
    .all(...partners))
    places.add(String(row.id));
  const newest = db.prepare(
    "SELECT MAX(occurred_at) AS at FROM sources WHERE place_id = ? AND kind IN ('seen', 'said') AND retired_at IS NULL"
  );
  const at = (id: string): string => {
    const value = newest.get(id)?.at;
    return typeof value === 'string' ? value : '';
  };
  return [...places].sort((a, b) => (at(b) < at(a) ? -1 : at(b) > at(a) ? 1 : a < b ? -1 : a > b ? 1 : 0));
}

/** The direct chats of the person `reference` names under the context, or the people its words fit. */
export function directChatsOf(
  db: Db,
  ctx: Context,
  reference: string,
  settings: Partial<FindSettings> = {},
  meaning: FindMeaning = { vector: null, model: null }
): DirectChats {
  const given = reference.trim().replace(/^@/, '');
  if (given === '') return { kind: 'none' };
  let people = peopleOfHandle(db, given);
  if (people.size === 0)
    people = new Set(
      matchName(db, ctx, given, ['exact'])
        .filter((hit) => hit.nodeId.startsWith(PERSON_NODE))
        .map((hit) => hit.nodeId.slice(PERSON_NODE.length))
    );
  const [only] = [...people];
  if (people.size === 1 && only !== undefined)
    return { kind: 'chats', personId: only, places: chatsOfPerson(db, only) };
  const found = peopleFound(db, ctx, given, settings, meaning).filter(
    (person) => people.size === 0 || people.has(person.id)
  );
  if (found.length === 0) return { kind: 'none' };
  return { kind: 'found', people: found.map((person) => ({ ...person, handle: handleOfPerson(db, person.id) })) };
}
