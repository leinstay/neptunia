// The reads of a request built on the turn frame beside the graph reader (src/memory/db/mind-read.ts): her own last
// lines in other places and the lines around one line for `<meanwhile>`, each with its media, the descriptions of the
// media of a place's lines for a read of lines the platform gives, one stored line by its identity for a reference in a
// stored text, whether a lookup's source is retired, the stored fields of a place for `<surroundings>`,
// a place as its interface knows it (its interface, kind and native ids, for a call that speaks to the interface),
// an interface's name and nouns and her past selfreflection entries for a selfreflection request's `<selfreflection>`.
// Each read applies the turn's context (`whereFor`), so nothing a scope may not read leaves here. Read only.

import { directChatsOf } from './direct-chats.ts';
import type { DirectChats } from './direct-chats.ts';
import { findSettingsOf, peopleFound, placesFound } from './graph-find.ts';
import type { FindMeaning, FoundPerson, FoundPlace } from './graph-find.ts';
import { mindOf, mindSettingsOf } from './mind-read.ts';
import type { Mind, Seeds } from './mind-read.ts';
import { lineMedia, lineMediaItems } from './media-store.ts';
import { interfaceTakes, routeMessageSql } from './message-locator.ts';
import type { LineMediaItem } from './media-store.ts';
import { personOfAccount as personOfMeta } from './meta-person.ts';
import { interfaceNouns, placesNamed } from './names.ts';
import { ownerAccountOfPlace } from './person-links.ts';
import { placeChainInDb } from './place-tree.ts';
import { allowedAudience, whereFor } from './scope.ts';
import { placeAudience } from './graph.ts';
import { readSelfreflection } from './selfreflection-past.ts';
import { subjectOf } from './subject.ts';
import type { Subject, SubjectHere } from './subject.ts';
import { affinityChangesOf } from '../affinity-changes.ts';
import type { AffinityChange } from '../affinity-changes.ts';
import type { PastEntry } from './selfreflection-past.ts';
import type { Context } from './scope.ts';
import type { Db, Row } from './types.ts';

/**
 * A stored chat line as a request reads it: its message id, the id of its source row, its place, epoch ms, the author's
 * platform id and stored name, its text and its media in position order. The message id is the platform's from the row's
 * message route, else the row's `native_id`, else its source id. `platformId` says whether its interface takes that id
 * as an anchor (message-locator.ts#interfaceTakes): the route gave it, or `native_id` holds no uuid the core made.
 */
export type FrameLine = {
  id: string;
  platformId: boolean;
  sourceId: string;
  placeId: string;
  at: number;
  authorId: string | null;
  /** The first name of the author's person, from the account that holds the person's profile, else the account's own. */
  authorName: string | null;
  /**
   * What the author's handle is cut from: the person of the author's account (`person_accounts`, else its verified link),
   * else the account row id; null for her own line and a line with no account.
   */
  authorKey: string | null;
  /** The interface of the author's account, null without one. */
  authorIface: string | null;
  self: boolean;
  text: string;
  media: ReadonlyArray<LineMediaItem>;
};

/** The word a path takes for a one-to-one chat, between the interface and the partner's id. A path segment, no label. */
const DM_WORD = 'private';

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** Where a line stands: its place's path, whether that place is a one-to-one chat, and that chat's partner person. */
/**
 * A place's path by names, whether it is a one-to-one chat, that chat's partner person, and what the partner's handle
 * is cut from (the person, else the partner account), null for any other place.
 */
export type PlacePath = { path: Array<string>; dm: boolean; partner: string | null; partnerKey?: string | null };

/**
 * A place by names from its interface (`places.iface`) down; a one-to-one chat's ends in the platform id of its partner
 * account (`places.partner_account`), the place id when no account row holds one. The place's own row is read once,
 * with its interface, and the walk goes on from its parent.
 */
export function placePathOf(db: Db, placeId: string): PlacePath {
  const row = db
    .prepare(
      `SELECT p.iface, p.kind, p.name, p.parent_id, p.partner_person, p.partner_account, a.native_id AS partner_native
       FROM places p LEFT JOIN accounts a ON a.id = p.partner_account WHERE p.id = ?`
    )
    .get(placeId);
  const iface = text(row?.iface) ?? '';
  if (row === undefined) return { path: [iface, placeId], dm: false, partner: null };
  if (row.kind === 'dm') {
    const partner = text(row.partner_person);
    const account = text(row.partner_account);
    const partnerKey = partner ?? (account === null ? null : (personOfMeta(db, account) ?? account));
    return { path: [iface, DM_WORD, text(row.partner_native) ?? placeId], dm: true, partner, partnerKey };
  }
  const parent = text(row.parent_id);
  const above = parent === null ? [] : placeChainInDb(db, parent);
  const loop = above.findIndex((link) => link.id === placeId);
  const names = [
    text(row.name) ?? placeId,
    ...(loop < 0 ? above : above.slice(0, loop)).map((link) => link.name ?? link.id),
  ];
  return { path: [iface, ...names.reverse()], dm: false, partner: null };
}

/** A stored place as a request names it (placePathOf), null for a place no row holds. */
export function placeViewOf(db: Db, placeId: string): PlacePath | null {
  const row = db.prepare('SELECT 1 AS known FROM places WHERE id = ?').get(placeId);
  return row === undefined ? null : placePathOf(db, placeId);
}

/** The message id of a line row: its route's (`route_message`), else its `native_id`, else its source id. */
const messageIdOf = (row: Row): string => String(text(row.route_message) ?? row.native_id ?? row.id);

/** The first row of each key, in order: a message's newest revision when the rows come newest revision first. */
function firstOf(rows: ReadonlyArray<Row>, keyOf: (row: Row) => string): Array<Row> {
  const seen = new Set<string>();
  return rows.filter((row) => !seen.has(keyOf(row)) && Boolean(seen.add(keyOf(row))));
}

const lineOf = (row: Row, media: ReadonlyArray<LineMediaItem> = []): FrameLine => ({
  id: messageIdOf(row),
  platformId: interfaceTakes(row.route_message, row.native_id),
  sourceId: String(row.id),
  placeId: text(row.place_id) ?? '',
  at: Date.parse(text(row.occurred_at) ?? ''),
  authorId: text(row.author_native),
  authorName: text(row.author_name),
  authorKey: row.author_kind === 'self' ? null : (text(row.author_person) ?? text(row.author_account)),
  authorIface: text(row.author_iface),
  self: row.author_kind === 'self',
  text: text(row.text) ?? '',
  media,
});

/** Each row as its line, with the media the context reads of every row in one read (media-store.ts#lineMedia). */
function linesOf(db: Db, ctx: Context, rows: ReadonlyArray<Row>): Array<FrameLine> {
  const media = lineMedia(
    db,
    rows.map((row) => String(row.id)),
    ctx
  );
  return rows.map((row) => lineOf(row, lineMediaItems(media.get(String(row.id)) ?? [])));
}

/** The first stored name of a line's author: its person's profile account's, else its own account's (`aa`). */
const AUTHOR_NAME = `COALESCE(
  (SELECT json_extract(pa.names, '$[0]') FROM accounts a JOIN people p ON p.id = a.person_id
     JOIN accounts pa ON pa.id = p.holder_id
   WHERE a.id = s.author_account AND p.writer = 'profile'),
  json_extract(aa.names, '$[0]')) AS author_name`;
/** Lines with their author's account row, whose `native_id` is the author's platform id. */
const LINE_FROM = 'sources s LEFT JOIN accounts aa ON aa.id = s.author_account';
/** The person of a line's author's account: its meta-person, else its verified link (meta-person.ts#personOfAccount). */
const AUTHOR_PERSON = `COALESCE(
  (SELECT pm.person_id FROM person_accounts pm WHERE pm.id = s.author_account),
  CASE WHEN aa.link = 'verified' THEN aa.person_id END) AS author_person`;
const LINE_COLUMNS = `s.id, s.native_id, ${routeMessageSql('s')} AS route_message, s.place_id, s.occurred_at, s.author_account, s.author_kind, s.text,
  aa.native_id AS author_native, aa.iface AS author_iface, ${AUTHOR_NAME}, ${AUTHOR_PERSON}`;
/** A line that says something: its text, or a media item linked to it, as a post of a picture alone. */
const LIVE_LINE = `s.kind IN ('seen', 'said') AND s.retired_at IS NULL AND (length(COALESCE(s.text, '')) > 0
  OR EXISTS (SELECT 1 FROM media_links ml WHERE ml.owner_kind = 'source' AND ml.owner_id = s.id))`;

/**
 * Her newest lines the context reads outside `exceptPlace`, newest first, at most `limit`, one per message (its newest
 * revision), each with its place's path and whether that place is a one-to-one chat.
 */
export function ownLinesOf(
  db: Db,
  ctx: Context,
  exceptPlace: string | null,
  limit: number
): Array<FrameLine & PlacePath> {
  const where = whereFor(ctx, 's');
  const rows = db
    .prepare(
      `SELECT ${LINE_COLUMNS} FROM ${LINE_FROM}
       WHERE s.author_kind = 'self' AND ${LIVE_LINE} AND s.place_id IS NOT ? AND ${where.sql}
       ORDER BY s.occurred_at DESC, s.revision DESC LIMIT ?`
    )
    .all(exceptPlace, ...where.params, Math.max(0, limit) * 2);
  const paths = new Map<string, PlacePath>();
  const out: Array<FrameLine & PlacePath> = [];
  const kept = firstOf(rows, (row) => `${text(row.place_id) ?? ''}\u0000${messageIdOf(row)}`);
  for (const line of linesOf(db, ctx, kept.slice(0, Math.max(0, limit)))) {
    if (!paths.has(line.placeId)) paths.set(line.placeId, placePathOf(db, line.placeId));
    out.push({ ...line, ...(paths.get(line.placeId) ?? { path: [], dm: false, partner: null }) });
  }
  return out;
}

/** The lines of `placeId` the context reads from `count` before epoch ms `at` to `count` after it, oldest first. */
export function linesAroundOf(db: Db, ctx: Context, placeId: string, at: number, count: number): Array<FrameLine> {
  const where = whereFor(ctx, 's');
  const iso = new Date(at).toISOString();
  const read = (order: 'DESC' | 'ASC', compare: string, n: number): Array<Row> =>
    db
      .prepare(
        `SELECT ${LINE_COLUMNS} FROM ${LINE_FROM}
         WHERE s.place_id = ? AND s.occurred_at ${compare} ? AND ${LIVE_LINE} AND ${where.sql}
         ORDER BY s.occurred_at ${order}, s.revision DESC LIMIT ?`
      )
      .all(placeId, iso, ...where.params, n);
  const before = read('DESC', '<=', count + 1).reverse();
  const after = read('ASC', '>', count);
  return linesOf(db, ctx, firstOf([...before, ...after], messageIdOf));
}

/** The first `count` lines of `placeId` the context reads at or after epoch ms `from`, oldest first. */
export function linesSinceOf(db: Db, ctx: Context, placeId: string, from: number, count: number): Array<FrameLine> {
  const where = whereFor(ctx, 's');
  const limit = Math.max(0, Math.floor(count));
  // Twice the count: an edited message holds a row per revision, and only its newest one stays.
  const rows = db
    .prepare(
      `SELECT ${LINE_COLUMNS} FROM ${LINE_FROM}
       WHERE s.place_id = ? AND s.occurred_at >= ? AND ${LIVE_LINE} AND ${where.sql}
       ORDER BY s.occurred_at ASC, s.revision DESC LIMIT ?`
    )
    .all(placeId, new Date(from).toISOString(), ...where.params, limit * 2);
  return linesOf(db, ctx, firstOf(rows, messageIdOf).slice(0, limit));
}

/**
 * The first stored name of the account an interface names by the platform id `native`, on `iface` first, else on any
 * interface where one account alone holds that id: its person's profile account's first name, else its own. Null when
 * no account row holds a name.
 */
export function accountNameOf(db: Db, iface: string, native: string): string | null {
  const rows = db
    .prepare(
      `SELECT aa.iface, COALESCE(
         (SELECT json_extract(pa.names, '$[0]') FROM people p JOIN accounts pa ON pa.id = p.holder_id
          WHERE p.id = aa.person_id AND p.writer = 'profile'),
         json_extract(aa.names, '$[0]')) AS name
       FROM accounts aa WHERE aa.native_id = ? ORDER BY aa.iface = ? DESC, aa.generation DESC`
    )
    .all(native, iface);
  const here = rows.find((row) => row.iface === iface);
  if (here) return text(here.name);
  return new Set(rows.map((row) => row.iface)).size === 1 ? text(rows[0]?.name) : null;
}

/**
 * What the handle of the member an interface names by the platform id `native` is cut from: the person of the account
 * (meta-person.ts#personOfAccount), else the account row id. The account is the one on `iface`, else the one account
 * that holds the id on any interface. Null when no account row holds it.
 */
export function memberKeyOf(db: Db, iface: string, native: string): string | null {
  const rows = db
    .prepare('SELECT id, iface FROM accounts WHERE native_id = ? ORDER BY iface = ? DESC, generation DESC, id')
    .all(native, iface);
  const here = rows.find((row) => row.iface === iface);
  const account = text(here?.id) ?? (new Set(rows.map((row) => row.iface)).size === 1 ? text(rows[0]?.id) : null);
  return account === null ? null : (personOfMeta(db, account) ?? account);
}

/**
 * The text forms of the media of the stored lines of `placeId` with these message ids (a message's route id and its
 * family key count as its id), by the item's platform reference: what a read of lines the platform gives renders for a picture the memory
 * has described. One read; a media item is read only through a line the context reads.
 */
export function mediaTextsOf(
  db: Db,
  ctx: Context,
  placeId: string,
  messageIds: ReadonlyArray<string>
): Map<string, string> {
  const found = new Map<string, string>();
  if (messageIds.length === 0) return found;
  const where = whereFor(ctx, 's');
  const ids = JSON.stringify(messageIds);
  const rows = db
    .prepare(
      `SELECT m.native_ref AS ref, m.description AS description
       FROM sources s JOIN media_links l ON l.owner_kind = 'source' AND l.owner_id = s.id
         JOIN media m ON m.id = l.media_id
       WHERE s.place_id = ? AND s.kind IN ('seen', 'said') AND s.retired_at IS NULL AND ${where.sql}
         AND (s.native_id IN (SELECT value FROM json_each(?))
           OR ${routeMessageSql('s')} IN (SELECT value FROM json_each(?))
           OR s.native_id IN (SELECT f.native_key FROM message_families f
             WHERE f.iface = s.iface AND f.message_id IN (SELECT value FROM json_each(?))))
         AND m.retired_at IS NULL AND m.native_ref IS NOT NULL AND m.description IS NOT NULL
       ORDER BY s.revision`
    )
    .all(placeId, ...where.params, ids, ids, ids);
  for (const row of rows) {
    const ref = text(row.ref);
    const description = text(row.description);
    if (ref !== null && description !== null) found.set(ref, description);
  }
  return found;
}

/** Whether the context reads the stored place `placeId`, retired or live: a gone room keeps its read handle. */
export function placeReadableOf(db: Db, ctx: Context, placeId: string): boolean {
  const place = db.prepare('SELECT id, iface, kind, chat FROM places WHERE id = ?').get(placeId);
  return place !== undefined && allowedAudience({ audience_id: placeAudience(place) }, ctx);
}

/** Every stored channel and thread of every interface, retired or live, with its native id: the places a `#handle` may name. */
export function chatPlacesOf(db: Db): Array<{ id: string; nativeId: string | null }> {
  return db
    .prepare("SELECT id, native_id FROM places WHERE kind IN ('channel', 'thread') ORDER BY id")
    .all()
    .flatMap((row) => (typeof row.id === 'string' ? [{ id: row.id, nativeId: text(row.native_id) }] : []));
}

/** What an interface knows a stored place by: its interface, its kind, its own native id and its DM partner's. */
export type PlaceRef = { iface: string; kind: string; nativeId: string | null; partnerNativeId: string | null };

/** The stored place `placeId` as its interface knows it, in one read of its row and its partner's account; null without a row. */
export function placeRefOf(db: Db, placeId: string): PlaceRef | null {
  const row = db
    .prepare(
      `SELECT p.iface, p.kind, p.native_id, a.native_id AS partner_native FROM places p
       LEFT JOIN accounts a ON a.id = p.partner_account WHERE p.id = ?`
    )
    .get(placeId);
  if (row === undefined) return null;
  return {
    iface: text(row.iface) ?? '',
    kind: text(row.kind) ?? '',
    nativeId: text(row.native_id),
    partnerNativeId: text(row.partner_native),
  };
}

/** The stored name of a place, null for a one-to-one chat and a place that holds none. */
export function placeNameOf(db: Db, placeId: string): string | null {
  const row = db.prepare('SELECT kind, name FROM places WHERE id = ?').get(placeId);
  return row === undefined || row.kind === 'dm' ? null : text(row.name);
}

/**
 * The chat an interface speaks to for a place: the address the place holds, the chat id its interface gave, for a direct
 * chat as for a channel; null when it holds none (src/interface/place-chat.ts opens a direct chat that holds none).
 */
export function nativeChatOf(ref: PlaceRef): string | null {
  return ref.nativeId;
}

/** A stored line by its identity without the revision, as a reference names it. */
export type IdentityLine = FrameLine & {
  path: Array<string>;
  revision: number;
  deleted: boolean;
  /** True when its place is a one-to-one chat. */
  dm: boolean;
};

/**
 * The line `src:<iface>:<message id>` names, at its newest revision the context reads; `deleted` when the message was
 * deleted. Null for an identity of another shape and for a line the context cannot read.
 */
export function lineOfIdentity(db: Db, ctx: Context, key: string): IdentityLine | null {
  const match = /^src:([^:]+):(.+)$/.exec(key);
  if (!match) return null;
  const [, iface, native] = match;
  const where = whereFor(ctx, 's');
  const rows = db
    .prepare(
      `SELECT ${LINE_COLUMNS}, s.kind, s.revision FROM ${LINE_FROM}
       WHERE s.iface = ? AND s.native_id = ? AND s.kind IN ('seen', 'said', 'deleted') AND s.retired_at IS NULL
         AND ${where.sql}
       ORDER BY s.revision DESC, s.rowid DESC`
    )
    .all(iface, native, ...where.params);
  const line = rows.find((row) => row.kind !== 'deleted');
  if (!line) return null;
  const placeId = text(line.place_id) ?? '';
  const located = placePathOf(db, placeId);
  return {
    ...lineOf(line),
    path: located.path,
    dm: located.dm,
    revision: Number(line.revision ?? 1) || 1,
    deleted: rows.some((row) => row.kind === 'deleted'),
  };
}

/**
 * Whether the line of the message a source row holds is gone, found by the row's `iface` and `native_id` in one query:
 * true when the context reads no live revision of it or reads its deletion, and for a source id no row holds. The same
 * verdict as a null or deleted lineOfIdentity, without reading the line itself.
 */
export function sourceRetiredOf(db: Db, ctx: Context, sourceId: string): boolean {
  const where = whereFor(ctx, 's');
  const row = db
    .prepare(
      `SELECT MAX(s.kind = 'deleted') AS gone, MAX(s.kind <> 'deleted') AS live
       FROM sources r JOIN sources s ON s.iface = r.iface AND s.native_id = r.native_id
       WHERE r.id = ? AND s.kind IN ('seen', 'said', 'deleted') AND s.retired_at IS NULL AND ${where.sql}`
    )
    .get(sourceId, ...where.params);
  return row?.live !== 1 || row.gone === 1;
}

/** The current stored fields of a place the context reads, by field name, a one-to-one chat's before a group's. */
export function placeFieldsOf(db: Db, ctx: Context, placeId: string): Record<string, string> {
  const where = whereFor(ctx, 'd');
  const rows = db
    .prepare(
      `SELECT d.field, v.text FROM descriptions d JOIN description_versions v ON v.id = d.current_version
       WHERE d.subject_kind = 'place' AND d.subject_id = ? AND d.retired_at IS NULL AND ${where.sql}
       ORDER BY d.field, d.scope_kind = 'dm' DESC, d.id`
    )
    .all(placeId, ...where.params);
  const fields: Record<string, string> = {};
  for (const row of rows) {
    const field = text(row.field);
    const value = text(row.text);
    if (field !== null && value !== null && !Object.hasOwn(fields, field)) fields[field] = value;
  }
  return fields;
}

/**
 * The `current_version` ids of the live descriptions of a place the context reads, sorted: what `placeFieldsOf` renders
 * changes only with one of them, so a request holds `<surroundings>` per cache bucket under these ids.
 */
export function placeVersionsOf(db: Db, ctx: Context, placeId: string): Array<string> {
  const where = whereFor(ctx, 'd');
  return db
    .prepare(
      `SELECT d.current_version AS version FROM descriptions d
       WHERE d.subject_kind = 'place' AND d.subject_id = ? AND d.retired_at IS NULL AND d.current_version IS NOT NULL
         AND ${where.sql}
       ORDER BY d.current_version`
    )
    .all(placeId, ...where.params)
    .map((row) => text(row.version))
    .filter((id): id is string => id !== null);
}

/** The account row of a platform id on an interface, its newest generation first; null when none is stored. */
export function accountOfNative(db: Db, iface: string, native: string): string | null {
  const row = db
    .prepare('SELECT id FROM accounts WHERE iface = ? AND native_id = ? ORDER BY generation DESC')
    .get(iface, native);
  return text(row?.id);
}

/**
 * The stored line of an interface's message id: its family's native key (`message_families`, the key a line is stored
 * under), else the id itself, by the line's native id, newest revision first; null when the memory holds no such line.
 */
export function sourceOfMessage(db: Db, iface: string, messageId: string): string | null {
  const family = db
    .prepare(
      'SELECT native_key FROM message_families WHERE iface = ? AND message_id = ? ORDER BY generation DESC LIMIT 1'
    )
    .get(iface, messageId);
  const key = text(family?.native_key) ?? messageId;
  const byKey = db
    .prepare(
      'SELECT id FROM sources WHERE iface = ? AND native_id = ? AND retired_at IS NULL ORDER BY revision DESC LIMIT 1'
    )
    .get(iface, key);
  return text(byKey?.id);
}

/** The stored line of a message id in a stored place, on the place's own interface (sourceOfMessage); null when none. */
export function sourceInPlace(db: Db, placeId: string, messageId: string): string | null {
  const iface = text(db.prepare('SELECT iface FROM places WHERE id = ?').get(placeId)?.iface);
  return iface === null ? null : sourceOfMessage(db, iface, messageId);
}

/** The person an account row belongs to; null for an unknown account. */
export function personOfAccount(db: Db, account: string): string | null {
  return text(db.prepare('SELECT person_id FROM accounts WHERE id = ?').get(account)?.person_id);
}

/** An interface's name and its nouns for its kinds of place, as its `hello` declared them. */
export function interfaceNamesOf(db: Db, iface: string): { name: string | null; nouns: Record<string, string> } {
  const row = db.prepare('SELECT name, extra FROM interfaces WHERE id = ?').get(iface);
  return { name: text(row?.name), nouns: interfaceNouns(row?.extra) };
}

/** The interfaces she runs on, by id: those the memory holds a place of, the command line's included. */
export function interfaceIdsOf(db: Db): Array<string> {
  return db
    .prepare('SELECT i.id FROM interfaces i WHERE EXISTS (SELECT 1 FROM places p WHERE p.iface = i.id) ORDER BY i.id')
    .all()
    .map((row) => text(row.id))
    .filter((id): id is string => id !== null);
}

/** The reads of a framed request over the memory while it is open; each gives nothing while it is closed. */
export type FrameReads = {
  mind(ctx: Context, seeds: Seeds, now: number): Mind;
  ownLines(ctx: Context, exceptPlace: string | null, limit: number): Array<FrameLine & PlacePath>;
  around(ctx: Context, placeId: string, at: number, count: number): Array<FrameLine>;
  /** The first `count` lines of a place at or after a moment, oldest first (linesSinceOf). */
  since?(ctx: Context, placeId: string, from: number, count: number): Array<FrameLine>;
  /** The stored name of an account by its platform id, its interface first, then any (accountNameOf). */
  accountName?(iface: string, native: string): string | null;
  line(ctx: Context, key: string): IdentityLine | null;
  /** Whether the line of the message a source row holds is gone (sourceRetiredOf). */
  sourceRetired?(ctx: Context, sourceId: string): boolean;
  placeFields(ctx: Context, placeId: string): Record<string, string>;
  /** The description versions `placeFields` renders (placeVersionsOf). */
  placeVersions?(ctx: Context, placeId: string): Array<string>;
  interfaceNames(iface: string): { name: string | null; nouns: Record<string, string> };
  /** The ids of the interfaces she runs on (interfaceIdsOf). */
  interfaceIds?(): Array<string>;
  account(iface: string, native: string): string | null;
  /** What a member's handle is cut from, by their platform id (memberKeyOf); null when no account row holds it. */
  memberKey?(iface: string, native: string): string | null;
  person(account: string): string | null;
  /** The stored line of an interface's message id, null when none (sourceOfMessage). */
  source?(iface: string, messageId: string): string | null;
  /** The stored line of a message id in a stored place of any interface, null when none (sourceInPlace). */
  sourceInPlace?(placeId: string, messageId: string): string | null;
  /** Her newest `limit` selfreflection entries the context may read, oldest first (readSelfreflection). */
  selfreflection?(ctx: Context, limit: number): Array<PastEntry>;
  /** The live places a name she wrote names under the context, each once with its stored name (names.ts#placesNamed). */
  placesNamed?(ctx: Context, name: string): Array<{ id: string; name: string }>;
  /** The places the memory graph ranks for words she wrote, best first (graph-find.ts#placesFound, `context.find`). */
  placesFound?(ctx: Context, words: string, meaning?: FindMeaning): Array<FoundPlace>;
  /** The people the memory graph ranks for words she wrote, best first (graph-find.ts#peopleFound, `context.find`). */
  peopleFound?(ctx: Context, words: string, meaning?: FindMeaning): Array<FoundPerson>;
  /** The direct chats of the person a reference names, newest first, or the people its words fit (direct-chats.ts). */
  directChats?(ctx: Context, reference: string, meaning?: FindMeaning): DirectChats;
  /** The described media of stored lines of a place by platform reference (mediaTextsOf). */
  mediaTexts?(ctx: Context, placeId: string, messageIds: ReadonlyArray<string>): Map<string, string>;
  /** Whether the context reads a stored place (placeReadableOf). */
  placeReadable?(ctx: Context, placeId: string): boolean;
  /** Every stored channel and thread with its native id (chatPlacesOf). */
  chatPlaces?(): Array<{ id: string; nativeId: string | null }>;
  /** A stored place as its interface knows it, null without a row (placeRefOf). */
  placeRef?(placeId: string): PlaceRef | null;
  /** A stored place's path by names and a direct chat's partner, null without a row (placeViewOf). */
  placeView?(placeId: string): PlacePath | null;
  /** The stored name of a place, null for a one-to-one chat (placeNameOf). */
  placeName?(placeId: string): string | null;
  /** The owner's account on the interface of a stored place, by `bot.ownerPerson` (person-links.ts#ownerAccountOf). */
  ownerAccount?(placeId: string): string | null;
  /** The one thing memory.read's words name under the context, standing in `here` (subject.ts#subjectOf). */
  subject?(ctx: Context, words: string, here: SubjectHere): Subject;
  /** Her attitude changes toward one person the context reads, newest first (affinity-changes.ts#affinityChangesOf). */
  affinityChanges?(ctx: Context, personId: string, limit: number): Array<AffinityChange>;
};

const NO_MIND: Mind = {
  people: [],
  places: [],
  interfaces: [],
  lore: [],
  recent: [],
  found: [],
  leftOut: {},
  reads: [],
};

/** The reads over the connection `dbOf` gives at the moment of use, `context.memory` read from `configOf` then too. */
export function frameReadsOver(dbOf: () => Db | null, configOf: () => unknown): FrameReads {
  const over = <T>(empty: T, read: (db: Db) => T): T => {
    const db = dbOf();
    return db === null ? empty : read(db);
  };
  return {
    mind: (ctx, seeds, now) => over(NO_MIND, (db) => mindOf(db, ctx, seeds, mindSettingsOf(configOf()), now)),
    ownLines: (ctx, exceptPlace, limit) => over([], (db) => ownLinesOf(db, ctx, exceptPlace, limit)),
    around: (ctx, placeId, at, count) => over([], (db) => linesAroundOf(db, ctx, placeId, at, count)),
    since: (ctx, placeId, from, count) => over([], (db) => linesSinceOf(db, ctx, placeId, from, count)),
    accountName: (iface, native) => over(null, (db) => accountNameOf(db, iface, native)),
    line: (ctx, key) => over(null, (db) => lineOfIdentity(db, ctx, key)),
    sourceRetired: (ctx, sourceId) => over(true, (db) => sourceRetiredOf(db, ctx, sourceId)),
    placeFields: (ctx, placeId) => over({}, (db) => placeFieldsOf(db, ctx, placeId)),
    placeVersions: (ctx, placeId) => over([], (db) => placeVersionsOf(db, ctx, placeId)),
    interfaceNames: (iface) => over({ name: null, nouns: {} }, (db) => interfaceNamesOf(db, iface)),
    interfaceIds: () => over([], (db) => interfaceIdsOf(db)),
    account: (iface, native) => over(null, (db) => accountOfNative(db, iface, native)),
    memberKey: (iface, native) => over(null, (db) => memberKeyOf(db, iface, native)),
    person: (account) => over(null, (db) => personOfAccount(db, account)),
    source: (iface, messageId) => over(null, (db) => sourceOfMessage(db, iface, messageId)),
    sourceInPlace: (placeId, messageId) => over(null, (db) => sourceInPlace(db, placeId, messageId)),
    selfreflection: (ctx, limit) => over([], (db) => readSelfreflection(db, ctx, limit)),
    placesNamed: (ctx, name) => over([], (db) => placesNamed(db, ctx, name)),
    placesFound: (ctx, words, meaning) =>
      over([], (db) => placesFound(db, ctx, words, findSettingsOf(configOf()), meaning)),
    peopleFound: (ctx, words, meaning) =>
      over([], (db) => peopleFound(db, ctx, words, findSettingsOf(configOf()), meaning)),
    directChats: (ctx, reference, meaning) =>
      over<DirectChats>({ kind: 'none' }, (db) =>
        directChatsOf(db, ctx, reference, findSettingsOf(configOf()), meaning)
      ),
    mediaTexts: (ctx, placeId, messageIds) => over(new Map(), (db) => mediaTextsOf(db, ctx, placeId, messageIds)),
    placeReadable: (ctx, placeId) => over(false, (db) => placeReadableOf(db, ctx, placeId)),
    chatPlaces: () => over([], (db) => chatPlacesOf(db)),
    placeRef: (placeId) => over(null, (db) => placeRefOf(db, placeId)),
    placeView: (placeId) => over(null, (db) => placeViewOf(db, placeId)),
    placeName: (placeId) => over(null, (db) => placeNameOf(db, placeId)),
    ownerAccount: (placeId) => over(null, (db) => ownerAccountOfPlace(db, configOf(), placeId)),
    subject: (ctx, words, here) => over<Subject>({ kind: 'none' }, (db) => subjectOf(db, ctx, words, here)),
    affinityChanges: (ctx, personId, limit) => over([], (db) => affinityChangesOf(db, ctx, { personId, limit })),
  };
}
