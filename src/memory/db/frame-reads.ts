// The reads of a request built on the turn frame beside the graph reader (src/memory/db/mind-read.ts): her own last
// lines in other places and the lines around one line for `<meanwhile>`, one stored line by its identity for a
// reference in a stored text, the stored fields of a place for `<surroundings>`, an interface's name and nouns and her
// past selfreflection entries for a selfreflection request's `<selfreflection>`. Each
// read applies the turn's context (`whereFor`), so nothing a scope may not read leaves here. Read only.

import { nativeOfAny } from './ids.ts';
import { findSettingsOf, peopleFound, placesFound } from './graph-find.ts';
import type { FoundPerson, FoundPlace } from './graph-find.ts';
import { mindOf, mindSettingsOf } from './mind-read.ts';
import type { Mind, Seeds } from './mind-read.ts';
import { interfaceNouns, placesNamed } from './names.ts';
import { placeChainInDb } from './place-tree.ts';
import { allowedAudience, whereFor } from './scope.ts';
import { placeAudience } from './graph.ts';
import { readSelfreflection } from './selfreflection-past.ts';
import type { PastEntry } from './selfreflection-past.ts';
import type { Context } from './scope.ts';
import type { Db, Row } from './types.ts';

/**
 * A stored chat line as a request reads it: the platform's message id, its place, epoch ms, the author's platform id
 * and stored name.
 */
export type FrameLine = {
  id: string;
  placeId: string;
  at: number;
  authorId: string | null;
  /** The first name of the author's person, from the account that holds the person's profile, else the account's own. */
  authorName: string | null;
  self: boolean;
  text: string;
};

/** The word a path takes for a one-to-one chat, between the interface and the partner's id. A path segment, no label. */
const DM_WORD = 'private';

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** Where a line stands: its place's path, whether that place is a one-to-one chat, and that chat's partner person. */
export type PlacePath = { path: Array<string>; dm: boolean; partner: string | null };

/** A place by names from its interface down; a one-to-one chat's ends in the partner's platform id. */
export function placePathOf(db: Db, placeId: string): PlacePath {
  const chain = placeChainInDb(db, placeId);
  const iface = placeId.slice(0, Math.max(0, placeId.indexOf(':')));
  const here = chain[0];
  if (here?.kind === 'dm') {
    const row = db.prepare('SELECT partner_person FROM places WHERE id = ?').get(placeId);
    const partner = text(row?.partner_person);
    return { path: [iface, DM_WORD, nativeOfAny(placeId) ?? placeId], dm: true, partner };
  }
  const names = chain.map((link) => link.name ?? link.id).reverse();
  return { path: [iface, ...(names.length > 0 ? names : [placeId])], dm: false, partner: null };
}

const lineOf = (row: Row): FrameLine => ({
  id: String(row.native_id ?? row.id),
  placeId: text(row.place_id) ?? '',
  at: Date.parse(text(row.occurred_at) ?? ''),
  authorId: text(row.author_account) === null ? null : nativeOfAny(row.author_account),
  authorName: text(row.author_name),
  self: row.author_kind === 'self',
  text: text(row.text) ?? '',
});

/** The first stored name of a line's author: its person's profile account's, else its own account's. */
const AUTHOR_NAME = `COALESCE(
  (SELECT json_extract(pa.names, '$[0]') FROM accounts a JOIN people p ON p.id = a.person_id
     JOIN storage_units u ON u.id = p.owner_key JOIN accounts pa ON pa.id = u.subject_id
   WHERE a.id = s.author_account AND u.subject_type = 'account'),
  (SELECT json_extract(a.names, '$[0]') FROM accounts a WHERE a.id = s.author_account)) AS author_name`;
const LINE_COLUMNS = `s.id, s.native_id, s.place_id, s.occurred_at, s.author_account, s.author_kind, s.text, ${AUTHOR_NAME}`;
const LIVE_LINE = `s.kind IN ('seen', 'said') AND s.retired_at IS NULL AND length(COALESCE(s.text, '')) > 0`;

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
      `SELECT ${LINE_COLUMNS} FROM sources s
       WHERE s.author_kind = 'self' AND ${LIVE_LINE} AND s.place_id IS NOT ? AND ${where.sql}
       ORDER BY s.occurred_at DESC, s.revision DESC LIMIT ?`
    )
    .all(exceptPlace, ...where.params, Math.max(0, limit) * 2);
  const seen = new Set<string>();
  const paths = new Map<string, PlacePath>();
  const out: Array<FrameLine & PlacePath> = [];
  for (const row of rows) {
    const line = lineOf(row);
    if (seen.has(`${line.placeId}\u0000${line.id}`) || out.length >= limit) continue;
    seen.add(`${line.placeId}\u0000${line.id}`);
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
        `SELECT ${LINE_COLUMNS} FROM sources s
         WHERE s.place_id = ? AND s.occurred_at ${compare} ? AND ${LIVE_LINE} AND ${where.sql}
         ORDER BY s.occurred_at ${order}, s.revision DESC LIMIT ?`
      )
      .all(placeId, iso, ...where.params, n);
  const before = read('DESC', '<=', count + 1).reverse();
  const after = read('ASC', '>', count);
  const seen = new Set<string>();
  return [...before, ...after].map(lineOf).filter((line) => !seen.has(line.id) && Boolean(seen.add(line.id)));
}

/** Whether the context reads the stored place `placeId`, retired or live: a gone room keeps its read handle. */
export function placeReadableOf(db: Db, ctx: Context, placeId: string): boolean {
  const place = db.prepare('SELECT id, iface, kind, chat FROM places WHERE id = ?').get(placeId);
  return place !== undefined && allowedAudience({ audience_id: placeAudience(place) }, ctx);
}

/** The id of every stored channel and thread of every interface, retired or live: the places a `#handle` may name. */
export function chatPlaceIdsOf(db: Db): Array<string> {
  return db
    .prepare("SELECT id FROM places WHERE kind IN ('channel', 'thread') ORDER BY id")
    .all()
    .flatMap((row) => (typeof row.id === 'string' ? [row.id] : []));
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
      `SELECT ${LINE_COLUMNS}, s.kind, s.revision FROM sources s
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
 * under), else the id itself, newest revision first; null when the memory holds no such line.
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
  if (text(byKey?.id) !== null) return text(byKey?.id);
  const prefix = `src:${iface}:${messageId}:`;
  const byId = db
    .prepare('SELECT id FROM sources WHERE id >= ? AND id < ? AND retired_at IS NULL ORDER BY revision DESC LIMIT 1')
    .get(prefix, `${prefix}\uffff`);
  return text(byId?.id);
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
  line(ctx: Context, key: string): IdentityLine | null;
  placeFields(ctx: Context, placeId: string): Record<string, string>;
  /** The description versions `placeFields` renders (placeVersionsOf). */
  placeVersions?(ctx: Context, placeId: string): Array<string>;
  interfaceNames(iface: string): { name: string | null; nouns: Record<string, string> };
  /** The ids of the interfaces she runs on (interfaceIdsOf). */
  interfaceIds?(): Array<string>;
  account(iface: string, native: string): string | null;
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
  placesFound?(ctx: Context, words: string): Array<FoundPlace>;
  /** The people the memory graph ranks for words she wrote, best first (graph-find.ts#peopleFound, `context.find`). */
  peopleFound?(ctx: Context, words: string): Array<FoundPerson>;
  /** Whether the context reads a stored place (placeReadableOf). */
  placeReadable?(ctx: Context, placeId: string): boolean;
  /** The id of every stored channel and thread (chatPlaceIdsOf). */
  chatPlaceIds?(): Array<string>;
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
    line: (ctx, key) => over(null, (db) => lineOfIdentity(db, ctx, key)),
    placeFields: (ctx, placeId) => over({}, (db) => placeFieldsOf(db, ctx, placeId)),
    placeVersions: (ctx, placeId) => over([], (db) => placeVersionsOf(db, ctx, placeId)),
    interfaceNames: (iface) => over({ name: null, nouns: {} }, (db) => interfaceNamesOf(db, iface)),
    interfaceIds: () => over([], (db) => interfaceIdsOf(db)),
    account: (iface, native) => over(null, (db) => accountOfNative(db, iface, native)),
    person: (account) => over(null, (db) => personOfAccount(db, account)),
    source: (iface, messageId) => over(null, (db) => sourceOfMessage(db, iface, messageId)),
    sourceInPlace: (placeId, messageId) => over(null, (db) => sourceInPlace(db, placeId, messageId)),
    selfreflection: (ctx, limit) => over([], (db) => readSelfreflection(db, ctx, limit)),
    placesNamed: (ctx, name) => over([], (db) => placesNamed(db, ctx, name)),
    placesFound: (ctx, words) => over([], (db) => placesFound(db, ctx, words, findSettingsOf(configOf()))),
    peopleFound: (ctx, words) => over([], (db) => peopleFound(db, ctx, words, findSettingsOf(configOf()))),
    placeReadable: (ctx, placeId) => over(false, (db) => placeReadableOf(db, ctx, placeId)),
    chatPlaceIds: () => over([], (db) => chatPlaceIdsOf(db)),
  };
}
