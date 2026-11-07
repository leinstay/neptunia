// A synthetic world for the name index (src/memory/db/names.ts) and the graph reader (src/memory/db/mind-read.ts):
// interfaces with their names, roots and rooms, people with their accounts, memberships, aliases and claims, and lines.
// Every row goes in through `insertRows`, the path the unit writers take, so the graph and the name index are what the
// writers leave. The interfaces and their roots come in through `noteCommunities`, the writer a `hello` reaches.
// Names are invented, in Greek and accented Latin.
import { noteCommunities } from '../../../src/memory/db/communities.ts';
import { graphNodeId, projectRow } from '../../../src/memory/db/graph.ts';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { addRelation, insertRows } from '../../../src/memory/db/rows.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import type { Db, MemoryHandle } from '../../../src/memory/db/types.ts';

export const AT = '2026-11-01T10:00:00.000Z';
export const NOW = Date.parse('2026-11-02T10:00:00.000Z');

export type World = { handle: MemoryHandle; db: Db; close: () => void };

export function openWorld(): World {
  const handle = openMemoryDb(':memory:');
  return { handle, db: dbOf(handle), close: () => handle.close() };
}

export const personNode = (id: string): string => graphNodeId('person', id);
export const placeNode = (id: string): string => graphNodeId('place', id);
export const interfaceNode = (id: string): string => graphNodeId('interface', id);

export type InterfaceNames = { interface: string; nouns: Record<string, string>; dm: string };

/** The roots an interface's `hello` names, and its own names when the hello carries them. */
export function noteInterface(
  world: World,
  iface: string,
  roots: ReadonlyArray<{ id: string; name: string }>,
  names?: InterfaceNames
): void {
  noteCommunities(world.handle, { iface, communities: roots, at: AT, ...(names === undefined ? {} : { names }) });
}

export const rootId = (iface: string, native: string): string => `${iface}:server:${native}`;

export function addRoom(db: Db, { iface, native, root, name }: { iface: string; native: string; root: string; name: string }): string {
  const id = `${iface}:channel:${native}`;
  insertRows(db, {
    places: [{ id, iface, kind: 'channel', native_id: native, parent_id: root, scope_kind: 'group', name, seen_from_at: AT }],
  });
  return id;
}

/** A person with one account or several, each with its display names, all linked as verified. */
export function addPerson(
  db: Db,
  {
    id,
    realName = null,
    affinity = null,
    accounts,
  }: {
    id: string;
    realName?: string | null;
    affinity?: number | null;
    accounts: ReadonlyArray<{ id: string; iface: string; native: string; names: ReadonlyArray<string> }>;
  }
): void {
  insertRows(db, {
    people: [{ id, real_name: realName, affinity, first_seen_at: AT }],
    accounts: accounts.map((account) => ({
      id: account.id,
      iface: account.iface,
      native_id: account.native,
      person_id: id,
      link: 'verified',
      names: JSON.stringify(account.names),
      kind: 'user',
    })),
  });
}

export function addMembership(db: Db, { account, place, nick = null }: { account: string; place: string; nick?: string | null }): string {
  const id = `membership:${account}:${place}`;
  insertRows(db, { memberships: [{ id, account_id: account, place_id: place, nick, valid_from_at: AT }] });
  return id;
}

/** The direct chat of a partner's account: `<iface>:dm:<native>`. */
export function addDm(db: Db, { iface, native, person, account }: { iface: string; native: string; person: string; account: string }): string {
  const id = `${iface}:dm:${native}`;
  insertRows(db, {
    places: [
      { id, iface, kind: 'dm', native_id: native, scope_kind: 'dm', partner_person: person, partner_account: account, seen_from_at: AT },
    ],
  });
  return id;
}

/** Where a row may be read: the groups of an interface, or one direct chat with its partner. */
export type Audience = { group: string } | { dm: string; iface: string; person: string };

const scopeOf = (audience: Audience): Record<string, string | null> =>
  'group' in audience
    ? { scope_kind: 'group', scope_iface: audience.group, scope_dm: null }
    : { scope_kind: 'dm', scope_iface: audience.iface, scope_dm: audience.person, audience_id: `aud:dm:${audience.dm}` };

/** A claim about a person: an alias (a name) or a fact. */
export function addClaim(
  db: Db,
  {
    id,
    person,
    kind,
    text,
    audience,
    retiredAt = null,
  }: { id: string; person: string; kind: 'alias' | 'fact'; text: string; audience: Audience; retiredAt?: string | null }
): void {
  insertRows(db, {
    claims: [
      {
        id,
        subject_kind: 'person',
        subject_id: person,
        kind,
        text,
        truth: 'current',
        shown: 1,
        created_at: AT,
        retired_at: retiredAt,
        ...scopeOf(audience),
      },
    ],
  });
}

/** A chat line: hers (`author: 'self'`) or an account's, in a group room or a direct chat. */
export function addLine(
  db: Db,
  {
    id,
    iface,
    place,
    author,
    text,
    at = AT,
    audience = { group: iface },
  }: { id: string; iface: string; place: string; author: string; text: string; at?: string; audience?: Audience }
): string {
  const self = author === 'self';
  insertRows(db, {
    sources: [
      {
        id,
        kind: self ? 'said' : 'seen',
        iface,
        native_id: id,
        native_kind: 'message',
        place_id: place,
        author_account: self ? null : author,
        occurred_at: at,
        recorded_at: at,
        text,
        ...scopeOf(audience),
      },
    ],
  });
  return id;
}

/** `from` answers `to`, both stored lines. */
export function addReply(db: Db, from: string, to: string): void {
  addRelation(db, from, 'replies_to', { source: to });
  projectRow(db, 'sources', { id: from });
}

/** Hides a node from every reader: no audience may read it, as `node_access` says of a node nobody may see. */
export function deny(db: Db, nodeId: string): void {
  db.prepare('DELETE FROM node_access WHERE node_id = ?').run(nodeId);
}

/** A learned stemmer as the writers' projection job stores it, before any name is written. */
export function seedStemmer(db: Db, endings: ReadonlyArray<string>, productivity: ReadonlyArray<[string, number]>): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('stemmer', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(JSON.stringify({ count: 0, endings, productivity }));
}
