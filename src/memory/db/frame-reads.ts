// The reads of a request built on the turn frame beside the graph reader (src/memory/db/mind-read.ts): her own last
// lines in other places and the lines around one line for `<meanwhile>`, one stored line by its identity for a
// reference in a stored text, the stored fields of a place for `<surroundings>` and an interface's name and nouns. Each
// read applies the turn's context (`whereFor`), so nothing a scope may not read leaves here. Read only.

import { nativeOfAny } from './ids.ts';
import { mindOf, mindSettingsOf } from './mind-read.ts';
import type { Mind, Seeds } from './mind-read.ts';
import { interfaceNouns } from './names.ts';
import { placeChainInDb, rootPlaceInDb } from './place-tree.ts';
import { whereFor } from './scope.ts';
import type { Context } from './scope.ts';
import type { Db, Row } from './types.ts';

/** A stored chat line as a request reads it: the platform's message id, its place, epoch ms, the author's platform id. */
export type FrameLine = {
  id: string;
  placeId: string;
  at: number;
  authorId: string | null;
  self: boolean;
  text: string;
};

/** The word a path takes for a one-to-one chat, between the interface and the partner's id. A path segment, no label. */
const DM_WORD = 'private';

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** A place by names from its interface down; a one-to-one chat's ends in the partner's platform id. */
export function placePathOf(db: Db, placeId: string): { path: Array<string>; dm: boolean } {
  const chain = placeChainInDb(db, placeId);
  const iface = placeId.slice(0, Math.max(0, placeId.indexOf(':')));
  const here = chain[0];
  if (here?.kind === 'dm') return { path: [iface, DM_WORD, nativeOfAny(placeId) ?? placeId], dm: true };
  const names = chain.map((link) => link.name ?? link.id).reverse();
  return { path: [iface, ...(names.length > 0 ? names : [placeId])], dm: false };
}

const lineOf = (row: Row): FrameLine => ({
  id: String(row.native_id ?? row.id),
  placeId: text(row.place_id) ?? '',
  at: Date.parse(text(row.occurred_at) ?? ''),
  authorId: text(row.author_account) === null ? null : nativeOfAny(row.author_account),
  self: row.author_kind === 'self',
  text: text(row.text) ?? '',
});

const LINE_COLUMNS = 's.id, s.native_id, s.place_id, s.occurred_at, s.author_account, s.author_kind, s.text';
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
): Array<FrameLine & { path: Array<string>; dm: boolean }> {
  const where = whereFor(ctx, 's');
  const rows = db
    .prepare(
      `SELECT ${LINE_COLUMNS} FROM sources s
       WHERE s.author_kind = 'self' AND ${LIVE_LINE} AND s.place_id IS NOT ? AND ${where.sql}
       ORDER BY s.occurred_at DESC, s.revision DESC LIMIT ?`
    )
    .all(exceptPlace, ...where.params, Math.max(0, limit) * 2);
  const seen = new Set<string>();
  const paths = new Map<string, { path: Array<string>; dm: boolean }>();
  const out: Array<FrameLine & { path: Array<string>; dm: boolean }> = [];
  for (const row of rows) {
    const line = lineOf(row);
    if (seen.has(`${line.placeId}\u0000${line.id}`) || out.length >= limit) continue;
    seen.add(`${line.placeId}\u0000${line.id}`);
    if (!paths.has(line.placeId)) paths.set(line.placeId, placePathOf(db, line.placeId));
    out.push({ ...line, ...(paths.get(line.placeId) ?? { path: [], dm: false }) });
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

/** A stored line by its identity without the revision, as a reference names it. */
export type IdentityLine = FrameLine & {
  path: Array<string>;
  revision: number;
  deleted: boolean;
  /** The interface's id of its conversation, null in a one-to-one chat; and of the top place above it, if any. */
  conversationId: string | null;
  communityId: string | null;
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
  const root = rootPlaceInDb(db, placeId);
  return {
    ...lineOf(line),
    path: located.path,
    conversationId: located.dm ? null : nativeOfAny(placeId),
    communityId: located.dm || root === null || root === placeId ? null : nativeOfAny(root),
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

/** The account row of a platform id on an interface, its newest generation first; null when none is stored. */
export function accountOfNative(db: Db, iface: string, native: string): string | null {
  const row = db
    .prepare('SELECT id FROM accounts WHERE iface = ? AND native_id = ? ORDER BY generation DESC')
    .get(iface, native);
  return text(row?.id);
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

/** The reads of a framed request over the memory while it is open; each gives nothing while it is closed. */
export type FrameReads = {
  mind(ctx: Context, seeds: Seeds, now: number): Mind;
  ownLines(
    ctx: Context,
    exceptPlace: string | null,
    limit: number
  ): Array<FrameLine & { path: Array<string>; dm: boolean }>;
  around(ctx: Context, placeId: string, at: number, count: number): Array<FrameLine>;
  line(ctx: Context, key: string): IdentityLine | null;
  placeFields(ctx: Context, placeId: string): Record<string, string>;
  interfaceNames(iface: string): { name: string | null; nouns: Record<string, string> };
  account(iface: string, native: string): string | null;
  person(account: string): string | null;
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
    interfaceNames: (iface) => over({ name: null, nouns: {} }, (db) => interfaceNamesOf(db, iface)),
    account: (iface, native) => over(null, (db) => accountOfNative(db, iface, native)),
    person: (account) => over(null, (db) => personOfAccount(db, account)),
  };
}
