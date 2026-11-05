// src/memory/db/graph-read.ts: complete navigation of the memory graph for the owner. Inventories reach every node and edge
// exactly once across pages, isolated nodes and placeholders included. A walk visits each node once whatever the number of
// paths, so a dense or cyclic graph cannot exhaust it, and a depth or node bound leaves a frontier to go on from. A path is
// read and never remembered. Reading writes nothing, `node_access` included. Plan 2026-11-04-cli-and-memory task 9; S9 reruns
// this navigation over semantic witnesses. Contract:
//   graphKinds(db: Db, context: Context): { kinds: Array<{ kind; table; state: 'implemented' | 'deferred'; reason: string | null;
//     nodes: number }>; predicates: Array<{ predicate; table; state; reason; live: number; retired: number }> }
//   graphNodes(db, context, request: { kinds: Array<string> | null; limit; cursor }): Page<GraphNodeRecord>
//   graphEdges(db, context, request: GraphEdgeRequest & { limit; cursor }): Page<GraphEdgeRecord>
//   graphNode(db, context, nodeId): { found: true; node: GraphNodeRecord; row: Row | null; rowState: 'live' | 'retired' | 'missing';
//     witnesses: Array<{ audienceId; evidenceId }>; incoming: number; outgoing: number } | { found: false; code: 'NODE_NOT_FOUND' }
//   graphNeighbors(db, context, request: GraphEdgeRequest & { node; direction: 'in' | 'out' | 'both'; limit; cursor }): Page<GraphEdgeRecord>
//   graphWalk(db, context, request: GraphEdgeRequest & { from: Array<string>; direction; maxDepth; maxNodes; cursor }): GraphWalkPage
//   graphPath(db, context, request: GraphEdgeRequest & { from; to; direction; maxDepth }): GraphPathResult
//   GraphEdgeRequest = { predicates: Array<string> | null; mode: 'active' | 'historical'; validAt: string | null; recordedBefore: string | null }
//   GraphNodeRecord = { id; kind; rowId; createdAt }
//   GraphEdgeRecord = { id; src; dst; predicate; audienceId; evidenceId; validFromAt; validToAt; recordedAt; retiredAt }
//   GraphWalkPage = { visited: Array<{ node; kind; rowId; depth }>; edges: Array<GraphEdgeRecord>; frontier: Array<string>;
//     next: string | null; truncated: boolean; reason: 'page' | 'depth' | null }
//   GraphPathResult = { found: true; edges: Array<GraphEdgeRecord>; nodes: Array<string>; versionIds: Array<string> }
//     | { found: false; reason: 'none' | 'depth' | 'work'; explored: number }
// A cursor from another context or request throws an Error with `code` INSPECTION_BAD_CURSOR.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DEFERRED, NODE_KINDS, PREDICATES } from '../src/memory/db/graph-manifest.ts';
import {
  graphEdges,
  graphKinds,
  graphNeighbors,
  graphNode,
  graphNodes,
  graphPath,
  graphWalk,
} from '../src/memory/db/graph-read.ts';
import type { GraphEdgeRecord, GraphEdgeRequest, GraphNodeRecord, GraphWalkPage } from '../src/memory/db/graph-read.ts';
import { rebuildGraph, reproject } from '../src/memory/db/graph.ts';
import { createInspectionPort } from '../src/memory/db/inspection-snapshots.ts';
import type { Page } from '../src/memory/db/inspection.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dmContext, groupContext, internalContext } from '../src/memory/db/scope.ts';
import type { Context } from '../src/memory/db/scope.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle } from '../src/memory/db/types.ts';
import { wrongly } from './fixtures/loose-types.ts';
import {
  addAuthority,
  addEdge,
  addNode,
  addPlace,
  clearGraph,
  databaseDigest,
} from './fixtures/memory-db/browser-world.ts';
import { tempDir } from './fixtures/tmp.ts';

const INTERNAL = internalContext();
const ACTIVE: GraphEdgeRequest = { predicates: null, mode: 'active', validAt: null, recordedBefore: null };
const HISTORICAL: GraphEdgeRequest = { ...ACTIVE, mode: 'historical' };

const opened: Array<MemoryHandle> = [];
after(() => {
  for (const handle of opened) handle.close();
});

function world(seed: (db: Db) => void = () => {}): Db {
  const handle = openMemoryDb(':memory:');
  opened.push(handle);
  const db = dbOf(handle);
  clearGraph(db);
  addAuthority(db, 'zeta', 'zeta/one');
  seed(db);
  return db;
}

const node = (name: string): string => `claim:${name}`;

function everyNode(
  db: Db,
  context: Context = INTERNAL,
  kinds: Array<string> | null = null,
  limit = 3
): Array<GraphNodeRecord> {
  const items: Array<GraphNodeRecord> = [];
  let cursor: string | null = null;
  for (let turn = 0; turn < 100_000; turn += 1) {
    const page: Page<GraphNodeRecord> = graphNodes(db, context, { kinds, limit, cursor });
    items.push(...page.items);
    if (page.next === null) return items;
    cursor = page.next;
  }
  throw new Error('the pages never end');
}

function everyEdge(
  db: Db,
  context: Context = INTERNAL,
  request: GraphEdgeRequest = HISTORICAL,
  limit = 3
): Array<GraphEdgeRecord> {
  const items: Array<GraphEdgeRecord> = [];
  let cursor: string | null = null;
  for (let turn = 0; turn < 100_000; turn += 1) {
    const page: Page<GraphEdgeRecord> = graphEdges(db, context, { ...request, limit, cursor });
    items.push(...page.items);
    if (page.next === null) return items;
    cursor = page.next;
  }
  throw new Error('the pages never end');
}

type WalkOptions = {
  maxDepth?: number;
  maxNodes?: number;
  direction?: 'in' | 'out' | 'both';
  request?: GraphEdgeRequest;
  context?: Context;
};

function walkOnce(db: Db, from: Array<string>, options: WalkOptions = {}, cursor: string | null = null): GraphWalkPage {
  return graphWalk(db, options.context ?? INTERNAL, {
    ...(options.request ?? ACTIVE),
    from,
    direction: options.direction ?? 'out',
    maxDepth: options.maxDepth ?? 100,
    maxNodes: options.maxNodes ?? 1000,
    cursor,
  });
}

/** Every page of a walk, joined. */
function walkAll(
  db: Db,
  from: Array<string>,
  options: WalkOptions = {}
): { visited: Array<string>; edges: Array<string>; last: GraphWalkPage } {
  const visited: Array<string> = [];
  const edges: Array<string> = [];
  let cursor: string | null = null;
  for (let turn = 0; turn < 100_000; turn += 1) {
    const page: GraphWalkPage = walkOnce(db, from, options, cursor);
    visited.push(...page.visited.map((one) => one.node));
    edges.push(...page.edges.map((one) => one.id));
    if (page.next === null) return { visited, edges, last: page };
    cursor = page.next;
  }
  throw new Error('the walk never ends');
}

const sorted = (items: ReadonlyArray<string>): Array<string> => [...items].sort();
const assertOnce = (items: ReadonlyArray<string>, what: string): void =>
  assert.equal(new Set(items).size, items.length, `${what} repeats: ${items.join(' ')}`);

// ---------- inventories ----------

/** One node of every implemented kind and one edge of every implemented predicate, read from the manifest. */
function seedManifest(db: Db): { nodes: Array<string>; edges: Array<string> } {
  const kinds = Object.entries(NODE_KINDS)
    .filter(([, spec]) => spec.table !== null)
    .map(([kind]) => kind);
  const nodes = kinds.map((kind) => `${kind}:one`);
  for (const id of nodes) addNode(db, id);
  const edges = Object.entries(PREDICATES)
    .filter(([, spec]) => spec.table !== null)
    .map(([predicate, spec]) => addEdge(db, { src: `${spec.from[0]}:one`, dst: `${spec.to[0]}:one`, predicate }));
  return { nodes, edges };
}

test('the inventories return every projected kind and predicate exactly once across pages', () => {
  // Bug: enumeration is a walk from known starts, so a kind nothing reaches is missing from "everything".
  const db = world();
  const { nodes, edges } = seedManifest(db);
  const listedNodes = everyNode(db).map((one) => one.id);
  assertOnce(listedNodes, 'a node');
  assert.deepEqual(sorted(listedNodes), sorted(nodes));
  const listedEdges = everyEdge(db).map((one) => one.id);
  assertOnce(listedEdges, 'an edge');
  assert.deepEqual(sorted(listedEdges), sorted(edges));
});

test('an isolated node, a placeholder and a disconnected component are all in the inventory', () => {
  // Bug: nodes are found through edges, so one with no edge does not exist for the owner.
  const db = world((seed) => {
    addNode(seed, node('isolated'));
    addEdge(seed, { src: node('a'), dst: node('b') });
    addEdge(seed, { src: node('x'), dst: node('y') });
  });
  assert.deepEqual(sorted(everyNode(db).map((one) => one.id)), sorted(['isolated', 'a', 'b', 'x', 'y'].map(node)));
});

test('a node record keeps its kind, row id and time', () => {
  const db = world((seed) => addNode(seed, 'person:p1'));
  assert.deepEqual(everyNode(db), [
    { id: 'person:p1', kind: 'person', rowId: 'p1', createdAt: '2026-11-01T00:00:00.000Z' },
  ]);
});

test('kinds filter the node inventory before the count', () => {
  const db = world((seed) => {
    addNode(seed, 'person:p1');
    addNode(seed, 'person:p2');
    addNode(seed, 'place:r1');
  });
  const page = graphNodes(db, INTERNAL, { kinds: ['person'], limit: 1, cursor: null });
  assert.equal(page.total, 2);
  assert.deepEqual(sorted(everyNode(db, INTERNAL, ['person']).map((one) => one.id)), ['person:p1', 'person:p2']);
});

test('graphKinds lists every kind and predicate with live counts, and the deferred ones as deferred', () => {
  // Bug: a deferred kind reads as an implemented one that happens to be empty.
  const db = world();
  const { nodes } = seedManifest(db);
  addEdge(db, {
    src: 'person:one',
    dst: 'place:one',
    predicate: 'about',
    retiredAt: '2026-11-02T00:00:00.000Z',
    id: 'edge:retired',
  });
  const { kinds, predicates } = graphKinds(db, INTERNAL);
  assert.deepEqual(sorted(kinds.map((one) => one.kind)), sorted(Object.keys(NODE_KINDS)));
  assert.deepEqual(sorted(predicates.map((one) => one.predicate)), sorted(Object.keys(PREDICATES)));
  const skill = kinds.find((one) => one.kind === 'skill');
  assert.deepEqual([skill?.state, skill?.reason], ['deferred', DEFERRED.skill]);
  assert.equal(predicates.find((one) => one.predicate === 'follows')?.state, 'deferred');
  assert.equal(predicates.find((one) => one.predicate === 'owned_by')?.state, 'deferred');
  assert.equal(kinds.find((one) => one.kind === 'person')?.state, 'implemented');
  assert.equal(
    kinds.reduce((sum, one) => sum + one.nodes, 0),
    nodes.length
  );
  const about = predicates.find((one) => one.predicate === 'about');
  assert.deepEqual([about?.live, about?.retired], [1, 1]);
});

test('an empty graph lists no node and no edge, and completes', () => {
  const db = world();
  const page = graphNodes(db, INTERNAL, { kinds: null, limit: 5, cursor: null });
  assert.deepEqual([page.items, page.total, page.next], [[], 0, null]);
  assert.deepEqual(everyEdge(db), []);
  assert.deepEqual(walkOnce(db, []).visited, []);
});

// ---------- edges ----------

test('parallel edges stay apart in the inventory and among neighbours', () => {
  // Bug: edges are grouped by their ends, so a second predicate or a second evidence between two nodes vanishes.
  const db = world((seed) => {
    addEdge(seed, { id: 'edge:p1', src: node('a'), dst: node('b'), predicate: 'mentions' });
    addEdge(seed, { id: 'edge:p2', src: node('a'), dst: node('b'), predicate: 'quotes' });
    addEdge(seed, { id: 'edge:p3', src: node('a'), dst: node('b'), predicate: 'mentions', evidence: 'source:other' });
  });
  const page = graphNeighbors(db, INTERNAL, { ...ACTIVE, node: node('a'), direction: 'out', limit: 2, cursor: null });
  assert.equal(page.total, 3);
  assert.deepEqual(page.items.length, 2);
  const rest = graphNeighbors(db, INTERNAL, {
    ...ACTIVE,
    node: node('a'),
    direction: 'out',
    limit: 2,
    cursor: page.next,
  });
  assert.deepEqual(sorted([...page.items, ...rest.items].map((one) => one.id)), ['edge:p1', 'edge:p2', 'edge:p3']);
});

test('neighbours follow the direction asked, and a self-loop counts once', () => {
  const db = world((seed) => {
    addEdge(seed, { id: 'edge:out', src: node('a'), dst: node('b') });
    addEdge(seed, { id: 'edge:in', src: node('c'), dst: node('a') });
    addEdge(seed, { id: 'edge:self', src: node('a'), dst: node('a') });
  });
  const ids = (direction: 'in' | 'out' | 'both'): Array<string> =>
    sorted(
      graphNeighbors(db, INTERNAL, { ...ACTIVE, node: node('a'), direction, limit: 50, cursor: null }).items.map(
        (one) => one.id
      )
    );
  assert.deepEqual(ids('out'), ['edge:out', 'edge:self']);
  assert.deepEqual(ids('in'), ['edge:in', 'edge:self']);
  assert.deepEqual(ids('both'), ['edge:in', 'edge:out', 'edge:self']);
});

test('an edge record keeps its validity, recording and retirement times apart', () => {
  // Bug: `valid_to_at` and `retired_at` collapse into one "ended", and two different histories read the same.
  const db = world((seed) => {
    addEdge(seed, {
      id: 'edge:full',
      src: node('a'),
      dst: node('b'),
      predicate: 'mentions',
      audience: 'aud:group:zeta',
      evidence: 'source:e',
      validFrom: '2020-01-01T00:00:00.000Z',
      validTo: '2021-01-01T00:00:00.000Z',
      recordedAt: '2025-01-01T00:00:00.000Z',
      retiredAt: '2026-01-01T00:00:00.000Z',
    });
  });
  assert.deepEqual(everyEdge(db), [
    {
      id: 'edge:full',
      src: node('a'),
      dst: node('b'),
      predicate: 'mentions',
      audienceId: 'aud:group:zeta',
      evidenceId: 'source:e',
      validFromAt: '2020-01-01T00:00:00.000Z',
      validToAt: '2021-01-01T00:00:00.000Z',
      recordedAt: '2025-01-01T00:00:00.000Z',
      retiredAt: '2026-01-01T00:00:00.000Z',
    },
  ]);
});

test('active mode leaves out retired edges and historical mode shows them, by explicit request', () => {
  // Bug: `retired_at IS NULL` is built in, so history is unreachable; or history leaks into the active view.
  const db = world((seed) => {
    addEdge(seed, { id: 'edge:live', src: node('a'), dst: node('b') });
    addEdge(seed, { id: 'edge:gone', src: node('a'), dst: node('c'), retiredAt: '2026-01-01T00:00:00.000Z' });
  });
  assert.deepEqual(
    everyEdge(db, INTERNAL, ACTIVE).map((one) => one.id),
    ['edge:live']
  );
  assert.deepEqual(sorted(everyEdge(db, INTERNAL, HISTORICAL).map((one) => one.id)), ['edge:gone', 'edge:live']);
  assert.deepEqual(walkAll(db, [node('a')]).visited.sort(), [node('a'), node('b')]);
  assert.deepEqual(walkAll(db, [node('a')], { request: HISTORICAL }).visited.sort(), [node('a'), node('b'), node('c')]);
});

test('the valid-time and recording-cutoff filters are two different questions', () => {
  // Bug: one "as of" compares against one column, so what was true then and what we knew then are confused.
  const db = world((seed) => {
    addEdge(seed, {
      id: 'edge:late-told',
      src: node('a'),
      dst: node('b'),
      validFrom: '2020-01-01T00:00:00.000Z',
      validTo: '2021-01-01T00:00:00.000Z',
      recordedAt: '2025-01-01T00:00:00.000Z',
    });
    addEdge(seed, { id: 'edge:open', src: node('a'), dst: node('c'), recordedAt: '2019-01-01T00:00:00.000Z' });
  });
  const ids = (validAt: string | null, recordedBefore: string | null): Array<string> =>
    sorted(everyEdge(db, INTERNAL, { ...HISTORICAL, validAt, recordedBefore }).map((one) => one.id));
  assert.deepEqual(ids('2020-06-01T00:00:00.000Z', null), ['edge:late-told', 'edge:open']);
  assert.deepEqual(ids('2022-06-01T00:00:00.000Z', null), ['edge:open']);
  assert.deepEqual(ids('2019-06-01T00:00:00.000Z', null), ['edge:open']);
  assert.deepEqual(ids('2020-06-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z'), ['edge:open']);
  assert.deepEqual(ids(null, '2026-01-01T00:00:00.000Z'), ['edge:late-told', 'edge:open']);
  assert.deepEqual(ids(null, '2018-01-01T00:00:00.000Z'), []);
});

test('a predicate filter applies to the inventory, the neighbours and the walk', () => {
  const db = world((seed) => {
    addEdge(seed, { id: 'edge:m', src: node('a'), dst: node('b'), predicate: 'mentions' });
    addEdge(seed, { id: 'edge:q', src: node('a'), dst: node('c'), predicate: 'quotes' });
    addEdge(seed, { id: 'edge:qq', src: node('c'), dst: node('d'), predicate: 'quotes' });
  });
  const request = { ...ACTIVE, predicates: ['quotes'] };
  assert.deepEqual(sorted(everyEdge(db, INTERNAL, request).map((one) => one.id)), ['edge:q', 'edge:qq']);
  assert.deepEqual(
    graphNeighbors(db, INTERNAL, { ...request, node: node('a'), direction: 'out', limit: 5, cursor: null }).items.map(
      (one) => one.id
    ),
    ['edge:q']
  );
  assert.deepEqual(sorted(walkAll(db, [node('a')], { request }).visited), [node('a'), node('c'), node('d')]);
});

// ---------- node detail ----------

test('a node opens its typed row, its witnesses and its edge counts', () => {
  // Bug: the detail shows the projection only, and the owner cannot reach the stored record behind it.
  const db = world((seed) => {
    addPlace(seed, { id: 'place:r1', iface: 'zeta', authority: 'zeta/one', name: 'Κήπος' });
    addEdge(seed, { id: 'edge:o', src: 'place:place:r1', dst: node('x'), audience: 'aud:group:zeta' });
    addEdge(seed, { id: 'edge:i', src: node('y'), dst: 'place:place:r1', audience: 'aud:group:zeta' });
  });
  const view = graphNode(db, INTERNAL, 'place:place:r1');
  assert.ok(view.found);
  assert.equal(view.row?.name, 'Κήπος');
  assert.equal(view.rowState, 'live');
  assert.deepEqual([view.incoming, view.outgoing], [1, 1]);
  assert.deepEqual(view.witnesses.map((one) => [one.audienceId, one.evidenceId]).sort(), [
    ['aud:group:zeta', 'edge:i'],
    ['aud:group:zeta', 'edge:o'],
  ]);
});

test('a placeholder and a retired row are told apart', () => {
  // Bug: a null row reads as a retired one, or a retired row as live, in a graph that names rows it never saw.
  const db = world((seed) => {
    addPlace(seed, { id: 'place:gone', iface: 'zeta', authority: 'zeta/one', retiredAt: '2026-01-01T00:00:00.000Z' });
    addNode(seed, 'place:place:gone');
    addNode(seed, 'place:never-stored');
  });
  const retired = graphNode(db, INTERNAL, 'place:place:gone');
  assert.ok(retired.found);
  assert.equal(retired.rowState, 'retired');
  assert.equal(retired.row?.id, 'place:gone');
  const placeholder = graphNode(db, INTERNAL, 'place:never-stored');
  assert.ok(placeholder.found);
  assert.deepEqual([placeholder.rowState, placeholder.row], ['missing', null]);
});

test('a node nobody stored is a named refusal', () => {
  assert.deepEqual(graphNode(world(), INTERNAL, 'claim:unknown'), { found: false, code: 'NODE_NOT_FOUND' });
});

// ---------- the walk ----------

function diamond(db: Db): void {
  addEdge(db, { id: 'edge:ab', src: node('a'), dst: node('b') });
  addEdge(db, { id: 'edge:ac', src: node('a'), dst: node('c') });
  addEdge(db, { id: 'edge:bd', src: node('b'), dst: node('d') });
  addEdge(db, { id: 'edge:cd', src: node('c'), dst: node('d') });
}

test('a diamond visits each node once and traverses each edge once', () => {
  // Bug: the path-limited walk returns d twice across pages, and keeps only one of its two incoming edges.
  const db = world(diamond);
  const { visited, edges } = walkAll(db, [node('a')]);
  assert.deepEqual(sorted(visited), sorted(['a', 'b', 'c', 'd'].map(node)));
  assertOnce(visited, 'a node');
  assert.deepEqual(sorted(edges), ['edge:ab', 'edge:ac', 'edge:bd', 'edge:cd']);
});

test('a cycle and a self-loop end, with each node and edge once', () => {
  const db = world((seed) => {
    addEdge(seed, { id: 'edge:ab', src: node('a'), dst: node('b') });
    addEdge(seed, { id: 'edge:bc', src: node('b'), dst: node('c') });
    addEdge(seed, { id: 'edge:ca', src: node('c'), dst: node('a') });
    addEdge(seed, { id: 'edge:bb', src: node('b'), dst: node('b') });
  });
  const { visited, edges, last } = walkAll(db, [node('a')]);
  assert.deepEqual(sorted(visited), sorted(['a', 'b', 'c'].map(node)));
  assert.deepEqual(sorted(edges), ['edge:ab', 'edge:bb', 'edge:bc', 'edge:ca']);
  assert.deepEqual(last.frontier, []);
  assert.equal(last.truncated, false);
});

test('a ladder of thirty diamonds completes, because the work follows nodes and not paths', () => {
  // Bug: a recursive CTE enumerates 2^30 paths and never returns, or stops at its row cap with most of the graph unseen.
  const rungs = 30;
  const db = world((seed) => {
    for (let n = 0; n < rungs; n += 1) {
      addEdge(seed, { src: node(`j${n}`), dst: node(`l${n}`) });
      addEdge(seed, { src: node(`j${n}`), dst: node(`r${n}`) });
      addEdge(seed, { src: node(`l${n}`), dst: node(`j${n + 1}`) });
      addEdge(seed, { src: node(`r${n}`), dst: node(`j${n + 1}`) });
    }
  });
  const { visited, edges } = walkAll(db, [node('j0')], { maxNodes: 40 });
  assert.equal(visited.length, 3 * rungs + 1);
  assertOnce(visited, 'a node');
  assert.equal(edges.length, 4 * rungs);
  assertOnce(edges, 'an edge');
});

test('a chain deeper than six reaches its last node', () => {
  // Bug: the walk's old default depth of six silently ends a deep containment chain.
  const db = world((seed) => {
    for (let n = 0; n < 12; n += 1)
      addEdge(seed, { src: node(`n${n}`), dst: node(`n${n + 1}`), predicate: 'contained_in' });
  });
  assert.ok(walkAll(db, [node('n0')]).visited.includes(node('n12')));
});

test('a depth bound stops with a frontier, and walking from the frontier finishes the graph', () => {
  // Bug: `reason: depth` with no way to go on, so what lies past the bound is unreachable.
  const db = world((seed) => {
    for (let n = 0; n < 6; n += 1) addEdge(seed, { id: `edge:${n}`, src: node(`n${n}`), dst: node(`n${n + 1}`) });
    addNode(seed, node('unreached'));
  });
  const page = walkOnce(db, [node('n0')], { maxDepth: 2 });
  assert.deepEqual(sorted(page.visited.map((one) => one.node)), sorted(['n0', 'n1', 'n2'].map(node)));
  assert.deepEqual(page.frontier, [node('n2')]);
  assert.equal(page.reason, 'depth');
  assert.equal(page.truncated, true);
  const rest = walkAll(db, page.frontier);
  assert.ok(rest.visited.includes(node('n6')));
  assert.deepEqual(rest.last.frontier, []);
  assert.deepEqual(page.visited.find((one) => one.node === node('n2'))?.depth, 2);
});

test('a node bound pages the walk without losing or repeating a node', () => {
  const db = world((seed) => {
    for (let n = 0; n < 7; n += 1) addEdge(seed, { src: node('hub'), dst: node(`spoke${n}`) });
  });
  const firstPage = walkOnce(db, [node('hub')], { maxNodes: 3 });
  assert.equal(firstPage.visited.length, 3);
  assert.equal(firstPage.reason, 'page');
  const { visited } = walkAll(db, [node('hub')], { maxNodes: 3 });
  assertOnce(visited, 'a node');
  assert.equal(visited.length, 8);
});

test('the walk follows the direction asked', () => {
  const db = world((seed) => {
    addEdge(seed, { src: node('a'), dst: node('b') });
    addEdge(seed, { src: node('c'), dst: node('a') });
  });
  assert.deepEqual(sorted(walkAll(db, [node('a')], { direction: 'out' }).visited), sorted(['a', 'b'].map(node)));
  assert.deepEqual(sorted(walkAll(db, [node('a')], { direction: 'in' }).visited), sorted(['a', 'c'].map(node)));
  assert.deepEqual(sorted(walkAll(db, [node('a')], { direction: 'both' }).visited), sorted(['a', 'b', 'c'].map(node)));
});

test('several starts share one visited set, and a start nobody stored is left out', () => {
  const db = world((seed) => {
    addEdge(seed, { src: node('a'), dst: node('c') });
    addEdge(seed, { src: node('b'), dst: node('c') });
  });
  const { visited } = walkAll(db, [node('a'), node('b'), node('unknown')]);
  assert.deepEqual(sorted(visited), sorted(['a', 'b', 'c'].map(node)));
});

for (const [label, patch] of [
  ['a negative depth', { maxDepth: -1 }],
  ['a zero node bound', { maxNodes: 0 }],
  ['a fractional depth', { maxDepth: 1.5 }],
] as const) {
  test(`a walk with ${label} is refused rather than unbounded`, () => {
    // Bug: a bad bound falls back to "no bound", the one thing the walk must never do.
    assert.throws(() => walkOnce(world(diamond), [node('a')], patch), { code: 'INSPECTION_BAD_LIMIT' });
  });
}

// ---------- the path ----------

test('the shortest association path is returned edge by edge', () => {
  const db = world((seed) => {
    addEdge(seed, { id: 'edge:ab', src: node('a'), dst: node('b') });
    addEdge(seed, { id: 'edge:bc', src: node('b'), dst: node('c') });
    addEdge(seed, { id: 'edge:ax', src: node('a'), dst: node('x') });
    addEdge(seed, { id: 'edge:xy', src: node('x'), dst: node('y') });
    addEdge(seed, { id: 'edge:yc', src: node('y'), dst: node('c') });
  });
  const path = graphPath(db, INTERNAL, { ...ACTIVE, from: node('a'), to: node('c'), direction: 'out', maxDepth: 10 });
  assert.ok(path.found);
  assert.deepEqual(
    path.edges.map((one) => one.id),
    ['edge:ab', 'edge:bc']
  );
  assert.deepEqual(path.nodes, [node('a'), node('b'), node('c')]);
});

test('a path names the exact versions it passes through', () => {
  // Bug: the path shows the claim, and the owner cannot tell which version of it carries the association.
  const db = world((seed) => {
    addEdge(seed, { id: 'edge:1', src: 'source:s1', dst: 'claim_version:v7', predicate: 'derived_from' });
    addEdge(seed, { id: 'edge:2', src: 'claim_version:v7', dst: 'claim:c1', predicate: 'version_of' });
  });
  const path = graphPath(db, INTERNAL, { ...ACTIVE, from: 'source:s1', to: 'claim:c1', direction: 'out', maxDepth: 5 });
  assert.ok(path.found);
  assert.deepEqual(path.versionIds, ['v7']);
});

test('a path to itself has no edges', () => {
  const db = world(diamond);
  const path = graphPath(db, INTERNAL, { ...ACTIVE, from: node('a'), to: node('a'), direction: 'out', maxDepth: 5 });
  assert.ok(path.found);
  assert.deepEqual([path.edges, path.nodes], [[], [node('a')]]);
});

test('no path says why: none at all, or the bound ended the search', () => {
  // Bug: both read as "not connected", so a depth bound looks like a fact about the graph.
  const db = world((seed) => {
    for (let n = 0; n < 6; n += 1) addEdge(seed, { src: node(`n${n}`), dst: node(`n${n + 1}`) });
    addNode(seed, node('island'));
  });
  const bounded = graphPath(db, INTERNAL, {
    ...ACTIVE,
    from: node('n0'),
    to: node('n6'),
    direction: 'out',
    maxDepth: 2,
  });
  assert.ok(!bounded.found);
  assert.equal(bounded.reason, 'depth');
  const none = graphPath(db, INTERNAL, {
    ...ACTIVE,
    from: node('n0'),
    to: node('island'),
    direction: 'out',
    maxDepth: 20,
  });
  assert.ok(!none.found);
  assert.equal(none.reason, 'none');
});

test('a path over a ladder of thirty diamonds ends, its work bounded by nodes', () => {
  const db = world((seed) => {
    for (let n = 0; n < 30; n += 1) {
      addEdge(seed, { src: node(`j${n}`), dst: node(`l${n}`) });
      addEdge(seed, { src: node(`j${n}`), dst: node(`r${n}`) });
      addEdge(seed, { src: node(`l${n}`), dst: node(`j${n + 1}`) });
      addEdge(seed, { src: node(`r${n}`), dst: node(`j${n + 1}`) });
    }
    addNode(seed, node('island'));
  });
  const path = graphPath(db, INTERNAL, {
    ...ACTIVE,
    from: node('j0'),
    to: node('island'),
    direction: 'out',
    maxDepth: 100,
  });
  assert.ok(!path.found);
  assert.equal(path.reason, 'none');
  assert.equal(path.explored, 91);
});

test('reading a path remembers nothing', () => {
  // Bug: a found association is stored as an edge or a claim, and inference becomes memory.
  const db = world(diamond);
  const before = databaseDigest(db);
  graphPath(db, INTERNAL, { ...ACTIVE, from: node('a'), to: node('d'), direction: 'out', maxDepth: 5 });
  assert.deepEqual(databaseDigest(db), before);
});

// ---------- the context decides first ----------

function audienceWorld(db: Db): void {
  addPlace(db, { id: 'place:dm', iface: 'zeta', authority: 'zeta/one', conversation: 'dm', kind: 'dm' });
  addEdge(db, { id: 'edge:public', src: node('a'), dst: node('b'), audience: 'aud:group:zeta' });
  addEdge(db, { id: 'edge:private', src: node('b'), dst: node('secret'), audience: 'aud:dm:place:dm' });
  addEdge(db, { id: 'edge:past-secret', src: node('secret'), dst: node('beyond'), audience: 'aud:group:zeta' });
  addEdge(db, { id: 'edge:internal', src: node('a'), dst: node('hidden'), audience: 'aud:internal' });
}

test('a group context filters inventories and counts before paging', () => {
  // Bug: a page is cut first and filtered after, so a preview shows short pages and the true total.
  const db = world(audienceWorld);
  const context = groupContext('zeta');
  const edges = everyEdge(db, context, ACTIVE, 1).map((one) => one.id);
  assert.deepEqual(sorted(edges), ['edge:past-secret', 'edge:public']);
  assert.equal(graphEdges(db, context, { ...ACTIVE, limit: 1, cursor: null }).total, 2);
  const nodes = everyNode(db, context, null, 1).map((one) => one.id);
  assert.equal(nodes.includes(node('hidden')), false);
  assert.equal(graphNodes(db, context, { kinds: null, limit: 1, cursor: null }).total, nodes.length);
  const about = graphKinds(db, context).predicates.find((one) => one.predicate === 'mentions');
  assert.equal(about?.live, 2);
});

test('a group walk stops at a private edge and cannot pass through it', () => {
  // Bug: the audience is checked on the result, so a public node reached only through a DM edge leaks the connection.
  const db = world(audienceWorld);
  const context = groupContext('zeta');
  const { visited, edges } = walkAll(db, [node('a')], { context });
  assert.deepEqual(sorted(visited), sorted(['a', 'b'].map(node)));
  assert.deepEqual(edges, ['edge:public']);
  const path = graphPath(db, context, {
    ...ACTIVE,
    from: node('a'),
    to: node('beyond'),
    direction: 'out',
    maxDepth: 10,
  });
  assert.ok(!path.found);
  assert.equal(path.reason, 'none');
});

test('the owner walks through what the group cannot, and reaches an unwitnessed node', () => {
  const db = world(audienceWorld);
  addNode(db, node('unwitnessed'));
  assert.ok(walkAll(db, [node('a')]).visited.includes(node('beyond')));
  assert.ok(graphNode(db, INTERNAL, node('unwitnessed')).found);
});

test('a group sees neither a node it has no witness for, nor its detail', () => {
  const db = world(audienceWorld);
  assert.deepEqual(graphNode(db, groupContext('zeta'), node('hidden')), { found: false, code: 'NODE_NOT_FOUND' });
});

test('a DM context of another conversation reads no private edge', () => {
  const db = world(audienceWorld);
  const context = dmContext('person:other', 'zeta', 'place:other-dm');
  assert.equal(
    everyEdge(db, context, ACTIVE, 5).some((one) => one.id === 'edge:private'),
    false
  );
});

test('a call without a valid context is refused, never read as the owner', () => {
  const db = world(diamond);
  const bad = wrongly<Context>({});
  assert.throws(() => graphKinds(db, bad));
  assert.throws(() => graphNodes(db, bad, { kinds: null, limit: 5, cursor: null }));
  assert.throws(() => graphEdges(db, bad, { ...ACTIVE, limit: 5, cursor: null }));
  assert.throws(() => graphNode(db, bad, node('a')));
  assert.throws(() =>
    graphNeighbors(db, bad, { ...ACTIVE, node: node('a'), direction: 'out', limit: 5, cursor: null })
  );
  assert.throws(() => walkOnce(db, [node('a')], { context: bad }));
  assert.throws(() => graphPath(db, bad, { ...ACTIVE, from: node('a'), to: node('d'), direction: 'out', maxDepth: 5 }));
});

// ---------- cursors ----------

test('a cursor cannot change its context, filters or direction between pages', () => {
  // Bug: a cursor minted by the owner and replayed under a group context reads on past the group's rights.
  const db = world((seed) => {
    audienceWorld(seed);
    for (let n = 0; n < 6; n += 1) addEdge(seed, { src: node('hub'), dst: node(`s${n}`), audience: 'aud:group:zeta' });
  });
  const code = { code: 'INSPECTION_BAD_CURSOR' };
  const edges = graphEdges(db, INTERNAL, { ...ACTIVE, limit: 1, cursor: null });
  assert.throws(() => graphEdges(db, groupContext('zeta'), { ...ACTIVE, limit: 1, cursor: edges.next }), code);
  assert.throws(() => graphEdges(db, INTERNAL, { ...HISTORICAL, limit: 1, cursor: edges.next }), code);
  assert.throws(
    () => graphEdges(db, INTERNAL, { ...ACTIVE, predicates: ['quotes'], limit: 1, cursor: edges.next }),
    code
  );
  const nodes = graphNodes(db, INTERNAL, { kinds: null, limit: 1, cursor: null });
  assert.throws(() => graphNodes(db, INTERNAL, { kinds: ['claim'], limit: 1, cursor: nodes.next }), code);
  assert.throws(() => graphEdges(db, INTERNAL, { ...ACTIVE, limit: 1, cursor: nodes.next }), code);
  const walk = walkOnce(db, [node('hub')], { maxNodes: 2 });
  assert.throws(() => walkOnce(db, [node('hub')], { maxNodes: 2, direction: 'in' }, walk.next), code);
  assert.throws(() => walkOnce(db, [node('a')], { maxNodes: 2 }, walk.next), code);
  assert.throws(() => walkOnce(db, [node('hub')], { maxNodes: 2, context: groupContext('zeta') }, walk.next), code);
  assert.throws(
    () => graphNeighbors(db, INTERNAL, { ...ACTIVE, node: node('hub'), direction: 'out', limit: 1, cursor: 'garbage' }),
    code
  );
});

// ---------- snapshots ----------

test('pages through the snapshot service see every node of one moment exactly once under a concurrent writer', () => {
  // Bug: offset pages over the live table shift when a witness or a node lands between two pages.
  const file = join(tempDir('nep-graph-read-'), 'memory.db');
  const writer = openMemoryDb(file);
  try {
    const db = dbOf(writer);
    clearGraph(db);
    for (let n = 0; n < 9; n += 1) addEdge(db, { src: node(`n${n}`), dst: node(`n${n + 1}`) });
    const port = createInspectionPort({ dbPath: file, now: () => 0, engineRevision: 'rev' });
    const handle = port.openInspection({
      ownerId: 'owner',
      bounds: { pageRows: 100, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300 },
    });
    try {
      const read = (cursor: string | null): Page<GraphNodeRecord> =>
        port.withSnapshotDb(handle, (snapshot) => graphNodes(snapshot, INTERNAL, { kinds: null, limit: 3, cursor }));
      const seen: Array<string> = [];
      let page = read(null);
      seen.push(...page.items.map((one) => one.id));
      addEdge(db, { src: node('aaa-new'), dst: node('aab-new') });
      db.exec('DELETE FROM node_access; DELETE FROM graph_edges;');
      while (page.next !== null) {
        page = read(page.next);
        seen.push(...page.items.map((one) => one.id));
      }
      assertOnce(seen, 'a node');
      assert.deepEqual(sorted(seen), sorted(Array.from({ length: 10 }, (_, n) => node(`n${n}`))));
    } finally {
      port.closeAll();
    }
  } finally {
    writer.close();
  }
});

// ---------- rebuild and no write ----------

test('the reader invents no history a rebuild discarded', () => {
  // Bug: an edge the rows no longer produce is synthesized as "retired", as if it had been observed.
  const db = world((seed) => {
    addPlace(seed, { id: 'place:r1', iface: 'zeta', authority: 'zeta/one' });
    addEdge(seed, { id: 'edge:stale', src: node('a'), dst: node('b'), retiredAt: '2026-01-01T00:00:00.000Z' });
  });
  const handle = opened.at(-1);
  assert.ok(handle);
  rebuildGraph(handle);
  const edges = everyEdge(db).map((one) => one.id);
  assert.equal(edges.includes('edge:stale'), false);
  assert.ok(everyNode(db).some((one) => one.id === 'place:place:r1'));
});

test('a typed relation the projection does not carry is not shown as an edge', () => {
  // Bug: an unresolved `references` relation is projected on read, so the graph claims what the manifest defers.
  const db = world((seed) => {
    addPlace(seed, { id: 'place:r1', iface: 'zeta', authority: 'zeta/one' });
    seed
      .prepare(
        `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, occurred_at, recorded_at, text, audience_id)
       VALUES ('source:s1', 'message', 'zeta', 'n1', 0, 'place:r1', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 'x', 'aud:group:zeta')`
      )
      .run();
    seed
      .prepare(
        `INSERT INTO source_relations (id, source_id, predicate, target_key, recorded_at)
       VALUES (1, 'source:s1', 'references', 'unresolved-native-key', '2026-11-01T00:00:00.000Z')`
      )
      .run();
  });
  const handle = opened.at(-1);
  assert.ok(handle);
  reproject(handle, { at: '2026-11-01T00:00:00.000Z' });
  assert.equal(
    everyEdge(db).some((one) => one.predicate === 'references'),
    false
  );
});

test('every reader runs over a read-only connection and changes no row, node_access included', () => {
  // Bug: a read witnesses the node it opened, so inspecting the graph widens who may see it.
  const file = join(tempDir('nep-graph-read-only-'), 'memory.db');
  const writer = openMemoryDb(file);
  audienceWorld(dbOf(writer));
  addAuthority(dbOf(writer), 'zeta', 'zeta/one');
  writer.close();
  const reader = openMemoryDb(file, { readOnly: true });
  try {
    const db = dbOf(reader);
    const before = databaseDigest(db);
    assert.notEqual(before.node_access.split(':')[0], '0');
    graphKinds(db, INTERNAL);
    const nodes = everyNode(db);
    everyEdge(db);
    for (const one of nodes) {
      graphNode(db, INTERNAL, one.id);
      graphNeighbors(db, INTERNAL, { ...HISTORICAL, node: one.id, direction: 'both', limit: 5, cursor: null });
    }
    walkAll(db, [node('a')], { request: HISTORICAL, direction: 'both' });
    graphPath(db, INTERNAL, { ...HISTORICAL, from: node('a'), to: node('beyond'), direction: 'both', maxDepth: 9 });
    assert.deepEqual(databaseDigest(db), before);
  } finally {
    reader.close();
  }
});
