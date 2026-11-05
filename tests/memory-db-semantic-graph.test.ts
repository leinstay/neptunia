// The graph projection of semantic assertions, stage S5. An entity is a node, each reference argument of a version is a
// `has_role` edge from the version's node, and a binary relation also gets a navigation shortcut: `asserts` when positive,
// `denies` when negative, `graph_edges.evidence_id` naming the exact version. The tests walk through the public traversal
// (graph.ts#walk) under issued contexts, so what a context cannot reach here it cannot discover. Each adversarial test
// first proves the private edge through the internal context. Synthetic content only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NODE_KINDS, PREDICATES } from '../src/memory/db/graph-manifest.ts';
import { graphNodeId, rebuildGraph, walk } from '../src/memory/db/graph.ts';
import type { Context } from '../src/memory/db/scope.ts';
import {
  ALEX,
  KAI,
  MIRA,
  addEntity,
  addSource,
  commit,
  occurrence,
  partOf,
  semanticWorld,
  successor,
  worksOn,
} from './fixtures/memory-db/semantic-world.ts';
import type { World } from './fixtures/memory-db/semantic-world.ts';

const entityNode = (id: string): string => graphNodeId('semantic_entity', id);
const personNode = (id: string): string => graphNodeId('person', id);
const versionNode = (id: string): string => graphNodeId('claim_version', id);
const written = (result: object): { claimId: string; versionId: string } =>
  result as { claimId: string; versionId: string };

function reached(
  world: World,
  ctx: Context,
  from: string,
  predicates: Array<string>,
  direction: 'out' | 'in' | 'both' = 'both'
): Array<string> {
  return walk(world.db, ctx, { from, predicates, direction, maxDepth: 1, maxRows: 100 })
    .rows.map((row) => String(row.node))
    .filter((node) => node !== from)
    .sort();
}
const edgesOf = (world: World, versionId: string) =>
  world.db
    .prepare(
      'SELECT predicate, src, dst, audience_id, retired_at FROM graph_edges WHERE evidence_id = ? ORDER BY predicate, src, dst'
    )
    .all(versionId)
    .map((row) => ({ ...row }));
const liveEdges = (world: World, versionId: string) =>
  edgesOf(world, versionId).filter((row) => row.retired_at === null);

test('the manifest declares the entity node and the three semantic edges', () => {
  // Bug: a projected kind is absent from the manifest, so the owner's inventory reports it as nothing.
  assert.ok(NODE_KINDS.semantic_entity);
  for (const predicate of ['has_role', 'asserts', 'denies']) {
    assert.ok((PREDICATES as Record<string, unknown>)[predicate], `${predicate} is not in the manifest`);
  }
});

test('a relation projects one role edge per reference and one shortcut, all naming its exact version', () => {
  // Bug: a shortcut with no version cannot open the assertion, its evidence or its audience.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'Alex works on Lumen');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const fact = written(commit(world, worksOn(ALEX, entityId, [source])));
  assert.deepEqual(
    edgesOf(world, fact.versionId).map((row) => [row.predicate, row.src, row.dst]),
    [
      ['asserts', personNode(ALEX), entityNode(entityId)],
      ['has_role', versionNode(fact.versionId), entityNode(entityId)],
      ['has_role', versionNode(fact.versionId), personNode(ALEX)],
    ]
  );
  world.handle.close();
});

test('an entity with a name and no relation is still a node its own audience can reach', () => {
  // Bug: only related entities project, and an isolated identity vanishes from navigation.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'we call it Lumen');
  const lumen = addEntity(world, 'project', 'Lumen', [source]);
  assert.deepEqual(reached(world, world.contexts.group, entityNode(lumen.entityId), ['has_role']), [
    versionNode(lumen.versionId),
  ]);
  world.handle.close();
});

test('public and DM assertions with identical endpoints and predicate stay two witnesses', () => {
  // Bug: deduplicating by endpoint and predicate lets one audience inherit the other's witness.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'Alex works on Lumen');
  const secret = addSource(world, 'alex', 'I work on Lumen, between us');
  const { entityId } = addEntity(world, 'project', 'Lumen', [open]);
  const pub = written(commit(world, worksOn(ALEX, entityId, [open])));
  const dm = written(commit(world, worksOn(ALEX, entityId, [secret]), world.contexts.alex));
  const shortcut = (versionId: string) => liveEdges(world, versionId).filter((row) => row.predicate === 'asserts');
  assert.equal(shortcut(pub.versionId).length, 1);
  assert.equal(shortcut(dm.versionId).length, 1);
  assert.notEqual(shortcut(pub.versionId)[0]?.audience_id, shortcut(dm.versionId)[0]?.audience_id);
  world.handle.close();
});

test('two conflicting current versions of different claims both remain as witnesses', () => {
  // Bug: a later assertion overwrites an earlier one at the same endpoints, and a dispute disappears.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'Alex works on Lumen');
  const other = addSource(world, 'public', 'no he does not');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const said = written(commit(world, worksOn(ALEX, entityId, [source])));
  const disputed = written(commit(world, worksOn(ALEX, entityId, [other], { state: 'disputed' })));
  assert.equal(liveEdges(world, said.versionId).length, 3);
  assert.equal(liveEdges(world, disputed.versionId).length, 3);
  world.handle.close();
});

test('a negative relation projects a denial and no affirmative shortcut', () => {
  // Bug: "Alex did not attend" reads as an attendance edge in every later traversal.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'Alex is not on Lumen');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const fact = written(commit(world, worksOn(ALEX, entityId, [source], { polarity: 'negative' })));
  const predicates = edgesOf(world, fact.versionId).map((row) => row.predicate);
  assert.ok(predicates.includes('denies'));
  assert.ok(!predicates.includes('asserts'));
  assert.deepEqual(reached(world, world.contexts.group, personNode(ALEX), ['asserts']), []);
  world.handle.close();
});

test('an n-ary event keeps its version as the hub and projects no pairwise shortcut', () => {
  // Bug: pairwise edges replace the joint assertion, so a role reads as an independent fact.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'Alex organized Orbis and Mira spoke');
  const event = addEntity(world, 'event', 'Orbis meeting', [source]);
  const fact = written(commit(world, occurrence(event.entityId, { organizer: [ALEX], speaker: [MIRA] }, [source])));
  const edges = edgesOf(world, fact.versionId);
  assert.ok(edges.every((row) => row.predicate === 'has_role' && row.src === versionNode(fact.versionId)));
  assert.deepEqual(
    edges.map((row) => row.dst).sort(),
    [entityNode(event.entityId), personNode(ALEX), personNode(MIRA)].sort()
  );
  world.handle.close();
});

test('one person in two roles of one event makes two role edges', () => {
  // Bug: the edge's identity leaves out role and position, so the second role silently collapses into the first.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'Alex organized Orbis and spoke');
  const event = addEntity(world, 'event', 'Orbis meeting', [source]);
  const fact = written(commit(world, occurrence(event.entityId, { organizer: [ALEX], speaker: [ALEX] }, [source])));
  assert.equal(edgesOf(world, fact.versionId).filter((row) => row.dst === personNode(ALEX)).length, 2);
  world.handle.close();
});

// ---- audiences -------------------------------------------------------------------------------------------------------

test('a public hub with a private incident fact shows a group only the public neighbour', () => {
  // Bug: a visible endpoint authorizes the edge, and the private neighbour is found through the public entity.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'Alex works on Lumen');
  const secret = addSource(world, 'alex', 'Mira works on Lumen too, quietly');
  const { entityId } = addEntity(world, 'project', 'Lumen', [open]);
  commit(world, worksOn(ALEX, entityId, [open]));
  commit(world, worksOn(MIRA, entityId, [secret]), world.contexts.alex);
  const from = entityNode(entityId);
  assert.deepEqual(
    reached(world, world.contexts.internal, from, ['asserts']),
    [personNode(ALEX), personNode(MIRA)].sort()
  );
  assert.deepEqual(reached(world, world.contexts.group, from, ['asserts']), [personNode(ALEX)]);
  assert.deepEqual(reached(world, world.contexts.mira, from, ['asserts']), [personNode(ALEX)]);
  assert.deepEqual(reached(world, world.contexts.groups, from, ['asserts']), [personNode(ALEX)]);
  world.handle.close();
});

test('a private version node gives a group no role edge and no access witness', () => {
  // Bug: the node is projected with its parent's audience, so a group can open a private version by id.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'one');
  const secret = addSource(world, 'alex', 'between us');
  const { entityId } = addEntity(world, 'project', 'Lumen', [open]);
  const dm = written(commit(world, worksOn(MIRA, entityId, [secret]), world.contexts.alex));
  const node = versionNode(dm.versionId);
  assert.ok(reached(world, world.contexts.internal, node, ['has_role'], 'out').length > 0);
  assert.deepEqual(reached(world, world.contexts.group, node, ['has_role'], 'out'), []);
  const access = world.db
    .prepare('SELECT audience_id FROM node_access WHERE node_id = ?')
    .all(node)
    .map((row) => row.audience_id);
  assert.ok(access.length > 0);
  assert.ok(access.every((audience) => String(audience).startsWith('aud:dm:')));
  world.handle.close();
});

test('an entity known only privately has no group witness on its node', () => {
  // Bug: the entity node is public by default, and its existence shows in every inventory.
  const world = semanticWorld();
  const secret = addSource(world, 'alex', 'a private project');
  const hidden = addEntity(world, 'project', 'Hidden', [secret], world.contexts.alex);
  const access = world.db
    .prepare('SELECT audience_id FROM node_access WHERE node_id = ?')
    .all(entityNode(hidden.entityId))
    .map((row) => row.audience_id);
  assert.ok(access.length > 0);
  assert.ok(access.every((audience) => String(audience).startsWith('aud:dm:')));
  world.handle.close();
});

// ---- retirement and rebuild ------------------------------------------------------------------------------------------

test('a successor retires the witnesses of its own base and of no other claim', () => {
  // Bug: retiring by endpoint and predicate removes a separately justified assertion of the same pair.
  const world = semanticWorld();
  const one = addSource(world, 'public', 'one');
  const two = addSource(world, 'public', 'two');
  const { entityId } = addEntity(world, 'project', 'Lumen', [one]);
  const first = written(commit(world, worksOn(ALEX, entityId, [one])));
  const second = written(commit(world, worksOn(ALEX, entityId, [two])));
  const gone = written(commit(world, worksOn(ALEX, entityId, [one], successor(first, { state: 'retired' }))));
  assert.deepEqual(liveEdges(world, first.versionId), []);
  assert.equal(liveEdges(world, second.versionId).length, 3);
  assert.equal(liveEdges(world, gone.versionId).filter((row) => row.predicate === 'asserts').length, 0);
  world.handle.close();
});

test('a retired version stays openable through its own node and evidence', () => {
  // Bug: retirement deletes the node, so history and evidence cannot be inspected.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const first = written(commit(world, worksOn(ALEX, entityId, [source])));
  commit(world, worksOn(ALEX, entityId, [source], successor(first, { state: 'retired' })));
  assert.equal(
    world.db.prepare('SELECT COUNT(*) AS n FROM graph_nodes WHERE id = ?').get(versionNode(first.versionId))?.n,
    1
  );
  assert.ok(edgesOf(world, first.versionId).length > 0, 'its edges keep their retirement time');
  world.handle.close();
});

test('a rebuild regenerates the same semantic graph from typed authority', () => {
  // Bug: a semantic edge exists only because of the incremental path, and a rebuild loses memory's navigation.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'one');
  const secret = addSource(world, 'alex', 'between us');
  const { entityId } = addEntity(world, 'project', 'Lumen', [open]);
  const event = addEntity(world, 'event', 'Orbis', [open]);
  const first = written(commit(world, worksOn(ALEX, entityId, [open])));
  commit(world, worksOn(ALEX, entityId, [open], successor(first, { polarity: 'negative' })));
  commit(world, worksOn(MIRA, entityId, [secret]), world.contexts.alex);
  commit(world, occurrence(event.entityId, { attendee: [ALEX, MIRA, KAI] }, [open]));
  const shape = () => ({
    edges: world.db
      .prepare(
        "SELECT projection_key, predicate, src, dst, audience_id, evidence_id, retired_at IS NOT NULL AS retired FROM graph_edges WHERE predicate IN ('has_role', 'asserts', 'denies') ORDER BY projection_key"
      )
      .all()
      .map((row) => ({ ...row })),
    access: world.db
      .prepare(
        "SELECT node_id, audience_id, evidence_id FROM node_access WHERE node_id LIKE 'semantic_entity:%' OR node_id LIKE 'claim_version:%' ORDER BY 1, 2, 3"
      )
      .all()
      .map((row) => ({ ...row })),
  });
  const before = shape();
  assert.ok(before.edges.length > 0);
  rebuildGraph(world.handle, {});
  assert.deepEqual(shape(), before);
  world.handle.close();
});

test('a cycle of part-of relations ends a walk', () => {
  // Bug: A in B in A loops the traversal until its row cap and hides everything else.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const a = addEntity(world, 'concept', 'A', [source]);
  const b = addEntity(world, 'concept', 'B', [source]);
  commit(world, partOf(a.entityId, b.entityId, [source]));
  commit(world, partOf(b.entityId, a.entityId, [source]));
  const { rows, truncated } = walk(world.db, world.contexts.group, {
    from: entityNode(a.entityId),
    predicates: ['asserts'],
    direction: 'out',
    maxDepth: 10,
    maxRows: 100,
  });
  assert.equal(truncated, false);
  assert.equal(new Set(rows.map((row) => row.node)).size, rows.length);
  world.handle.close();
});
