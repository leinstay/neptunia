// The direct chats of a person she names in a call (docs/memory.md, "Finding a place or a person"). A direct chat has
// no channel handle, so `conversation.read` takes the person and reads their chat (src/turn/in-turn-tools.ts).
//
//   directChatsOf(db, ctx, reference, settings, meaning?) -> DirectChats
//
// The reference is a person's handle (`@u…`, the handle a request gives the meta-person's id, handles.ts#handleOf) or
// a name the index holds exactly for one person under the context. Their chats are the live direct chats of every
// account of the person and of every person merged into them, on any interface, newest line first. Words that name
// nobody give the people the memory graph ranks for them (graph-find.ts#peopleFound), each with their handle. Whether a
// chat may be read is the reader's rule. Read only.

import { handleOf, HANDLE_PREFIX } from '../../behavior/handles.ts';
import { peopleFound } from './graph-find.ts';
import type { FindMeaning, FindSettings, FoundPerson } from './graph-find.ts';
import { survivorOf } from './ids.ts';
import { accountsOfPerson } from './meta-person.ts';
import { matchName } from './names.ts';
import { dmPlacesOfAccounts, personMembers } from './person-links.ts';
import type { Context } from './scope.ts';
import type { Db } from './types.ts';

/** A person she may call again with: a found person and their handle. */
export type FoundPersonRef = FoundPerson & { handle: string | null };
export type DirectChats =
  | { kind: 'chats'; personId: string; places: Array<string> }
  | { kind: 'found'; people: Array<FoundPersonRef> }
  | { kind: 'none' };

/**
 * The people whose handle is `handle` (its prefix and base-36 digits): a live person whose id it is cut from
 * (handles.ts#handleOf), as the survivor of any merge, so the handle names the meta-person on every interface.
 */
export function peopleOfHandle(db: Db, handle: string): Set<string> {
  const people = new Set<string>();
  if (!new RegExp(`^${HANDLE_PREFIX}[0-9a-z]+$`).test(handle)) return people;
  const digits = handle.length - HANDLE_PREFIX.length;
  for (const row of db.prepare('SELECT id FROM people WHERE retired_at IS NULL').all()) {
    if (typeof row.id === 'string' && handleOf(row.id, digits) === handle) people.add(survivorOf(db, row.id));
  }
  return people;
}

/** The handle of a person (handles.ts#handleOf of the meta-person's id), as a request shows it. */
export function handleOfPerson(person: string): string {
  return handleOf(person);
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
      matchName(db, ctx, given, ['exact']).flatMap((hit) => (hit.node?.kind === 'person' ? [hit.node.rowId] : []))
    );
  const [only] = [...people];
  if (people.size === 1 && only !== undefined)
    return { kind: 'chats', personId: only, places: chatsOfPerson(db, only) };
  const found = peopleFound(db, ctx, given, settings, meaning).filter(
    (person) => people.size === 0 || people.has(person.id)
  );
  if (found.length === 0) return { kind: 'none' };
  return { kind: 'found', people: found.map((person) => ({ ...person, handle: handleOfPerson(person.id) })) };
}
