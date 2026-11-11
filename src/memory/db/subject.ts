// The one thing memory.read names in its `subject` (src/turn/memory-read.ts), resolved under the turn's memory context.
//
//   subjectOf(db, ctx, words, here) -> Subject
//
// The words are a person's handle (`@u…`, the handle a request gives the meta-person's id, handles.ts#handleOf), a
// channel handle (`#c…`), the word `community` for the root of the place she stands in (`here`), the title of a lore
// entry, or a name: the name index's exact form for a person (names.ts#matchName) and its exact form or stems for a
// place (names.ts#placesNamed). A lore title is tried first, then people, then places, and the first kind that matches
// decides. One match is the subject. Two or more of that kind are `several`, each with the handle to write, and none at
// all is `none`. A place the context may not read is never matched. Whether a person may be shown is the graph
// reader's rule (mind-read.ts). Read only.

import { CHANNEL_HANDLE_PREFIX, HANDLE_PREFIX, handleOf } from '../../behavior/handles.ts';
import { handleOfPerson, peopleOfHandle } from './direct-chats.ts';
import { placeAudience } from './graph.ts';
import { accountsOfPerson, partnerPersonOfPlace, personOfAccount } from './meta-person.ts';
import { matchName, namesIn, normalName, placesNamed } from './names.ts';
import { allowedAudience, audienceWhere } from './scope.ts';
import type { Context } from './scope.ts';
import type { Db } from './types.ts';

/** A lore entry memory.read returns whole: its claim row, the place it is about and its text. */
export type LoreEntry = { id: string; placeId: string; placeName: string; text: string };
/** A choice of a `several` answer: the name it goes by and the token to write for it. */
export type SubjectChoice = { name: string; ref: string };
export type Subject =
  | { kind: 'person'; personId: string; accountId: string }
  | { kind: 'place'; placeId: string }
  | { kind: 'lore'; entries: Array<LoreEntry> }
  | { kind: 'several'; choices: Array<SubjectChoice> }
  | { kind: 'none' };

/** Where the read stands: the interface of the turn and the platform id of its root, null outside a root. */
export type SubjectHere = { iface: string; rootNative: string | null };

/** The word that names the root she stands in. */
export const COMMUNITY = 'community';

const NONE: Subject = { kind: 'none' };
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** Whether the context reads the stored place `placeId`. */
function readable(db: Db, ctx: Context, placeId: string): boolean {
  const place = db.prepare('SELECT id, iface, kind, chat, retired_at FROM places WHERE id = ?').get(placeId);
  return (
    place !== undefined && place.retired_at === null && allowedAudience({ audience_id: placeAudience(place) }, ctx)
  );
}

/** The stored root of `here`, null outside a root or when no row holds it. */
function rootOf(db: Db, here: SubjectHere): string | null {
  if (here.rootNative === null) return null;
  const row = db
    .prepare(
      `SELECT id FROM places WHERE iface = ? AND native_id = ? AND parent_id IS NULL AND retired_at IS NULL
         AND kind <> 'dm' AND COALESCE(chat, '') <> 'dm' ORDER BY id LIMIT 1`
    )
    .get(here.iface, here.rootNative);
  return text(row?.id);
}

/** The live channels and threads whose channel handle is `handle`, among those the context reads. */
function placesOfHandle(db: Db, ctx: Context, handle: string): Array<string> {
  if (!new RegExp(`^${CHANNEL_HANDLE_PREFIX}[0-9a-z]+$`).test(handle)) return [];
  const digits = handle.length - CHANNEL_HANDLE_PREFIX.length;
  return db
    .prepare("SELECT id, native_id FROM places WHERE kind IN ('channel', 'thread') AND retired_at IS NULL ORDER BY id")
    .all()
    .flatMap((row) => {
      const native = text(row.native_id);
      const id = text(row.id);
      if (native === null || id === null || handleOf(native, digits, CHANNEL_HANDLE_PREFIX) !== handle) return [];
      return readable(db, ctx, id) ? [id] : [];
    });
}

/** The live lore entries of places the context reads whose title is `words`, in the name index's folding. */
function loreTitled(db: Db, ctx: Context, words: string): Array<LoreEntry> {
  const folded = normalName(words);
  if (folded === '') return [];
  const where = audienceWhere(ctx, 'c');
  return db
    .prepare(
      `SELECT c.id, c.subject_id, c.text, c.extra, p.name FROM claims c LEFT JOIN places p ON p.id = c.subject_id
       WHERE c.kind = 'lore' AND c.subject_kind = 'place' AND c.retired_at IS NULL AND ${where.sql} ORDER BY c.id`
    )
    .all(...where.params)
    .flatMap((row) => {
      const title = titleOf(row.extra);
      const [id, placeId, body] = [text(row.id), text(row.subject_id), text(row.text)];
      if (title === null || normalName(title) !== folded || id === null || placeId === null || body === null) return [];
      return readable(db, ctx, placeId) ? [{ id, placeId, placeName: text(row.name) ?? placeId, text: body }] : [];
    });
}

/** The `title` of a lore claim's `extra`, null when it holds none. */
function titleOf(extra: unknown): string | null {
  try {
    const parsed: unknown = JSON.parse(text(extra) ?? '{}');
    return parsed !== null && typeof parsed === 'object' ? text((parsed as { title?: unknown }).title) : null;
  } catch {
    return null;
  }
}

/** The people the name index holds `words` for exactly, each once, an account's name standing for its person. */
function peopleNamed(db: Db, ctx: Context, words: string): Array<string> {
  const people = new Set<string>();
  for (const hit of matchName(db, ctx, words, ['exact'])) {
    if (hit.node?.kind === 'person') people.add(hit.node.rowId);
    if (hit.node?.kind !== 'account') continue;
    const person = personOfAccount(db, hit.node.rowId);
    if (person !== null) people.add(person);
  }
  return [...people];
}

/** A person as the subject: their first account rides along as the reader's seed of the counterpart. */
function personSubject(db: Db, personId: string): Subject {
  return { kind: 'person', personId, accountId: accountsOfPerson(db, personId)[0]?.id ?? '' };
}

/** A person as a choice: the first name of their first account, and the person's handle. */
function personChoice(db: Db, personId: string): SubjectChoice {
  const first = accountsOfPerson(db, personId)[0];
  const names = first === undefined ? null : db.prepare('SELECT names FROM accounts WHERE id = ?').get(first.id)?.names;
  return { name: namesIn(names)[0] ?? personId, ref: `@${handleOfPerson(personId)}` };
}

/**
 * A place as a choice: its stored name, and its channel handle when its row holds a native id. A direct chat is named by
 * its partner's handle, the person's, else the partner account's; a place with neither by its name.
 */
function placeChoice(db: Db, placeId: string): SubjectChoice {
  const row = db
    .prepare('SELECT name, native_id, kind, chat, partner_person, partner_account FROM places WHERE id = ?')
    .get(placeId);
  const native = text(row?.native_id);
  const name = text(row?.name);
  if (row !== undefined && (row.kind === 'dm' || row.chat === 'dm')) {
    const partner = partnerPersonOfPlace(db, row) ?? text(row.partner_account);
    const ref = partner === null ? (name ?? '') : `@${handleOf(partner)}`;
    return { name: name ?? ref, ref };
  }
  const handled = native !== null && (row?.kind === 'channel' || row?.kind === 'thread');
  return {
    name: name ?? '',
    ref: handled ? `#${handleOf(native, undefined, CHANNEL_HANDLE_PREFIX)}` : (name ?? ''),
  };
}

/** The subject of a list of people: one is the subject, more are choices, none is nothing. */
function ofPeople(db: Db, people: ReadonlyArray<string>): Subject {
  const [only] = people;
  if (only === undefined) return NONE;
  if (people.length === 1) return personSubject(db, only);
  return { kind: 'several', choices: people.map((id) => personChoice(db, id)) };
}

/** The subject of a list of places, as ofPeople. */
function ofPlaces(db: Db, places: ReadonlyArray<string>): Subject {
  const [only] = places;
  if (only === undefined) return NONE;
  if (places.length === 1) return { kind: 'place', placeId: only };
  return { kind: 'several', choices: places.map((id) => placeChoice(db, id)) };
}

/** The one thing `words` names under `ctx`, standing in `here`. */
export function subjectOf(db: Db, ctx: Context, words: string, here: SubjectHere): Subject {
  const given = words.trim();
  if (given === '') return NONE;
  if (given.toLowerCase() === COMMUNITY) {
    const root = rootOf(db, here);
    return root !== null && readable(db, ctx, root) ? { kind: 'place', placeId: root } : NONE;
  }
  if (given.startsWith('#')) {
    const handled = placesOfHandle(db, ctx, given.slice(1));
    if (handled.length > 0) return ofPlaces(db, handled);
    return ofPlaces(db, named(db, ctx, given.slice(1)));
  }
  const bare = given.replace(/^@/, '');
  if (given.startsWith('@') && new RegExp(`^${HANDLE_PREFIX}[0-9a-z]+$`).test(bare)) {
    const handled = [...peopleOfHandle(db, bare)];
    if (handled.length > 0) return ofPeople(db, handled);
  }
  const lore = loreTitled(db, ctx, bare);
  if (lore.length > 0) return { kind: 'lore', entries: lore };
  const people = peopleNamed(db, ctx, bare);
  if (people.length > 0) return ofPeople(db, people);
  return ofPlaces(db, named(db, ctx, bare));
}

/** The live places the context reads that the name index holds `name` for. */
function named(db: Db, ctx: Context, name: string): Array<string> {
  return placesNamed(db, ctx, name).flatMap((place) => (readable(db, ctx, place.id) ? [place.id] : []));
}
