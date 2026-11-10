// The owner's reader of places to any stored depth. A server and its channels are one case of a general tree: several roots,
// equal native keys under different authorities, orphans whose parent is missing, cycles an old database may hold, and
// continuation links, which are not containment. The context decides before anything is counted: a DM place outside its
// audiences is neither listed nor counted. Reading writes nothing. src/interface/commands/memory.ts answers `/memory places`.

import { versionsNaming } from './entities-read.ts';
import { checkLimit, contextBinding, keysetPage, positionOf } from './read-page.ts';
import type { Page } from './read-page.ts';
import { audienceWhere } from './scope.ts';
import type { Context } from './scope.ts';
import type { Db, Row } from './types.ts';

export type PlaceListing = {
  id: string;
  interfaceId: string | null;
  authorityId: string | null;
  nativeKey: string | null;
  generation: number | null;
  kind: string | null;
  chat: string | null;
  name: string | null;
  parentId: string | null;
  parentState: 'none' | 'stored' | 'missing';
  continuesPlaceId: string | null;
  childCount: number;
  retiredAt: string | null;
};
export type PlaceDescription = {
  id: string;
  field: string | null;
  text: string | null;
  audienceId: string | null;
  placeId: string;
};
export type PlaceRecord = { table: string; id: string };
export type PlaceDetail =
  | {
      found: true;
      place: PlaceListing;
      descriptions: Array<PlaceDescription>;
      descendants: Array<PlaceListing & { depth: number }>;
      cycles: Array<{ from: string; to: string }>;
      continuations: Array<string>;
      records: Array<PlaceRecord>;
    }
  | { found: false; code: 'PLACE_NOT_FOUND' };
export type PlaceFilters = { interfaceId: string | null; authorityId: string | null; rootsOnly: boolean };

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The SQL that says a place (`alias`) may be read in `context`: anything but a DM, or a DM among its audiences. */
export function placeVisibleWhere(context: Context, alias: string): { sql: string; params: Array<string> } {
  const dm = audienceWhere(context, 'seen');
  if (context.internal === true) return { sql: '1 = 1', params: [] };
  return {
    sql: `((${alias}.kind <> 'dm' AND ${alias}.chat IS NOT 'dm') OR EXISTS
      (SELECT 1 FROM (SELECT 'aud:dm:' || ${alias}.id AS audience_id) seen WHERE ${dm.sql}))`,
    params: dm.params,
  };
}

function listingColumns(context: Context): { sql: string; params: Array<string> } {
  const child = placeVisibleWhere(context, 'child');
  return {
    sql: `p.*, (SELECT COUNT(*) FROM places child WHERE child.parent_id = p.id AND ${child.sql}) AS child_count,
      EXISTS (SELECT 1 FROM places up WHERE up.id = p.parent_id) AS parent_stored`,
    params: child.params,
  };
}

function listingOf(row: Row): PlaceListing {
  const parentId = textOrNull(row.parent_id);
  return {
    id: String(row.id),
    interfaceId: textOrNull(row.iface),
    authorityId: textOrNull(row.authority_id),
    nativeKey: textOrNull(row.native_key) ?? textOrNull(row.native_id),
    generation: typeof row.generation === 'number' ? row.generation : null,
    kind: textOrNull(row.kind),
    chat: textOrNull(row.chat),
    name: textOrNull(row.name),
    parentId,
    parentState: parentId === null ? 'none' : row.parent_stored === 1 ? 'stored' : 'missing',
    continuesPlaceId: textOrNull(row.continues_place_id),
    childCount: Number(row.child_count),
    retiredAt: textOrNull(row.retired_at),
  };
}

/** A page of the places `where` selects, read with its columns, ordered by id. */
function pageOf(
  db: Db,
  context: Context,
  where: { sql: string; params: ReadonlyArray<unknown> },
  limit: number,
  position: unknown,
  binding: unknown
): Page<PlaceListing> {
  const columns = listingColumns(context);
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM places p WHERE ${where.sql}`).get(...where.params)?.n);
  const after = typeof position === 'string' ? 'AND p.id > ?' : '';
  const rows = db
    .prepare(`SELECT ${columns.sql} FROM places p WHERE ${where.sql} ${after} ORDER BY p.id LIMIT ?`)
    .all(...columns.params, ...where.params, ...(after === '' ? [] : [position]), limit + 1);
  return keysetPage(rows.map(listingOf), limit, total, binding, (item) => item.id);
}

/** Every place of the filters; the ones a context may not read are neither listed nor counted. */
export function listPlaces(
  db: Db,
  request: { context: Context; filters: PlaceFilters; limit: number; cursor: string | null }
): Page<PlaceListing> {
  const { context, filters } = request;
  const binding = { reader: 'places.list', context: contextBinding(context), filters };
  const position = positionOf(request.cursor, binding);
  const limit = checkLimit(request.limit);
  const visible = placeVisibleWhere(context, 'p');
  const parts = [visible.sql];
  const params: Array<unknown> = [...visible.params];
  if (filters.interfaceId !== null) {
    parts.push('p.iface = ?');
    params.push(filters.interfaceId);
  }
  if (filters.authorityId !== null) {
    parts.push('p.authority_id = ?');
    params.push(filters.authorityId);
  }
  // A root has no stored parent: an orphan is one, and a cycle is reached through `tree` from any of its places.
  if (filters.rootsOnly)
    parts.push('(p.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM places up WHERE up.id = p.parent_id))');
  return pageOf(db, context, { sql: parts.join(' AND '), params }, limit, position, binding);
}

const placeExists = (db: Db, placeId: string): boolean =>
  db.prepare('SELECT 1 AS ok FROM places WHERE id = ?').get(placeId) !== undefined;

function listingById(db: Db, context: Context, placeId: string): PlaceListing | null {
  const columns = listingColumns(context);
  const row = db.prepare(`SELECT ${columns.sql} FROM places p WHERE p.id = ?`).get(...columns.params, placeId);
  return row === undefined ? null : listingOf(row);
}

/** Every place under `root`, breadth first, each once. A parent link back to a place already seen is reported, not followed. */
function descendantsOf(
  db: Db,
  context: Context,
  root: string
): { descendants: Array<PlaceListing & { depth: number }>; cycles: Array<{ from: string; to: string }> } {
  const columns = listingColumns(context);
  const visible = placeVisibleWhere(context, 'p');
  const children = db.prepare(
    `SELECT ${columns.sql} FROM places p WHERE p.parent_id = ? AND ${visible.sql} ORDER BY p.id`
  );
  const seen = new Set([root]);
  const descendants: Array<PlaceListing & { depth: number }> = [];
  const cycles: Array<{ from: string; to: string }> = [];
  const queue: Array<{ id: string; depth: number }> = [{ id: root, depth: 0 }];
  for (const at of queue) {
    for (const row of children.all(...columns.params, at.id, ...visible.params)) {
      const child = listingOf(row);
      if (seen.has(child.id)) {
        cycles.push({ from: at.id, to: child.id });
        continue;
      }
      seen.add(child.id);
      descendants.push({ ...child, depth: at.depth + 1 });
      queue.push({ id: child.id, depth: at.depth + 1 });
    }
  }
  return { descendants, cycles };
}

function descriptionsOf(db: Db, context: Context, placeIds: ReadonlyArray<string>): Array<PlaceDescription> {
  if (placeIds.length === 0) return [];
  const audience = audienceWhere(context, 'd');
  return db
    .prepare(
      `SELECT d.id, d.field, d.subject_id, d.audience_id, v.text FROM descriptions d
       LEFT JOIN description_versions v ON v.id = d.current_version
       WHERE d.subject_kind = 'place' AND d.subject_id IN (${placeIds.map(() => '?').join(', ')}) AND ${audience.sql}
       ORDER BY d.subject_id, d.id`
    )
    .all(...placeIds, ...audience.params)
    .map((row) => ({
      id: String(row.id),
      field: textOrNull(row.field),
      text: textOrNull(row.text),
      audienceId: textOrNull(row.audience_id),
      placeId: String(row.subject_id),
    }));
}

/** The exact records of a place by id: its lines and episodes, the claims about it and the semantic versions held in it. */
function recordsOf(db: Db, context: Context, placeId: string): Array<PlaceRecord> {
  const audience = audienceWhere(context, 't');
  const read = (table: string, where: string): Array<PlaceRecord> =>
    db
      .prepare(`SELECT t.id FROM ${table} t WHERE ${where} AND ${audience.sql} ORDER BY t.id`)
      .all(placeId, ...audience.params)
      .map((row) => ({ table, id: String(row.id) }));
  const members =
    context.internal === true
      ? db
          .prepare('SELECT id FROM memberships WHERE place_id = ? ORDER BY id')
          .all(placeId)
          .map((row) => ({ table: 'memberships', id: String(row.id) }))
      : [];
  return [
    ...read('sources', 't.place_id = ?'),
    ...read('claims', "t.subject_kind = 'place' AND t.subject_id = ?"),
    ...read('episodes', 't.place_id = ?'),
    ...versionsNaming(db, context, { kind: 'place', ids: [placeId] }).map(({ versionId }) => ({
      table: 'semantic_assertion_versions',
      id: versionId,
    })),
    ...members,
  ];
}

/** A place with its descriptions, its exact records and, on request, every descendant and their descriptions. */
export function placeDetail(
  db: Db,
  placeId: string,
  request: { context: Context; includeChildren: boolean }
): PlaceDetail {
  const { context, includeChildren } = request;
  contextBinding(context);
  const place = listingById(db, context, placeId);
  if (place === null) return { found: false, code: 'PLACE_NOT_FOUND' };
  const { descendants, cycles } = includeChildren
    ? descendantsOf(db, context, placeId)
    : { descendants: [], cycles: [] };
  const visible = placeVisibleWhere(context, 'p');
  const continuations = db
    .prepare(`SELECT p.id FROM places p WHERE p.continues_place_id = ? AND ${visible.sql} ORDER BY p.id`)
    .all(placeId, ...visible.params)
    .map((row) => String(row.id));
  return {
    found: true,
    place,
    descriptions: descriptionsOf(db, context, [placeId, ...descendants.map((one) => one.id)]),
    descendants,
    cycles,
    continuations,
    records: recordsOf(db, context, placeId),
  };
}

/** The lore of a place by id, retired entries included. */
export function placeLore(
  db: Db,
  placeId: string,
  context: Context
): { found: true; placeId: string; records: Array<PlaceRecord> } | { found: false; code: 'PLACE_NOT_FOUND' } {
  contextBinding(context);
  if (!placeExists(db, placeId)) return { found: false, code: 'PLACE_NOT_FOUND' };
  const audience = audienceWhere(context, 't');
  const records = db
    .prepare(
      `SELECT t.id FROM claims t WHERE t.subject_kind = 'place' AND t.subject_id = ? AND t.kind = 'lore'
       AND ${audience.sql} ORDER BY t.id`
    )
    .all(placeId, ...audience.params)
    .map((row) => ({ table: 'claims', id: String(row.id) }));
  return { found: true, placeId, records };
}
