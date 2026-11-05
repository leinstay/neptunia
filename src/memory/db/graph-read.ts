// Complete navigation of the memory graph for the owner. Inventories reach every node and edge exactly once across pages,
// isolated nodes and placeholders included. A walk visits each node once whatever the number of paths, so a dense or cyclic
// graph cannot exhaust it, and a depth or node bound leaves a frontier and a cursor to go on from. The projection's edges are
// what is shown: a typed relation it does not carry stays readable through `/memory inspect`, and no history is invented. A
// path is read and never remembered. Reading writes nothing, `node_access` included. The context filters edges before any
// count or traversal, so a group walk cannot pass through a private edge. graph.ts#walk stays the persona's bounded
// path-limited read; this reader answers `/memory graph` (src/interface/commands/memory.ts).

import { DEFERRED, NODE_KINDS, PREDICATES } from './graph-manifest.ts';
import type { NodeKindSpec } from './graph-manifest.ts';
import { checkLimit, coded, contextBinding, cursorOf, keysetPage, positionOf } from './read-page.ts';
import type { Page } from './read-page.ts';
import { audienceWhere } from './scope.ts';
import type { Context } from './scope.ts';
import type { Db, Row } from './types.ts';

export type GraphEdgeRequest = {
  predicates: Array<string> | null;
  mode: 'active' | 'historical';
  validAt: string | null;
  recordedBefore: string | null;
};
export type GraphDirection = 'in' | 'out' | 'both';
export type GraphNodeRecord = { id: string; kind: string; rowId: string; createdAt: string | null };
export type GraphEdgeRecord = {
  id: string;
  src: string;
  dst: string;
  predicate: string;
  audienceId: string | null;
  evidenceId: string | null;
  validFromAt: string | null;
  validToAt: string | null;
  recordedAt: string | null;
  retiredAt: string | null;
};
export type GraphKinds = {
  kinds: Array<{
    kind: string;
    table: string | null;
    state: 'implemented' | 'deferred';
    reason: string | null;
    nodes: number;
  }>;
  predicates: Array<{
    predicate: string;
    table: string | null;
    state: 'implemented' | 'deferred';
    reason: string | null;
    live: number;
    retired: number;
  }>;
};
export type GraphNodeDetail =
  | {
      found: true;
      node: GraphNodeRecord;
      row: Row | null;
      rowState: 'live' | 'retired' | 'missing';
      witnesses: Array<{ audienceId: string; evidenceId: string | null }>;
      incoming: number;
      outgoing: number;
    }
  | { found: false; code: 'NODE_NOT_FOUND' };
export type GraphWalkPage = {
  visited: Array<{ node: string; kind: string; rowId: string; depth: number }>;
  edges: Array<GraphEdgeRecord>;
  frontier: Array<string>;
  next: string | null;
  truncated: boolean;
  reason: 'page' | 'depth' | null;
};
export type GraphPathResult =
  | { found: true; edges: Array<GraphEdgeRecord>; nodes: Array<string>; versionIds: Array<string> }
  | { found: false; reason: 'none' | 'depth' | 'work'; explored: number };

/** The most nodes one path search explores: past this it answers `work` and never claims there is no path. */
const PATH_WORK_NODES = 200_000;
/** The node kinds that name one exact version of a record. */
const VERSION_KINDS: ReadonlySet<string> = new Set(['claim_version', 'description_version']);

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const marks = (values: ReadonlyArray<unknown>): string => values.map(() => '?').join(', ');

const nodeOf = (row: Row): GraphNodeRecord => ({
  id: String(row.id),
  kind: String(row.kind),
  rowId: String(row.row_id),
  createdAt: textOrNull(row.created_at),
});
const edgeOf = (row: Row): GraphEdgeRecord => ({
  id: String(row.id),
  src: String(row.src),
  dst: String(row.dst),
  predicate: String(row.predicate),
  audienceId: textOrNull(row.audience_id),
  evidenceId: textOrNull(row.evidence_id),
  validFromAt: textOrNull(row.valid_from_at),
  validToAt: textOrNull(row.valid_to_at),
  recordedAt: textOrNull(row.recorded_at),
  retiredAt: textOrNull(row.retired_at),
});

/** The conditions of an edge request on `graph_edges e`, the context's audience first. */
function edgeWhere(context: Context, request: GraphEdgeRequest): { sql: string; params: Array<unknown> } {
  const audience = audienceWhere(context, 'e');
  const parts = [audience.sql];
  const params: Array<unknown> = [...audience.params];
  if (request.mode === 'active') parts.push('e.retired_at IS NULL');
  if (request.predicates !== null) {
    parts.push(`e.predicate IN (${marks(request.predicates)})`);
    params.push(...request.predicates);
  }
  if (request.validAt !== null) {
    parts.push('(e.valid_from_at IS NULL OR e.valid_from_at <= ?) AND (e.valid_to_at IS NULL OR e.valid_to_at > ?)');
    params.push(request.validAt, request.validAt);
  }
  if (request.recordedBefore !== null) {
    parts.push('e.recorded_at < ?');
    params.push(request.recordedBefore);
  }
  return { sql: parts.join(' AND '), params };
}

/** The condition that a context has a witness for the node `n`. */
function nodeVisible(context: Context): { sql: string; params: Array<string> } {
  if (context.internal === true) return { sql: '1 = 1', params: [] };
  const audience = audienceWhere(context, 'w');
  return {
    sql: `EXISTS (SELECT 1 FROM node_access w WHERE w.node_id = n.id AND ${audience.sql})`,
    params: audience.params,
  };
}

const edgeBinding = (request: GraphEdgeRequest): unknown => ({
  predicates: request.predicates,
  mode: request.mode,
  validAt: request.validAt,
  recordedBefore: request.recordedBefore,
});

const specOfPredicate = (predicate: string): { table: string | null; deferred?: string } =>
  (PREDICATES as Readonly<Record<string, { table: string | null; deferred?: string }>>)[predicate] ?? { table: null };

/** Every kind and predicate of the manifest with what the context may count of it, the deferred ones named as deferred. */
export function graphKinds(db: Db, context: Context): GraphKinds {
  contextBinding(context);
  const visible = nodeVisible(context);
  const counts = new Map(
    db
      .prepare(`SELECT n.kind, COUNT(*) AS c FROM graph_nodes n WHERE ${visible.sql} GROUP BY n.kind`)
      .all(...visible.params)
      .map((row) => [String(row.kind), Number(row.c)])
  );
  const audience = audienceWhere(context, 'e');
  const edges = new Map(
    db
      .prepare(
        `SELECT e.predicate, SUM(e.retired_at IS NULL) AS live, SUM(e.retired_at IS NOT NULL) AS retired
         FROM graph_edges e WHERE ${audience.sql} GROUP BY e.predicate`
      )
      .all(...audience.params)
      .map((row) => [String(row.predicate), row])
  );
  const deferredKinds: Readonly<Record<string, string>> = DEFERRED;
  return {
    kinds: Object.entries(NODE_KINDS).map(([kind, spec]: [string, NodeKindSpec]) => ({
      kind,
      table: spec.table,
      state: spec.table === null ? ('deferred' as const) : ('implemented' as const),
      reason: spec.table === null ? (spec.deferred ?? deferredKinds[kind] ?? null) : null,
      nodes: counts.get(kind) ?? 0,
    })),
    predicates: Object.keys(PREDICATES).map((predicate) => {
      const spec = specOfPredicate(predicate);
      const row = edges.get(predicate);
      return {
        predicate,
        table: spec.table,
        state: spec.table === null ? ('deferred' as const) : ('implemented' as const),
        reason: spec.table === null ? (spec.deferred ?? null) : null,
        live: Number(row?.live ?? 0),
        retired: Number(row?.retired ?? 0),
      };
    }),
  };
}

/** Every node of the kinds asked, once across pages; one with no edge is a node like any other. */
export function graphNodes(
  db: Db,
  context: Context,
  request: { kinds: Array<string> | null; limit: number; cursor: string | null }
): Page<GraphNodeRecord> {
  const binding = { reader: 'graph.nodes', context: contextBinding(context), kinds: request.kinds };
  const position = positionOf(request.cursor, binding);
  const limit = checkLimit(request.limit);
  const visible = nodeVisible(context);
  const parts = [visible.sql];
  const params: Array<unknown> = [...visible.params];
  if (request.kinds !== null) {
    parts.push(`n.kind IN (${marks(request.kinds)})`);
    params.push(...request.kinds);
  }
  const where = parts.join(' AND ');
  const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM graph_nodes n WHERE ${where}`).get(...params)?.c);
  const after = typeof position === 'string' ? 'AND n.id > ?' : '';
  const rows = db
    .prepare(`SELECT n.* FROM graph_nodes n WHERE ${where} ${after} ORDER BY n.id LIMIT ?`)
    .all(...params, ...(after === '' ? [] : [position]), limit + 1);
  return keysetPage(rows.map(nodeOf), limit, total, binding, (item) => item.id);
}

/** A page of the edges `where` selects. */
function edgePage(
  db: Db,
  where: { sql: string; params: ReadonlyArray<unknown> },
  limit: number,
  position: unknown,
  binding: unknown
): Page<GraphEdgeRecord> {
  const total = Number(
    db.prepare(`SELECT COUNT(*) AS c FROM graph_edges e WHERE ${where.sql}`).get(...where.params)?.c
  );
  const after = typeof position === 'string' ? 'AND e.id > ?' : '';
  const rows = db
    .prepare(`SELECT e.* FROM graph_edges e WHERE ${where.sql} ${after} ORDER BY e.id LIMIT ?`)
    .all(...where.params, ...(after === '' ? [] : [position]), limit + 1);
  return keysetPage(rows.map(edgeOf), limit, total, binding, (item) => item.id);
}

/** Every edge of the request, once across pages; parallel edges stay apart. */
export function graphEdges(
  db: Db,
  context: Context,
  request: GraphEdgeRequest & { limit: number; cursor: string | null }
): Page<GraphEdgeRecord> {
  const binding = { reader: 'graph.edges', context: contextBinding(context), edges: edgeBinding(request) };
  const position = positionOf(request.cursor, binding);
  return edgePage(db, edgeWhere(context, request), checkLimit(request.limit), position, binding);
}

const directionSql = (direction: GraphDirection): string =>
  direction === 'in' ? 'e.dst = ?' : direction === 'out' ? 'e.src = ?' : '(e.src = ? OR e.dst = ?)';
const directionParams = (direction: GraphDirection, node: string): Array<string> =>
  direction === 'both' ? [node, node] : [node];

function nodeRow(db: Db, context: Context, nodeId: string): Row | undefined {
  const visible = nodeVisible(context);
  return db.prepare(`SELECT n.* FROM graph_nodes n WHERE n.id = ? AND ${visible.sql}`).get(nodeId, ...visible.params);
}

/** The edges at one node in the direction asked, a self-loop once. A node the context cannot see is refused. */
export function graphNeighbors(
  db: Db,
  context: Context,
  request: GraphEdgeRequest & { node: string; direction: GraphDirection; limit: number; cursor: string | null }
): Page<GraphEdgeRecord> {
  const binding = {
    reader: 'graph.neighbors',
    context: contextBinding(context),
    edges: edgeBinding(request),
    node: request.node,
    direction: request.direction,
  };
  const position = positionOf(request.cursor, binding);
  const limit = checkLimit(request.limit);
  if (nodeRow(db, context, request.node) === undefined) throw coded('NODE_NOT_FOUND', 'no such node');
  const base = edgeWhere(context, request);
  const where = {
    sql: `${directionSql(request.direction)} AND ${base.sql}`,
    params: [...directionParams(request.direction, request.node), ...base.params],
  };
  return edgePage(db, where, limit, position, binding);
}

/** The typed row behind a node, with the state a placeholder and a retired row differ by. */
function backingRow(
  db: Db,
  context: Context,
  kind: string,
  rowId: string
): { row: Row | null; rowState: 'live' | 'retired' | 'missing' } {
  const spec = NODE_KINDS[kind];
  if (spec?.table === null || spec?.table === undefined || spec.key === undefined)
    return { row: null, rowState: 'missing' };
  const found = db.prepare(`SELECT * FROM ${spec.table} WHERE ${spec.key} = ?`).get(rowId);
  if (found === undefined) return { row: null, rowState: 'missing' };
  if (typeof found.audience_id === 'string' && context.internal !== true) {
    const audience = audienceWhere(context, 'seen');
    const readable = db
      .prepare(`SELECT 1 AS ok FROM (SELECT ? AS audience_id) seen WHERE ${audience.sql}`)
      .get(found.audience_id, ...audience.params);
    if (readable === undefined) return { row: null, rowState: 'missing' };
  }
  const retired = spec.retired === undefined ? null : found[spec.retired];
  return { row: { ...found }, rowState: retired === null || retired === undefined ? 'live' : 'retired' };
}

/** One node with its typed row, the witnesses the context may read and how many live edges meet it. */
export function graphNode(db: Db, context: Context, nodeId: string): GraphNodeDetail {
  contextBinding(context);
  const row = nodeRow(db, context, nodeId);
  if (row === undefined) return { found: false, code: 'NODE_NOT_FOUND' };
  const node = nodeOf(row);
  const witness = audienceWhere(context, 'w');
  const witnesses = db
    .prepare(`SELECT w.audience_id, w.evidence_id FROM node_access w WHERE w.node_id = ? AND ${witness.sql}`)
    .all(nodeId, ...witness.params)
    .map((one) => ({ audienceId: String(one.audience_id), evidenceId: textOrNull(one.evidence_id) }));
  const live = edgeWhere(context, { predicates: null, mode: 'active', validAt: null, recordedBefore: null });
  const count = (column: 'src' | 'dst'): number =>
    Number(
      db
        .prepare(`SELECT COUNT(*) AS c FROM graph_edges e WHERE e.${column} = ? AND ${live.sql}`)
        .get(nodeId, ...live.params)?.c
    );
  return {
    found: true,
    node,
    ...backingRow(db, context, node.kind, node.rowId),
    witnesses,
    incoming: count('dst'),
    outgoing: count('src'),
  };
}

function checkBound(value: unknown, least: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < least)
    throw coded('INSPECTION_BAD_LIMIT', 'a walk bound is a whole number and never absent');
  return value;
}

/** The edges one step can follow from a node, in a stable order, the request's filters already applied. */
function stepper(
  db: Db,
  context: Context,
  request: GraphEdgeRequest,
  direction: GraphDirection
): (node: string) => Array<GraphEdgeRecord> {
  const base = edgeWhere(context, request);
  const statement = db.prepare(
    `SELECT e.* FROM graph_edges e WHERE ${directionSql(direction)} AND ${base.sql} ORDER BY e.id`
  );
  return (node) => statement.all(...directionParams(direction, node), ...base.params).map(edgeOf);
}

/** The node an edge leads to from `node`, in the direction walked. */
function otherEnd(edge: GraphEdgeRecord, node: string, direction: GraphDirection): string {
  if (direction === 'out') return edge.dst;
  if (direction === 'in') return edge.src;
  return edge.src === node ? edge.dst : edge.src;
}

/** The stored starts of a walk the context may see, each once. */
function walkStarts(db: Db, context: Context, from: ReadonlyArray<string>): Array<{ id: string; depth: number }> {
  return [...new Set(from)].filter((node) => nodeRow(db, context, node) !== undefined).map((id) => ({ id, depth: 0 }));
}

function visitOf(db: Db, context: Context, at: { id: string; depth: number }): GraphWalkPage['visited'][number] {
  const row = nodeRow(db, context, at.id);
  const node = row === undefined ? null : nodeOf(row);
  return { node: at.id, kind: node?.kind ?? '', rowId: node?.rowId ?? '', depth: at.depth };
}

/**
 * A breadth-first walk, by nodes and never by paths. It is the same walk at every page, in a stable order, so a cursor is only
 * how many nodes were answered: it needs no stored state and stays small. An edge belongs to the page of the node it was
 * first followed from. A node at the depth bound with an edge not followed yet is frontier: a walk from it goes on.
 */
export function graphWalk(
  db: Db,
  context: Context,
  request: GraphEdgeRequest & {
    from: Array<string>;
    direction: GraphDirection;
    maxDepth: number;
    maxNodes: number;
    cursor: string | null;
  }
): GraphWalkPage {
  const { from, direction } = request;
  const binding = {
    reader: 'graph.walk',
    context: contextBinding(context),
    edges: edgeBinding(request),
    from,
    direction,
    maxDepth: request.maxDepth,
    maxNodes: request.maxNodes,
  };
  const position = positionOf(request.cursor, binding);
  const maxDepth = checkBound(request.maxDepth, 0);
  const maxNodes = checkBound(request.maxNodes, 1);
  const start = typeof position === 'number' ? position : 0;
  const step = stepper(db, context, request, direction);
  const queue = walkStarts(db, context, from);
  const seen = new Set(queue.map((one) => one.id));
  const followed = new Set<string>();
  const page: GraphWalkPage = { visited: [], edges: [], frontier: [], next: null, truncated: false, reason: null };
  let index = 0;
  for (; index < queue.length && index < start + maxNodes; index += 1) {
    const at = queue[index];
    if (at === undefined) break;
    const inPage = index >= start;
    if (inPage) page.visited.push(visitOf(db, context, at));
    const fresh = step(at.id).filter((edge) => !followed.has(edge.id));
    if (at.depth >= maxDepth) {
      if (inPage && fresh.length > 0) page.frontier.push(at.id);
      continue;
    }
    for (const edge of fresh) {
      followed.add(edge.id);
      if (inPage) page.edges.push(edge);
      const next = otherEnd(edge, at.id, direction);
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push({ id: next, depth: at.depth + 1 });
    }
  }
  page.next = index < queue.length ? cursorOf(binding, index) : null;
  page.truncated = page.next !== null || page.frontier.length > 0;
  page.reason = page.next !== null ? 'page' : page.frontier.length > 0 ? 'depth' : null;
  return page;
}

/** The nodes and edges of a found path, from the predecessors a search left. */
function pathFrom(
  db: Db,
  request: { from: string; to: string },
  came: ReadonlyMap<string, { edge: GraphEdgeRecord; node: string }>
): Extract<GraphPathResult, { found: true }> {
  const edges: Array<GraphEdgeRecord> = [];
  const nodes = [request.to];
  for (let at = request.to; at !== request.from;) {
    const step = came.get(at);
    if (step === undefined) break;
    edges.unshift(step.edge);
    nodes.unshift(step.node);
    at = step.node;
  }
  const rows = db.prepare(`SELECT kind, row_id FROM graph_nodes WHERE id IN (${marks(nodes)})`).all(...nodes);
  const versionIds = rows.filter((row) => VERSION_KINDS.has(String(row.kind))).map((row) => String(row.row_id));
  return { found: true, edges, nodes, versionIds };
}

/** The shortest association path over what the context may read, each node explored once. It is an answer and never a memory. */
export function graphPath(
  db: Db,
  context: Context,
  request: GraphEdgeRequest & { from: string; to: string; direction: GraphDirection; maxDepth: number }
): GraphPathResult {
  contextBinding(context);
  const maxDepth = checkBound(request.maxDepth, 0);
  const { from, to, direction } = request;
  if (nodeRow(db, context, from) === undefined || nodeRow(db, context, to) === undefined)
    return { found: false, reason: 'none', explored: 0 };
  const step = stepper(db, context, request, direction);
  const came = new Map<string, { edge: GraphEdgeRecord; node: string }>();
  const seen = new Set([from]);
  const queue = [{ id: from, depth: 0 }];
  let bounded = false;
  for (const at of queue) {
    if (at.id === to) return pathFrom(db, { from, to }, came);
    if (seen.size > PATH_WORK_NODES) return { found: false, reason: 'work', explored: seen.size };
    const edges = step(at.id);
    if (at.depth >= maxDepth) {
      bounded ||= edges.some((edge) => !seen.has(otherEnd(edge, at.id, direction)));
      continue;
    }
    for (const edge of edges) {
      const next = otherEnd(edge, at.id, direction);
      if (seen.has(next)) continue;
      seen.add(next);
      came.set(next, { edge, node: at.id });
      queue.push({ id: next, depth: at.depth + 1 });
    }
  }
  return { found: false, reason: bounded ? 'depth' : 'none', explored: seen.size };
}
