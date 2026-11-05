// The one bounded retrieval service, stage S7: `retrieveMemory` turns a query and explicit anchors into versioned
// assertions, evidence, source ids and association paths under an issued context, within one shared budget. A path is an
// association and never a new fact, ambiguity stays visible, a plain source with no entity stays findable, and a bound that
// stops the work says so. Every page is searched whole for a secret word, so a hidden edge fails however it leaks. Real
// temporary databases, an injected clock and a fake query embedding; no model runs here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb, MIGRATIONS } from '../src/memory/db/open.ts';
import { pageReads, retrieveMemory } from '../src/memory/db/retrieve.ts';
import type { RetrieveDeps } from '../src/memory/db/retrieve.ts';
import type { Context } from '../src/memory/db/scope.ts';
import { groupContext } from '../src/memory/db/scope.ts';
import type { MemoryPage, MemoryQuery, RetrievalBounds } from '../src/memory/db/semantic-types.ts';
import { turnReadRows } from '../src/memory/db/service.ts';
import { writeTurnReadRows } from '../src/memory/db/session-write.ts';
import { SKILL_DEFINITIONS } from '../src/tools/definitions.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { estimateTokens } from '../src/llm/tokens.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { tempDir } from './fixtures/tmp.ts';
import {
  ALEX,
  KAI,
  MIRA,
  START,
  addEntity,
  addSource,
  candidate,
  commit,
  occurrence,
  partOf,
  semanticWorld,
  successor,
  worksOn,
} from './fixtures/memory-db/semantic-world.ts';
import type { World } from './fixtures/memory-db/semantic-world.ts';

const SECRET = 'xylophonewhisper';
const BOUNDS: RetrievalBounds = {
  seeds: 4,
  hops: 2,
  nodes: 20,
  edges: 60,
  assertions: 12,
  evidence: 24,
  tokens: 2000,
  deadlineMs: 1000,
};
const query = (text: string, change: Partial<MemoryQuery> = {}): MemoryQuery => ({
  text,
  anchors: [],
  predicates: [],
  validAt: null,
  recordedBefore: null,
  includeHistorical: false,
  purpose: 'search',
  bounds: BOUNDS,
  cursor: null,
  ...change,
});
const deps = (change: Partial<RetrieveDeps> = {}): RetrieveDeps => ({
  now: () => START,
  embedQuery: null,
  model: null,
  ...change,
});
const written = (result: object): { claimId: string; versionId: string } =>
  result as { claimId: string; versionId: string };
const versionsOf = (page: MemoryPage): Array<string> => page.assertions.map((one) => one.versionId);
const entityAnchor = (id: string) => ({ kind: 'entity' as const, id });
const personAnchor = (id: string) => ({ kind: 'person' as const, id });
const retrieve = (world: World, ctx: Context, given: MemoryQuery, change: Partial<RetrieveDeps> = {}) =>
  retrieveMemory(world.db, ctx, given, deps(change));

// ---- seeds, neighbours and paths -------------------------------------------------------------------------------------

test('a name in the query seeds its entity and brings the facts next to it, with their evidence', async () => {
  // Bug: recall finds the words of the label and stops, so what is known about the project stays unread.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'Alex works on Lumen');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const fact = written(commit(world, worksOn(ALEX, entityId, [source])));
  const page = await retrieve(world, world.contexts.group, query('tell me about lumen'));
  const found = page.assertions.find((one) => one.versionId === fact.versionId);
  assert.ok(found, 'the neighbouring fact was not retrieved');
  assert.deepEqual(found.evidence, [{ sourceId: source, role: 'supports' }]);
  assert.deepEqual(found.arguments.map((one) => one.role).sort(), ['person', 'project']);
  assert.deepEqual([found.state, found.polarity, found.needsReview], ['current', 'positive', false]);
  world.handle.close();
});

test('an explicit anchor reaches its facts with no text at all', async () => {
  // Bug: a heartbeat or a task with no query words gets nothing even though it names a person.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const fact = written(commit(world, worksOn(ALEX, entityId, [source])));
  const page = await retrieve(world, world.contexts.group, query('', { anchors: [personAnchor(ALEX)] }));
  assert.ok(versionsOf(page).includes(fact.versionId));
  world.handle.close();
});

test('a two-hop path comes back as an association with its exact versions and writes no new fact', async () => {
  // Bug: reachability is stored or shown as if Alex were part of Orbis.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const lumen = addEntity(world, 'project', 'Lumen', [source]);
  const orbis = addEntity(world, 'concept', 'Orbis', [source]);
  const first = written(commit(world, worksOn(ALEX, lumen.entityId, [source])));
  const second = written(commit(world, partOf(lumen.entityId, orbis.entityId, [source])));
  const claims = world.db.prepare('SELECT COUNT(*) AS n FROM claims').get()?.n;
  const page = await retrieve(world, world.contexts.group, query('', { anchors: [personAnchor(ALEX)] }));
  const pathTo = page.paths.find((one) => one.to.id === orbis.entityId);
  assert.deepEqual(pathTo, {
    from: personAnchor(ALEX),
    to: entityAnchor(orbis.entityId),
    versionIds: [first.versionId, second.versionId],
  });
  assert.equal(world.db.prepare('SELECT COUNT(*) AS n FROM claims').get()?.n, claims);
  assert.ok(page.assertions.every((one) => one.arguments.length > 0 && one.versionId));
  world.handle.close();
});

test('a depth bound stops at its hop, says so, and a cursor continues from the frontier', async () => {
  // Bug: a limit silently hides the rest of the component, with no way to ask for more.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const lumen = addEntity(world, 'project', 'Lumen', [source]);
  const orbis = addEntity(world, 'concept', 'Orbis', [source]);
  commit(world, worksOn(ALEX, lumen.entityId, [source]));
  const far = written(commit(world, partOf(lumen.entityId, orbis.entityId, [source])));
  const given = query('', { anchors: [personAnchor(ALEX)], bounds: { ...BOUNDS, hops: 1 } });
  const first = await retrieve(world, world.contexts.group, given);
  assert.equal(first.partialReason, 'depth');
  assert.ok(!versionsOf(first).includes(far.versionId));
  const second = await retrieve(world, world.contexts.group, { ...given, cursor: first.next });
  assert.ok(versionsOf(second).includes(far.versionId));
  assert.deepEqual(
    versionsOf(second).filter((id) => versionsOf(first).includes(id)),
    []
  );
  world.handle.close();
});

test('a query with no words and no anchors returns an empty page and no partial mark', async () => {
  // Bug: an empty query reads the whole graph, or an empty page reads as a failure.
  const world = semanticWorld();
  addEntity(world, 'project', 'Lumen', [addSource(world, 'public', 'one')]);
  const page = await retrieve(world, world.contexts.group, query('   '));
  assert.deepEqual(
    [page.assertions, page.sourceIds, page.paths, page.next, page.partialReason],
    [[], [], [], null, null]
  );
  world.handle.close();
});

test('an anchor nobody stored finds nothing and fails nothing', async () => {
  // Bug: a stale reference throws inside a turn's prefetch.
  const world = semanticWorld();
  const page = await retrieve(world, world.contexts.group, query('', { anchors: [entityAnchor('ent:gone')] }));
  assert.deepEqual(page.assertions, []);
  world.handle.close();
});

test('a read with no context is refused', async () => {
  // Bug: a missing context reads every audience.
  const world = semanticWorld();
  await assert.rejects(() => retrieve(world, wrongly<Context>(null), query('lumen')), /context/);
  world.handle.close();
});

test('retrieval runs on a read-only connection', async () => {
  // Bug: a reader writes a read record or a cache row, and memory has a second writer.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  addEntity(world, 'project', 'Lumen', [source]);
  const reader = openMemoryDb(world.file, { readOnly: true });
  const page = await retrieveMemory(dbOf(reader), world.contexts.group, query('lumen'), deps());
  assert.equal(page.assertions.length > 0, true);
  reader.close();
  world.handle.close();
});

// ---- audiences -------------------------------------------------------------------------------------------------------

/** A public hub with a private fact: one public neighbour, one secret neighbour, one secret line and a secret alias. */
function hubWithPrivateFacts() {
  const world = semanticWorld();
  const open = addSource(world, 'public', 'Alex works on Lumen');
  const hidden = addSource(world, 'alex', `Mira and Lumen, ${SECRET}`);
  const lumen = addEntity(world, 'project', 'Lumen', [open]);
  const pub = written(commit(world, worksOn(ALEX, lumen.entityId, [open])));
  const dm = written(
    commit(world, worksOn(MIRA, lumen.entityId, [hidden], { text: `private ${SECRET}` }), world.contexts.alex)
  );
  commit(
    world,
    candidate(
      'entity.label',
      'label',
      [
        { role: 'entity', position: 0, ref: entityAnchor(lumen.entityId) },
        { role: 'alias', position: 0, literal: SECRET },
        { role: 'language', position: 0, literal: 'en' },
      ],
      [hidden],
      { text: `also called ${SECRET}` }
    ),
    world.contexts.alex
  );
  return { world, lumen, pub, dm, hidden };
}

test('a public hub shows a group only its visible fact, whichever way the page is read', async () => {
  // Bug: a visible endpoint authorizes an edge, and a private fact leaks as text, evidence, a path or an id.
  const { world, lumen, pub, dm, hidden } = hubWithPrivateFacts();
  const given = query('lumen', { anchors: [entityAnchor(lumen.entityId)] });
  assert.ok(versionsOf(await retrieve(world, world.contexts.internal, given)).includes(dm.versionId));
  const page = await retrieve(world, world.contexts.group, given);
  const whole = JSON.stringify(page);
  assert.ok(versionsOf(page).includes(pub.versionId));
  assert.ok(!whole.includes(dm.versionId));
  assert.ok(!whole.includes(dm.claimId));
  assert.ok(!whole.includes(hidden));
  assert.ok(!whole.includes(SECRET));
  assert.ok(!whole.includes(MIRA));
  world.handle.close();
});

for (const [who, pick] of [
  ['another DM partner', (world: World) => world.contexts.mira],
  ["the diary's context", (world: World) => world.contexts.groups],
  ['a plain group context not issued by the core', () => groupContext('discord')],
] as const) {
  test(`${who} finds no private fact of a public hub`, async () => {
    // Bug: the filter separates public from private but lets every private reader read every DM.
    const { world, lumen, dm } = hubWithPrivateFacts();
    const page = await retrieve(world, pick(world), query('lumen', { anchors: [entityAnchor(lumen.entityId)] }));
    const whole = JSON.stringify(page);
    assert.ok(!whole.includes(dm.versionId));
    assert.ok(!whole.includes(SECRET));
    world.handle.close();
  });
}

test('the DM partner reads their own private fact beside the public one', async () => {
  // Bug: an over-tight filter hides a person's own memory in their own conversation.
  const { world, lumen, pub, dm } = hubWithPrivateFacts();
  const page = await retrieve(world, world.contexts.alex, query('lumen', { anchors: [entityAnchor(lumen.entityId)] }));
  assert.ok(versionsOf(page).includes(pub.versionId));
  assert.ok(versionsOf(page).includes(dm.versionId));
  world.handle.close();
});

test('a private alias seeds nothing for a group and nothing shows it was searched', async () => {
  // Bug: an alias match opens the entity, so typing a guess confirms a private nickname.
  const { world } = hubWithPrivateFacts();
  const page = await retrieve(world, world.contexts.group, query(SECRET));
  assert.deepEqual([page.assertions, page.sourceIds, page.paths], [[], [], []]);
  assert.deepEqual(page.ambiguous, []);
  world.handle.close();
});

test('a path through a private edge does not exist for a group', async () => {
  // Bug: both ends are public, so the hidden link between them is discoverable by reachability.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'one');
  const hidden = addSource(world, 'alex', 'between us');
  const a = addEntity(world, 'concept', 'A', [open]);
  const b = addEntity(world, 'concept', 'B', [open]);
  const c = addEntity(world, 'concept', 'C', [open]);
  commit(world, partOf(a.entityId, b.entityId, [hidden]), world.contexts.alex);
  commit(world, partOf(b.entityId, c.entityId, [open]));
  const page = await retrieve(
    world,
    world.contexts.group,
    query('', { anchors: [entityAnchor(a.entityId)], bounds: { ...BOUNDS, hops: 3 } })
  );
  assert.deepEqual(page.paths, []);
  assert.ok(!JSON.stringify(page).includes(c.entityId));
  const internal = await retrieve(
    world,
    world.contexts.internal,
    query('', { anchors: [entityAnchor(a.entityId)], bounds: { ...BOUNDS, hops: 3 } })
  );
  assert.ok(internal.paths.some((one) => one.to.id === c.entityId));
  world.handle.close();
});

test('an anchor to a private entity gives a group nothing', async () => {
  // Bug: a model that knows or guesses an id opens the entity past its audience.
  const world = semanticWorld();
  const hidden = addSource(world, 'alex', 'a private project');
  const entity = addEntity(world, 'project', 'Hidden', [hidden], world.contexts.alex);
  const page = await retrieve(world, world.contexts.group, query('', { anchors: [entityAnchor(entity.entityId)] }));
  assert.deepEqual([page.assertions, page.paths], [[], []]);
  world.handle.close();
});

test('a revoked link stops a person-wide private read in a newly issued context', async () => {
  // Bug: a context's linked DMs are read once and a revoked account keeps its partner's facts.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'one');
  const hidden = addSource(world, 'mira', `${SECRET} from Mira`);
  const { entityId } = addEntity(world, 'project', 'Lumen', [open]);
  commit(world, worksOn(MIRA, entityId, [hidden], { text: `Mira ${SECRET}` }), world.contexts.mira);
  const given = query('lumen', { anchors: [entityAnchor(entityId)] });
  const linked = { ...world.contexts.alex, linked: [{ iface: 'discord', person: MIRA, place: 'place:dm-mira' }] };
  assert.ok(JSON.stringify(await retrieve(world, linked, given)).includes(SECRET));
  assert.ok(!JSON.stringify(await retrieve(world, world.contexts.alex, given)).includes(SECRET));
  world.handle.close();
});

test('fields a caller adds to the query change no authority and pick no destination', async () => {
  // Bug: a model argument that reaches the query widens the read or chooses where the answer goes.
  const { world, lumen } = hubWithPrivateFacts();
  const widened = {
    ...query('lumen', { anchors: [entityAnchor(lumen.entityId)] }),
    context: world.contexts.internal,
    internal: true,
    audience: 'aud:internal',
    destination: 'place:dm-alex',
  };
  const page = await retrieve(world, world.contexts.group, widened);
  assert.ok(!JSON.stringify(page).includes(SECRET));
  const keys = new Set<string>();
  JSON.stringify(page, (key, value: unknown) => {
    keys.add(key);
    return value;
  });
  for (const word of ['destination', 'target', 'placeId', 'channel', 'audience']) assert.ok(!keys.has(word), word);
  world.handle.close();
});

test('a cursor from a private reader is refused for a group', async () => {
  // Bug: a cursor carries the private reader's position and widens the next page.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  for (let index = 0; index < 4; index += 1)
    commit(world, worksOn(ALEX, entityId, [source], { text: `fact ${index}` }));
  const given = query('', { anchors: [entityAnchor(entityId)], bounds: { ...BOUNDS, assertions: 1 } });
  const first = await retrieve(world, world.contexts.alex, given);
  await assert.rejects(() => retrieve(world, world.contexts.group, { ...given, cursor: first.next }), /CURSOR_INVALID/);
  world.handle.close();
});

test('a cursor for another query or a forged one is refused, and an expired one says so', async () => {
  // Bug: a bound page continues under other filters, or a stale cursor silently returns the wrong rows.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  for (let index = 0; index < 4; index += 1)
    commit(world, worksOn(ALEX, entityId, [source], { text: `fact ${index}` }));
  const given = query('', { anchors: [entityAnchor(entityId)], bounds: { ...BOUNDS, assertions: 1 } });
  const first = await retrieve(world, world.contexts.group, given);
  await assert.rejects(
    () => retrieve(world, world.contexts.group, { ...given, text: 'other', cursor: first.next }),
    /CURSOR_INVALID/
  );
  await assert.rejects(() => retrieve(world, world.contexts.group, { ...given, cursor: 'forged' }), /CURSOR_INVALID/);
  commit(world, worksOn(MIRA, entityId, [source]));
  await assert.rejects(() => retrieve(world, world.contexts.group, { ...given, cursor: first.next }), /CURSOR_EXPIRED/);
  world.handle.close();
});

// ---- ambiguity and the source fallback -------------------------------------------------------------------------------

test('a shared name stays ambiguous, with both projects offered and neither chosen', async () => {
  // Bug: the more connected project wins and its facts are answered for the other.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const a = addEntity(world, 'project', 'Lumen', [source]);
  const b = addEntity(world, 'project', 'Lumen', [source]);
  for (let index = 0; index < 5; index += 1)
    commit(world, worksOn(ALEX, a.entityId, [source], { text: `fact ${index}` }));
  const page = await retrieve(world, world.contexts.group, query('lumen'));
  assert.equal(page.ambiguous.length, 1);
  assert.deepEqual(page.ambiguous[0]?.candidates.map((one) => one.id).sort(), [a.entityId, b.entityId].sort());
  assert.ok(versionsOf(page).includes(b.versionId), 'the less connected project was dropped');
  world.handle.close();
});

test('a plain source with no entity is found by its words', async () => {
  // Bug: the semantic path replaces recall, and everything said before it existed is gone.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'the harmonica broke in the rain');
  const page = await retrieve(world, world.contexts.group, query('harmonica'));
  assert.deepEqual(page.sourceIds, [source]);
  assert.deepEqual(page.assertions, []);
  assert.equal(page.partialReason, null);
  world.handle.close();
});

test('semantic additions cannot hide an older plain source', async () => {
  // Bug: new labels fill the shared budget and the older line stops being returned.
  const world = semanticWorld();
  const old = addSource(world, 'public', 'the harmonica broke in the rain');
  const given = query('harmonica', { bounds: { ...BOUNDS, assertions: 2, tokens: 200 } });
  assert.deepEqual((await retrieve(world, world.contexts.group, given)).sourceIds, [old]);
  const other = addSource(world, 'public', 'plain');
  for (let index = 0; index < 15; index += 1) addEntity(world, 'object', `Harmonica ${index}`, [other]);
  const page = await retrieve(world, world.contexts.group, given);
  assert.ok(page.sourceIds.includes(old));
  assert.ok(page.assertions.length <= 2);
  world.handle.close();
});

test('a private source stays out of a group page and in its partner page', async () => {
  // Bug: the source stream takes the context from the turn and the semantic stream from the query.
  const world = semanticWorld();
  const hidden = addSource(world, 'alex', `the ${SECRET} plan`);
  assert.deepEqual((await retrieve(world, world.contexts.alex, query(SECRET))).sourceIds, [hidden]);
  assert.deepEqual((await retrieve(world, world.contexts.group, query(SECRET))).sourceIds, []);
  assert.deepEqual((await retrieve(world, world.contexts.mira, query(SECRET))).sourceIds, []);
  world.handle.close();
});

test('a fact from before the semantic tables is found, its unknown metadata left unknown', async () => {
  // Bug: a reader fills truth and polarity from the mutable parent, inventing certainty the old row never had.
  const file = path.join(tempDir('nep-retrieve-'), 'memory.db');
  const old = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 29) });
  const oldDb = dbOf(old);
  oldDb.exec(`INSERT OR IGNORE INTO audiences (id, kind, iface) VALUES ('aud:group:discord', 'group', 'discord');
    INSERT INTO claims (id, subject_kind, subject_id, kind, text, truth, shown, scope_kind, scope_iface, audience_id, created_at)
      VALUES ('clm:old', 'person', 'person:x', 'detail', 'the zebra stayed', 'current', 1, 'group', 'discord', 'aud:group:discord', '2026-01-01T00:00:00.000Z');
    INSERT INTO claim_versions (id, claim_id, revision_id, text, recorded_at, event, by, origin)
      VALUES ('cv:old', 'clm:old', 'rv:old', 'the zebra stayed', '2026-01-01T00:00:00.000Z', 'add', 'her', 'session');`);
  old.close();
  const handle = openMemoryDb(file);
  const page = await retrieveMemory(
    dbOf(handle),
    { iface: 'discord', kind: 'group', audienceColumn: true },
    query('zebra'),
    deps()
  );
  const found = page.assertions.find((one) => one.versionId === 'cv:old');
  assert.ok(found, 'the old fact was not retrieved');
  assert.deepEqual([found.text, found.state, found.polarity], ['the zebra stayed', 'unknown', 'unknown']);
  handle.close();
});

test('an embedding failure leaves lexical results and no failure mark', async () => {
  // Bug: a provider outage empties her memory for the turn.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const lumen = addEntity(world, 'project', 'Lumen', [source]);
  const page = await retrieve(world, world.contexts.group, query('lumen'), {
    embedQuery: () => Promise.reject(new Error('embedding provider down')),
    model: 'fixture/embedding',
  });
  assert.ok(versionsOf(page).includes(lumen.versionId));
  assert.equal(page.partialReason, null);
  world.handle.close();
});

test('a query is embedded at most once and nothing else is asked of a model', async () => {
  // Bug: a graph walk pays for a planner call or embeds each seed.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  addEntity(world, 'project', 'Lumen', [source]);
  let asked = 0;
  await retrieve(world, world.contexts.group, query('lumen'), {
    embedQuery: () => {
      asked += 1;
      return Promise.resolve([1, 0, 0, 0]);
    },
    model: 'fixture/embedding',
  });
  assert.equal(asked, 1);
  world.handle.close();
});

// ---- bounds ----------------------------------------------------------------------------------------------------------

function hub(world: World, facts: number) {
  const source = addSource(world, 'public', 'one');
  const entity = addEntity(world, 'concept', 'Hub', [source]);
  for (let index = 0; index < facts; index += 1) {
    commit(world, worksOn(index % 2 === 0 ? ALEX : MIRA, entity.entityId, [source], { text: `hub fact ${index}` }));
  }
  return { source, entity };
}

const BOUND_CASES: ReadonlyArray<[keyof RetrievalBounds, MemoryPage['partialReason'], number]> = [
  ['assertions', 'assertions', 3],
  ['edges', 'edges', 3],
  ['nodes', 'nodes', 1],
];

for (const [bound, reason, value] of BOUND_CASES) {
  test(`a hub stops at its ${String(bound)} bound, says so, and a cursor continues`, async () => {
    // Bug: a high-degree entity loads its whole component into one prompt or heap.
    const world = semanticWorld();
    const { entity } = hub(world, 20);
    const given = query('', { anchors: [entityAnchor(entity.entityId)], bounds: { ...BOUNDS, [bound]: value } });
    const page = await retrieve(world, world.contexts.group, given);
    assert.equal(page.partialReason, reason);
    assert.ok(page.assertions.length <= (bound === 'assertions' ? value : 20));
    const more = await retrieve(world, world.contexts.group, { ...given, cursor: page.next });
    assert.ok(versionsOf(more).some((id) => !versionsOf(page).includes(id)));
    world.handle.close();
  });
}

test('the evidence bound counts every returned reference', async () => {
  // Bug: one assertion with many sources spends the whole prompt.
  const world = semanticWorld();
  const sources = Array.from({ length: 6 }, (_, index) => addSource(world, 'public', `line ${index}`));
  const { entityId } = addEntity(world, 'project', 'Lumen', [sources[0]]);
  commit(world, worksOn(ALEX, entityId, sources));
  const page = await retrieve(
    world,
    world.contexts.group,
    query('', { anchors: [entityAnchor(entityId)], bounds: { ...BOUNDS, evidence: 2 } })
  );
  assert.equal(page.partialReason, 'evidence');
  assert.ok(page.assertions.flatMap((one) => one.evidence).length <= 2);
  world.handle.close();
});

test('a tokens bound returns whole assertions under it', async () => {
  // Bug: the budget cuts a fact in half, so a joint assertion reads as another claim.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const text = 'a fact with enough words to count against a small budget of tokens';
  const facts = [0, 1, 2, 3].map((index) =>
    written(commit(world, worksOn(ALEX, entityId, [source], { text: `${text} ${index}` })))
  );
  const page = await retrieve(
    world,
    world.contexts.group,
    query('', { anchors: [personAnchor(ALEX)], bounds: { ...BOUNDS, tokens: estimateTokens(text) * 2 } })
  );
  assert.equal(page.partialReason, 'tokens');
  assert.ok(page.assertions.length < facts.length);
  for (const one of page.assertions) assert.match(one.text, new RegExp(`^${text} \\d$`));
  world.handle.close();
});

test('the seeds bound keeps the page to its first seeds and says so', async () => {
  // Bug: every word of a long message seeds a walk.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const anchors = Array.from({ length: 5 }, (_, index) =>
    entityAnchor(addEntity(world, 'project', `P${index}`, [source]).entityId)
  );
  const page = await retrieve(world, world.contexts.group, query('', { anchors, bounds: { ...BOUNDS, seeds: 2 } }));
  assert.equal(page.partialReason, 'seeds');
  world.handle.close();
});

test('two seeds share the budget, and a hub does not spend all of it', async () => {
  // Bug: the first seed's hundred edges leave nothing for the entity the person actually named.
  const world = semanticWorld();
  const { entity, source } = hub(world, 30);
  const small = addEntity(world, 'project', 'Small', [source]);
  const fact = written(commit(world, worksOn(KAI, small.entityId, [source])));
  const page = await retrieve(
    world,
    world.contexts.group,
    query('', {
      anchors: [entityAnchor(entity.entityId), entityAnchor(small.entityId)],
      bounds: { ...BOUNDS, assertions: 4, edges: 12 },
    })
  );
  assert.ok(versionsOf(page).includes(fact.versionId), 'the small seed got no share');
  world.handle.close();
});

test('a cycle ends with each assertion returned once', async () => {
  // Bug: a traversal enumerates paths around the loop until its row cap.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const a = addEntity(world, 'concept', 'A', [source]);
  const b = addEntity(world, 'concept', 'B', [source]);
  commit(world, partOf(a.entityId, b.entityId, [source]));
  commit(world, partOf(b.entityId, a.entityId, [source]));
  const page = await retrieve(
    world,
    world.contexts.group,
    query('', { anchors: [entityAnchor(a.entityId)], bounds: { ...BOUNDS, hops: 8 } })
  );
  assert.equal(new Set(versionsOf(page)).size, versionsOf(page).length);
  assert.equal(page.partialReason, null);
  world.handle.close();
});

test('two paths to one entity keep one copy of each assertion', async () => {
  // Bug: a diamond counts a fact twice and doubles it in the prompt.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const top = addEntity(world, 'concept', 'Top', [source]);
  const left = addEntity(world, 'concept', 'Left', [source]);
  const right = addEntity(world, 'concept', 'Right', [source]);
  const end = addEntity(world, 'concept', 'End', [source]);
  for (const [from, to] of [
    [top, left],
    [top, right],
    [left, end],
    [right, end],
  ]) {
    commit(world, partOf(from.entityId, to.entityId, [source]));
  }
  const page = await retrieve(world, world.contexts.group, query('', { anchors: [entityAnchor(top.entityId)] }));
  assert.equal(new Set(versionsOf(page)).size, versionsOf(page).length);
  assert.equal(page.paths.filter((one) => one.to.id === end.entityId).length, 2);
  world.handle.close();
});

test('a deadline stops expansion and returns the items already complete', async () => {
  // Bug: a slow graph walk blows the prefetch budget, or a half-built assertion reaches the prompt.
  const world = semanticWorld();
  const { entity } = hub(world, 20);
  let clock = START;
  const page = await retrieve(
    world,
    world.contexts.group,
    query('', { anchors: [entityAnchor(entity.entityId)], bounds: { ...BOUNDS, deadlineMs: 5 } }),
    {
      now: () => (clock += 2),
    }
  );
  assert.equal(page.partialReason, 'deadline');
  for (const one of page.assertions) {
    assert.ok(one.text && one.arguments.length > 0 && one.evidence.length > 0);
  }
  world.handle.close();
});

// ---- truth, time and review ------------------------------------------------------------------------------------------

test('a negative assertion comes back negative and never as a plain fact', async () => {
  // Bug: "did not attend" loses its polarity in the render and reads as attendance.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'Alex is not on Lumen');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const fact = written(commit(world, worksOn(ALEX, entityId, [source], { polarity: 'negative' })));
  const page = await retrieve(world, world.contexts.group, query('', { anchors: [personAnchor(ALEX)] }));
  assert.equal(page.assertions.find((one) => one.versionId === fact.versionId)?.polarity, 'negative');
  world.handle.close();
});

test('a disputed fact stays visible beside what contradicts it, each with its own state', async () => {
  // Bug: conflict resolution by rank hides one side, a decision that belongs to the persona.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const one = written(commit(world, worksOn(ALEX, entityId, [source], { state: 'disputed' })));
  const two = written(commit(world, worksOn(ALEX, entityId, [source], { polarity: 'negative', state: 'disputed' })));
  const page = await retrieve(world, world.contexts.group, query('', { anchors: [personAnchor(ALEX)] }));
  assert.deepEqual(
    [one.versionId, two.versionId].map((id) => page.assertions.find((row) => row.versionId === id)?.state),
    ['disputed', 'disputed']
  );
  world.handle.close();
});

test('a retired version leaves the ordinary page and returns in historical mode', async () => {
  // Bug: historical mode shows only the current text, or the ordinary read keeps a fact she retired.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const first = written(commit(world, worksOn(ALEX, entityId, [source], { text: 'the old fact' })));
  const gone = written(
    commit(world, worksOn(ALEX, entityId, [source], { ...successor(first), state: 'retired', text: 'no longer so' }))
  );
  const ordinary = versionsOf(
    await retrieve(world, world.contexts.group, query('', { anchors: [personAnchor(ALEX)] }))
  );
  assert.ok(!ordinary.includes(first.versionId));
  assert.ok(!ordinary.includes(gone.versionId));
  const historical = versionsOf(
    await retrieve(world, world.contexts.group, query('', { anchors: [personAnchor(ALEX)], includeHistorical: true }))
  );
  assert.ok(historical.includes(first.versionId));
  assert.ok(historical.includes(gone.versionId));
  world.handle.close();
});

test('a recording cutoff reads the version of that moment', async () => {
  // Bug: "what did I know then" is answered with what she learned since.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const first = written(commit(world, worksOn(ALEX, entityId, [source], { text: 'then' })));
  const at = String(
    world.db.prepare('SELECT recorded_at FROM claim_versions WHERE id = ?').get(first.versionId)?.recorded_at
  );
  const cutoff = new Date(Date.parse(at) + 500).toISOString();
  const second = written(commit(world, worksOn(ALEX, entityId, [source], { ...successor(first), text: 'later' })));
  const page = versionsOf(
    await retrieve(world, world.contexts.group, query('', { anchors: [personAnchor(ALEX)], recordedBefore: cutoff }))
  );
  assert.ok(page.includes(first.versionId));
  assert.ok(!page.includes(second.versionId));
  world.handle.close();
});

test('a validity moment keeps what was true then, apart from when it was recorded', async () => {
  // Bug: validity and recording time are one field, so a fact learned late reads as new.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const past = written(
    commit(
      world,
      worksOn(ALEX, entityId, [source], { validFrom: '2020-01-01T00:00:00.000Z', validTo: '2020-12-31T00:00:00.000Z' })
    )
  );
  const now = written(
    commit(world, worksOn(MIRA, entityId, [source], { validFrom: '2026-01-01T00:00:00.000Z', validTo: null }))
  );
  const page = versionsOf(
    await retrieve(
      world,
      world.contexts.group,
      query('', { anchors: [entityAnchor(entityId)], validAt: '2020-06-01T00:00:00.000Z' })
    )
  );
  assert.ok(page.includes(past.versionId));
  assert.ok(!page.includes(now.versionId));
  world.handle.close();
});

test('a state comes from the version, whatever its parent claim says now', async () => {
  // Bug: a repair or a unit flush of the parent rewrites what a sealed version is reported as.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const fact = written(commit(world, worksOn(ALEX, entityId, [source], { text: 'her words' })));
  world.db.prepare("UPDATE claims SET truth = 'retired', text = 'other' WHERE id = ?").run(fact.claimId);
  const found = (
    await retrieve(world, world.contexts.group, query('', { anchors: [personAnchor(ALEX)], includeHistorical: true }))
  ).assertions.find((one) => one.versionId === fact.versionId);
  assert.deepEqual([found?.state, found?.text], ['current', 'her words']);
  world.handle.close();
});

test('a dependent of a changed premise is flagged and keeps its truth', async () => {
  // Bug: the flag is lost at the read, or the reader demotes the fact on her behalf.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const premise = written(commit(world, worksOn(ALEX, entityId, [source])));
  const inferred = written(
    commit(
      world,
      worksOn(MIRA, entityId, [source], {
        how: 'inferred',
        dependencies: [{ versionId: premise.versionId, role: 'supports' }],
      })
    )
  );
  commit(world, worksOn(ALEX, entityId, [source], { ...successor(premise), state: 'retired' }));
  const found = (
    await retrieve(world, world.contexts.group, query('', { anchors: [personAnchor(MIRA)] }))
  ).assertions.find((one) => one.versionId === inferred.versionId);
  assert.deepEqual(
    [found?.state, found?.needsReview, found?.dependencies],
    ['current', true, [{ versionId: premise.versionId, role: 'supports' }]]
  );
  world.handle.close();
});

test('a retired alias stops seeding and an old cutoff still reads it', async () => {
  // Bug: a name she took back still resolves, or history forgets what it was called.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const lumen = addEntity(world, 'project', 'Lumen', [source]);
  const args = [
    { role: 'entity', position: 0, ref: entityAnchor(lumen.entityId) },
    { role: 'alias', position: 0, literal: 'zeppelin' },
    { role: 'language', position: 0, literal: 'en' },
  ];
  const alias = written(commit(world, candidate('entity.label', 'label', args, [source])));
  const at = String(
    world.db.prepare('SELECT recorded_at FROM claim_versions WHERE id = ?').get(alias.versionId)?.recorded_at
  );
  commit(world, candidate('entity.label', 'label', args, [source], { ...successor(alias), state: 'retired' }));
  assert.deepEqual((await retrieve(world, world.contexts.group, query('zeppelin'))).assertions, []);
  const old = await retrieve(
    world,
    world.contexts.group,
    query('zeppelin', { recordedBefore: new Date(Date.parse(at) + 500).toISOString() })
  );
  assert.ok(versionsOf(old).includes(alias.versionId));
  world.handle.close();
});

test('similarity, hops and an anchor match are reported as separate signals', async () => {
  // Bug: one blended score hides that a result is only near, and she takes a neighbour for an answer.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const lumen = addEntity(world, 'project', 'Lumen', [source]);
  const orbis = addEntity(world, 'concept', 'Orbis', [source]);
  const near = written(commit(world, worksOn(ALEX, lumen.entityId, [source])));
  const far = written(commit(world, partOf(lumen.entityId, orbis.entityId, [source])));
  const page = await retrieve(world, world.contexts.group, query('', { anchors: [personAnchor(ALEX)] }));
  const signal = (id: string) => page.signals.find((one) => one.versionId === id);
  assert.deepEqual(
    [signal(near.versionId)?.hops, signal(near.versionId)?.anchored, signal(near.versionId)?.similarity],
    [1, true, null]
  );
  assert.equal(signal(far.versionId)?.hops, 2);
  assert.equal(signal(far.versionId)?.anchored, false);
  world.handle.close();
});

test('a role in a joint event brings the whole event, never one pair of it', async () => {
  // Bug: expansion returns the speaker edge alone, and the assertion reads as something she never stored.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const event = addEntity(world, 'event', 'Orbis meeting', [source]);
  const fact = written(commit(world, occurrence(event.entityId, { organizer: [ALEX], speaker: [MIRA] }, [source])));
  const found = (
    await retrieve(world, world.contexts.group, query('', { anchors: [personAnchor(MIRA)] }))
  ).assertions.find((one) => one.versionId === fact.versionId);
  assert.deepEqual(found?.arguments.map((one) => one.role).sort(), ['event', 'organizer', 'speaker']);
  world.handle.close();
});

test('a write that lands while the query embedding is out cannot leak or break the page', async () => {
  // Bug: rows read across the await belong to two states, and a private fact written meanwhile slips past the filter.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'one');
  const hidden = addSource(world, 'alex', 'between us');
  const { entityId } = addEntity(world, 'project', 'Lumen', [open]);
  commit(world, worksOn(ALEX, entityId, [open]));
  const page = await retrieve(world, world.contexts.group, query('lumen', { anchors: [entityAnchor(entityId)] }), {
    model: 'fixture/embedding',
    embedQuery: () => {
      commit(world, worksOn(MIRA, entityId, [hidden], { text: `private ${SECRET}` }), world.contexts.alex);
      return Promise.resolve(null);
    },
  });
  assert.ok(page.assertions.length > 0);
  assert.ok(!JSON.stringify(page).includes(SECRET));
  world.handle.close();
});

// ---- the read record -------------------------------------------------------------------------------------------------

test('the reads of a page name each shown version and source, and two versions of one claim stay two rows', async () => {
  // Bug: `turn_reads` keys a claim once, so a later citation of the older version cannot be proved.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const first = written(commit(world, worksOn(ALEX, entityId, [source], { text: 'then' })));
  const second = written(commit(world, worksOn(ALEX, entityId, [source], { ...successor(first), text: 'later' })));
  const page = await retrieve(
    world,
    world.contexts.group,
    query('', { anchors: [personAnchor(ALEX)], includeHistorical: true })
  );
  const rows = turnReadRows(world.db, pageReads(page, { block: 'retrieved' }), { iface: 'discord' });
  world.handle.transaction(() =>
    writeTurnReadRows(
      world.db,
      'turn:1',
      's0',
      rows.map((row) => ({ ...row, context_id: String(world.contexts.group.id) }))
    )
  );
  const stored = world.db
    .prepare("SELECT row_kind, version_id FROM turn_reads WHERE turn_id = 'turn:1' AND row_kind = 'claim_versions'")
    .all()
    .map((row) => row.version_id);
  assert.ok(stored.includes(first.versionId));
  assert.ok(stored.includes(second.versionId));
  const sources = world.db
    .prepare("SELECT row_id FROM turn_reads WHERE turn_id = 'turn:1' AND row_kind = 'sources'")
    .all();
  assert.ok(sources.some((row) => row.row_id === source));
  world.handle.close();
});

test('an empty page has no reads to record', () => {
  // Bug: a read row for nothing makes the citation check accept an id that was never shown.
  const page: MemoryPage = {
    assertions: [],
    sourceIds: [],
    paths: [],
    next: null,
    partialReason: null,
    ambiguous: [],
    signals: [],
  };
  assert.deepEqual(pageReads(page, { block: 'retrieved' }), []);
});

// ---- the tool --------------------------------------------------------------------------------------------------------

const memorySearch = () => {
  const found = SKILL_DEFINITIONS.find((one) => one.name === 'memory.search');
  assert.ok(found);
  return found;
};

test('the memory.search tool takes an entity, a predicate, a moment and historical mode', () => {
  // Bug: the persona cannot ask for an exact entity or for what she knew then, so she reads a hub by its name.
  const args = memorySearch().toArgs({
    question: 'lumen',
    entity: 'ent:1',
    predicate: 'project.works_on',
    as_of: '2026-01-01',
    historical: true,
  });
  assert.deepEqual(
    [args?.question, args?.entity, args?.predicate, args?.asOf, args?.historical],
    ['lumen', 'ent:1', 'project.works_on', '2026-01-01', true]
  );
});

test('the memory.search tool has no argument for authority or destination', () => {
  // Bug: a model argument reaches the read's context or the place an answer goes to.
  const definition = memorySearch();
  const names = Object.keys(definition.params.properties ?? {});
  for (const word of ['context', 'audience', 'internal', 'destination', 'target', 'scope', 'bounds']) {
    assert.ok(!names.includes(word), word);
  }
  assert.equal(definition.params.additionalProperties, false);
  const args = definition.toArgs({ question: 'lumen', context: 'internal', destination: 'place:room' });
  assert.equal(args?.context, undefined);
  assert.equal(args?.destination, undefined);
});
