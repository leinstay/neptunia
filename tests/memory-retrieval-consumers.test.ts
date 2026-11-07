// Every consumer's way into the one retrieval service, stage S8. `memoryQueryFor` turns what a consumer already holds into
// a query with no model in between; `retrievalBounds` gives the budget, the prefetch sharing its existing deadline and
// tokens. The selfimprovement view takes a `retrieve` function and adds its page to its facts, and
// recall's prefetch and search read the same service. The deciding turn's outcome, the publisher and the executor stay
// outside: these tests check that retrieval moves nothing there and never yields a destination. Fake model, real temporary
// databases, synthetic content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecall } from '../src/behavior/recall-run.ts';
import { buildSelfimprovementFacts } from '../src/behavior/selfimprovement-view.ts';
import { estimateTokens } from '../src/llm/tokens.ts';
import { retrieveMemory } from '../src/memory/db/retrieve.ts';
import type { MemoryPage, MemoryQuery, RetrievalBounds } from '../src/memory/db/semantic-types.ts';
import { buildSessionRequest, validateAnswer } from '../src/memory/db/session.ts';
import { memoryQueryFor, retrievalBounds } from '../src/memory/retrieval-input.ts';
import type { RetrievalInput } from '../src/memory/retrieval-input.ts';
import { labels } from './fixtures/labels.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { channel } from './fixtures/reads-rig.ts';
import { config as recallConfig } from './fixtures/recall-run-kit.ts';
import { baseConfig, chat, fixture, prompts, request } from './fixtures/memory-db/session-rig.ts';
import {
  ALEX,
  DM_ALEX,
  KAI,
  MIRA,
  ROOM,
  START,
  addEntity,
  addSource,
  commit,
  semanticWorld,
  worksOn,
} from './fixtures/memory-db/semantic-world.ts';
import type { World } from './fixtures/memory-db/semantic-world.ts';

const SECRET = 'xylophonewhisper';
const SETTINGS = {
  recall: { prefetch: { deadlineMs: 700, maxTokens: 900 } },
  memoryDb: { retrieval: { seeds: 3, hops: 2, nodes: 10, edges: 30, assertions: 6, evidence: 9 } },
};
const BOUNDS: RetrievalBounds = {
  seeds: 3,
  hops: 2,
  nodes: 10,
  edges: 30,
  assertions: 6,
  evidence: 9,
  tokens: 900,
  deadlineMs: 700,
};
const deps = { now: () => START, embedQuery: null, model: null };
const versions = (page: MemoryPage): Array<string> => page.assertions.map((one) => one.versionId);
const written = (result: object): { claimId: string; versionId: string } =>
  result as { claimId: string; versionId: string };
const person = (id: string) => ({ kind: 'person' as const, id });
const place = (id: string) => ({ kind: 'place' as const, id });
const entity = (id: string) => ({ kind: 'entity' as const, id });

/** A world where Alex works on Lumen in public, and a private fact and line about Lumen exist in Alex's DM. */
function known() {
  const world = semanticWorld();
  const open = addSource(world, 'public', 'Alex works on Lumen, the build keeps failing with web.search TIMEOUT');
  const hidden = addSource(world, 'alex', `Lumen and ${SECRET}`);
  const lumen = addEntity(world, 'project', 'Lumen', [open]);
  const fact = written(commit(world, worksOn(ALEX, lumen.entityId, [open])));
  const secret = written(
    commit(world, worksOn(MIRA, lumen.entityId, [hidden], { text: `private ${SECRET}` }), world.contexts.alex)
  );
  return { world, open, hidden, lumen, fact, secret };
}

// ---- the query of each consumer --------------------------------------------------------------------------------------

const INPUTS: ReadonlyArray<[string, RetrievalInput, MemoryQuery['purpose']]> = [
  ['an ordinary turn', { purpose: 'turn', text: 'how is lumen', people: [ALEX], place: ROOM, entities: [] }, 'turn'],
  ['an explicit search', { purpose: 'search', text: 'lumen', anchors: [], predicates: ['project.works_on'] }, 'search'],
  ['a prefetch', { purpose: 'prefetch', text: 'how is lumen', people: [ALEX], place: ROOM, entities: [] }, 'prefetch'],
  [
    'a heartbeat with no intention',
    { purpose: 'heartbeat', recent: ['Lumen shipped'], intentions: [], focus: [ALEX], entities: [] },
    'heartbeat',
  ],
  [
    'an attention wake',
    { purpose: 'attention', intention: { purpose: 'ask about lumen', people: [ALEX], entities: [], place: ROOM } },
    'attention',
  ],
  [
    'a reflection with no mirror',
    {
      purpose: 'reflection',
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-05T00:00:00.000Z',
      participants: [ALEX],
      entities: [],
    },
    'reflection',
  ],
  [
    'an improvement wake seeded only by a failure',
    { purpose: 'improvement', failures: [{ tool: 'web.search', code: 'TIMEOUT' }], lessons: [], entities: [] },
    'improvement',
  ],
  [
    'a memory session',
    { purpose: 'session', batch: ['lumen shipped'], people: [ALEX], places: [ROOM], entities: [] },
    'session',
  ],
  ['a task with no home community', { purpose: 'task', goal: 'finish lumen', refs: [] }, 'task'],
  ['a watcher diagnostic', { purpose: 'watcher', goal: 'failed runs', runIds: ['run:1'] }, 'watcher'],
];

for (const [name, input, purpose] of INPUTS) {
  test(`${name} makes a bounded query for its purpose and names no destination`, () => {
    // Bug: a consumer widens its budget, or a retrieved place becomes where the output goes.
    const made = memoryQueryFor(input, BOUNDS);
    assert.equal(made.purpose, purpose);
    assert.deepEqual(made.bounds, BOUNDS);
    assert.deepEqual(Object.keys(made).sort(), [
      'anchors',
      'bounds',
      'cursor',
      'includeHistorical',
      'predicates',
      'purpose',
      'recordedBefore',
      'text',
      'validAt',
    ]);
  });

  test(`${name} makes the same query from the same input`, () => {
    // Bug: a clock, a random pick or a helper model decides what she is reminded of.
    assert.deepEqual(memoryQueryFor(input, BOUNDS), memoryQueryFor(structuredClone(input), BOUNDS));
  });
}

test('a turn anchors on its people and its admitted place', () => {
  // Bug: the prefetch stays word-only and misses what is known about who is speaking.
  const made = memoryQueryFor({ purpose: 'turn', text: 'hello', people: [ALEX], place: ROOM, entities: [] }, BOUNDS);
  assert.deepEqual(made.anchors, [person(ALEX), place(ROOM)]);
  assert.equal(made.text, 'hello');
});

test('a heartbeat with no intention purpose still has seeds from what changed and who is in focus', () => {
  // Bug: the seed was the intention's purpose alone, so a heartbeat with none recalls nothing.
  const made = memoryQueryFor(
    { purpose: 'heartbeat', recent: ['Lumen shipped'], intentions: [], focus: [ALEX], entities: [] },
    BOUNDS
  );
  assert.deepEqual(made.anchors, [person(ALEX)]);
  assert.match(made.text, /Lumen shipped/);
});

test('an improvement wake seeded only by a failure searches for that failure', () => {
  // Bug: a wake with no lesson and no project has nothing to search for.
  const made = memoryQueryFor(
    { purpose: 'improvement', failures: [{ tool: 'web.search', code: 'TIMEOUT' }], lessons: [], entities: [] },
    BOUNDS
  );
  assert.match(made.text, /web\.search/);
  assert.match(made.text, /TIMEOUT/);
});

test('an attention wake reads under its own purpose, people, entities and place', () => {
  // Bug: the follow-up reads what is active now instead of what the intention was about.
  const made = memoryQueryFor(
    {
      purpose: 'attention',
      intention: { purpose: 'ask about lumen', people: [KAI], entities: ['ent:1'], place: ROOM },
    },
    BOUNDS
  );
  assert.match(made.text, /ask about lumen/);
  assert.deepEqual(made.anchors, [person(KAI), entity('ent:1'), place(ROOM)]);
});

test('a reflection reads its own interval and a recording cutoff at its end', () => {
  // Bug: a diary entry about Monday quotes what she only learned on Friday.
  const made = memoryQueryFor(
    {
      purpose: 'reflection',
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-05T00:00:00.000Z',
      participants: [ALEX],
      entities: [],
    },
    BOUNDS
  );
  assert.equal(made.recordedBefore, '2026-11-05T00:00:00.000Z');
  assert.deepEqual(made.anchors, [person(ALEX)]);
});

test('a task carries its own refs and no community', () => {
  // Bug: a task's read depends on a home server that a DM-only installation does not have.
  const made = memoryQueryFor({ purpose: 'task', goal: 'finish lumen', refs: [entity('ent:1')] }, BOUNDS);
  assert.deepEqual(made.anchors, [entity('ent:1')]);
  assert.ok(!JSON.stringify(made).includes('guild'));
  assert.ok(!JSON.stringify(made).includes('community'));
});

test('a very long input is cut before it reaches the query', () => {
  // Bug: a heartbeat with a day of recent lines spends the budget on its own query.
  const recent = Array.from({ length: 500 }, (_, index) => `line ${index} ${'word '.repeat(40)}`);
  const made = memoryQueryFor({ purpose: 'heartbeat', recent, intentions: [], focus: [], entities: [] }, BOUNDS);
  assert.ok(estimateTokens(made.text) <= BOUNDS.tokens);
});

test('an empty input makes an empty query', () => {
  // Bug: a consumer with nothing to ask invents seeds, and a quiet wake reads a random corner of memory.
  const made = memoryQueryFor({ purpose: 'heartbeat', recent: [], intentions: [], focus: [], entities: [] }, BOUNDS);
  assert.deepEqual([made.text, made.anchors], ['', []]);
});

// ---- the budget ------------------------------------------------------------------------------------------------------

test('the prefetch shares its existing deadline and token budget', () => {
  // Bug: graph results are added on top of the 1500-token prefetch as another block.
  assert.deepEqual(retrievalBounds(SETTINGS, 'prefetch'), BOUNDS);
});

test('the bounds are read from the settings at the moment of use', () => {
  // Bug: a cached bound survives the owner's /set until the next restart.
  const changed = { ...SETTINGS, memoryDb: { retrieval: { ...SETTINGS.memoryDb.retrieval, hops: 1 } } };
  assert.equal(retrievalBounds(changed, 'prefetch').hops, 1);
  assert.equal(retrievalBounds(SETTINGS, 'prefetch').hops, 2);
});

test('a bound that is no number is refused by name', () => {
  // Bug: a NaN or a string turns a bound into "no bound", and a hub loads whole.
  const broken = { ...SETTINGS, memoryDb: { retrieval: { ...SETTINGS.memoryDb.retrieval, edges: 'many' } } };
  assert.throws(() => retrievalBounds(broken, 'prefetch'), /memoryDb\.retrieval\.edges/);
});

// ---- each consumer under its issued authority ------------------------------------------------------------------------

test('an ordinary group turn gets the public fact and nothing private', async () => {
  // Bug: the turn's prefetch reads under an internal context.
  const { world, lumen, fact, secret } = known();
  const made = memoryQueryFor(
    { purpose: 'turn', text: 'how is lumen', people: [ALEX], place: ROOM, entities: [lumen.entityId] },
    BOUNDS
  );
  const page = await retrieveMemory(world.db, world.contexts.group, made, deps);
  assert.ok(versions(page).includes(fact.versionId));
  assert.ok(!JSON.stringify(page).includes(secret.versionId));
  assert.ok(!JSON.stringify(page).includes(SECRET));
  world.handle.close();
});

test('the partner of a DM turn gets their private fact under the DM context', async () => {
  // Bug: a place anchor on the DM root is refused and private context never arrives.
  const { world, secret } = known();
  const made = memoryQueryFor({ purpose: 'turn', text: 'lumen', people: [ALEX], place: DM_ALEX, entities: [] }, BOUNDS);
  assert.ok(versions(await retrieveMemory(world.db, world.contexts.alex, made, deps)).includes(secret.versionId));
  world.handle.close();
});

test('another partner naming a private DM place as an anchor gets nothing of it', async () => {
  // Bug: a place anchor opens the conversation by id, past the audience of its rows.
  const { world, secret } = known();
  const made = memoryQueryFor({ purpose: 'turn', text: 'lumen', people: [], place: DM_ALEX, entities: [] }, BOUNDS);
  const whole = JSON.stringify(await retrieveMemory(world.db, world.contexts.mira, made, deps));
  assert.ok(!whole.includes(secret.versionId));
  assert.ok(!whole.includes(SECRET));
  world.handle.close();
});

test('a heartbeat with no intention retrieves useful context under its internal authority', async () => {
  // Bug: the wake has no seed, so its opportunities are only what she already remembers to ask.
  const { world, fact } = known();
  const made = memoryQueryFor(
    { purpose: 'heartbeat', recent: [], intentions: [], focus: [ALEX], entities: [] },
    BOUNDS
  );
  assert.ok(versions(await retrieveMemory(world.db, world.contexts.internal, made, deps)).includes(fact.versionId));
  world.handle.close();
});

test('a reflection with no mirror retrieves under the groups context and reads no DM', async () => {
  // Bug: the diary's writer sees a private fact and a mirror publishes it.
  const { world, fact, secret } = known();
  const made = memoryQueryFor(
    {
      purpose: 'reflection',
      from: '2026-11-01T00:00:00.000Z',
      to: '2027-01-01T00:00:00.000Z',
      participants: [ALEX],
      entities: [],
    },
    BOUNDS
  );
  const page = await retrieveMemory(world.db, world.contexts.groups, made, deps);
  assert.ok(versions(page).includes(fact.versionId));
  assert.ok(!JSON.stringify(page).includes(secret.versionId));
  world.handle.close();
});

test('an improvement wake seeded by a failure finds the plain line about it', async () => {
  // Bug: a failure with no entity behind it finds nothing, so the same fault returns every week.
  const { world, open } = known();
  const made = memoryQueryFor(
    { purpose: 'improvement', failures: [{ tool: 'web.search', code: 'TIMEOUT' }], lessons: [], entities: [] },
    BOUNDS
  );
  assert.ok((await retrieveMemory(world.db, world.contexts.internal, made, deps)).sourceIds.includes(open));
  world.handle.close();
});

test('an authorized task with no community retrieves from its goal', async () => {
  // Bug: the read asks for a home guild and a task with none gets nothing.
  const { world, fact } = known();
  const made = memoryQueryFor({ purpose: 'task', goal: 'finish lumen', refs: [] }, BOUNDS);
  assert.ok(versions(await retrieveMemory(world.db, world.contexts.internal, made, deps)).includes(fact.versionId));
  world.handle.close();
});

// ---- no outcome moves ------------------------------------------------------------------------------------------------

/** The row count of every plain table: a read that writes anywhere changes one of them. */
function rowCounts(world: World): Record<string, number> {
  const tables = world.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name NOT LIKE '%_tri%'"
    )
    .all()
    .map((row) => String(row.name));
  return Object.fromEntries(
    tables.map((table) => [table, Number(world.db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()?.n)])
  );
}

for (const [name, input] of INPUTS) {
  test(`${name} writes no row, consumes no receipt and queues nothing while it retrieves`, async () => {
    // Bug: retrieval marks a development receipt as seen, files a task, or stores its own bookkeeping as memory.
    const { world } = known();
    const before = rowCounts(world);
    await retrieveMemory(world.db, world.contexts.internal, memoryQueryFor(input, BOUNDS), deps);
    assert.deepEqual(rowCounts(world), before);
    world.handle.close();
  });
}

const page = (versionId: string): MemoryPage => ({
  assertions: [
    {
      claimId: 'clm:1',
      versionId,
      text: 'Alex works on Lumen',
      polarity: 'positive',
      state: 'current',
      arguments: [],
      evidence: [],
      dependencies: [],
      needsReview: false,
    },
  ],
  sourceIds: [],
  paths: [],
  next: null,
  partialReason: null,
  ambiguous: [],
  signals: [],
});
const improvementInput = (extra: object = {}) => ({
  now: START,
  since: null,
  journal: { read: (): Array<Record<string, unknown>> => [] },
  granted: [],
  skills: [],
  proposals: [],
  outbox: [{ seq: 7, kind: 'result' }],
  ...extra,
});
const withoutMemory = (facts: object): object =>
  Object.fromEntries(Object.entries(facts).filter(([key]) => key !== 'memory'));

test('the selfimprovement view adds the page and leaves the outbox it shows alone', async () => {
  // Bug: a retrieval read counts as delivering a development result, and the wake never hears of it.
  const retrieve = () => Promise.resolve(page('cv:2'));
  const plain = await buildSelfimprovementFacts(wrongly(improvementInput()));
  const facts = await buildSelfimprovementFacts(wrongly(improvementInput({ retrieve, bounds: BOUNDS })));
  assert.deepEqual(wrongly<{ memory: MemoryPage }>(facts).memory, page('cv:2'));
  assert.deepEqual(withoutMemory(facts), withoutMemory(plain));
});

test('the selfimprovement view makes its query from the failures it already holds', async () => {
  // Bug: a wake seeded only by a failure passes an empty query.
  const asked: Array<MemoryQuery> = [];
  const failed = (at: number, opId: string, phase: string) => ({
    kind: 'action',
    name: 'skill',
    turnId: 't1',
    opId,
    scope: { channel: 'c1' },
    phase,
    occurredAt: new Date(at).toISOString(),
    input: { skill: 'web.search', args: ['query'] },
    ...(phase === 'failed' ? { result: { code: 'TIMEOUT' } } : {}),
  });
  const records = [failed(START - 5000, 'op', 'started'), failed(START - 4000, 'op', 'failed')];
  const journal = {
    read: (query: { kind: string }) => records.filter((one) => one.kind === query.kind),
  };
  await buildSelfimprovementFacts(
    wrongly(
      improvementInput({
        journal,
        bounds: BOUNDS,
        retrieve: (query: MemoryQuery) => {
          asked.push(query);
          return Promise.resolve(page('cv:3'));
        },
      })
    )
  );
  assert.match(asked[0]?.text ?? '', /web\.search/);
});

// ---- no destination --------------------------------------------------------------------------------------------------

test('a page full of one salient place carries no target of any kind', async () => {
  // Bug: the most mentioned room becomes where a wake with no target posts.
  const { world } = known();
  for (let index = 0; index < 5; index += 1) addSource(world, 'public', `lumen in the room ${index}`);
  const found = await retrieveMemory(
    world.db,
    world.contexts.internal,
    memoryQueryFor({ purpose: 'heartbeat', recent: ['lumen'], intentions: [], focus: [], entities: [] }, BOUNDS),
    deps
  );
  assert.deepEqual(Object.keys(found).sort(), [
    'ambiguous',
    'assertions',
    'next',
    'partialReason',
    'paths',
    'signals',
    'sourceIds',
  ]);
  world.handle.close();
});

// ---- prefetch and explicit search --------------------------------------------------------------------------------------

function recaller(world: World, change: Record<string, Record<string, unknown>> = {}) {
  const none = () => Promise.resolve([]);
  const asked: Array<unknown> = [];
  const recall = createRecall(
    wrongly({
      reads: { searchMessages: none, searchMembers: none, history: none },
      hot: {
        config: recallConfig({
          features: { recall: true },
          memoryDb: { retrieval: SETTINGS.memoryDb.retrieval },
          ...change,
        }),
        prompts: { labels },
      },
      store: { state: { data: {}, markDirty() {} }, listUserProfiles: () => [] },
      llm: {
        capLeft: () => 100,
        complete: (messages: unknown) => {
          asked.push(messages);
          return Promise.reject(new Error('no helper model may run'));
        },
      },
      describer: null,
      now: () => START,
      archive: null,
      record: null,
      vectors: null,
      embed: null,
      memoryDb: { database: () => world.db, issueContext: () => world.contexts.group },
      iface: 'discord',
    })
  );
  const room = channel('room', { communityId: 'community-1' });
  const common = { selfId: 'self', selfName: 'Persona', history: [] };
  const lanes = [{ kind: 'message', text: 'how is lumen', words: 'how is lumen' }];
  return {
    prefetch: (ctx: unknown, target = room, placeId = ROOM) =>
      recall.prefetch(wrongly({ ...common, placeId, channel: target, lanes, memoryContext: ctx })),
    search: (ctx: unknown) =>
      recall.run(
        wrongly({
          ...common,
          placeId: ROOM,
          channel: room,
          quotes: true,
          candidate: { content: 'how is lumen', authorId: 'n1' },
          server: { forms: ['lumen'], who: [], from: null, to: null },
          memoryContext: ctx,
        })
      ),
    asked,
  };
}
type Excerpt = { source?: unknown; versionId?: unknown; lines?: unknown };
const excerptsOf = async (outcome: Promise<unknown>) => wrongly<{ excerpts: Array<Excerpt> }>(await outcome).excerpts;

test('a prefetch brings a semantic fact into its excerpts under the turn context', async () => {
  // Bug: the prefetch stays on source search alone, and structured memory never reaches an ordinary turn.
  const { world, fact } = known();
  const excerpts = await excerptsOf(recaller(world).prefetch(world.contexts.group));
  assert.ok(excerpts.some((one) => one.source === 'semantic' && one.versionId === fact.versionId));
  world.handle.close();
});

test('a prefetch brings nothing private into a group turn', async () => {
  // Bug: the semantic stream reads under another context than the source stream.
  const { world } = known();
  assert.ok(!JSON.stringify(await excerptsOf(recaller(world).prefetch(world.contexts.group))).includes(SECRET));
  world.handle.close();
});

test('semantic excerpts share the prefetch token budget instead of adding a block', async () => {
  // Bug: a hub's facts sit on top of the 1500 tokens, and the request cap refuses the turn.
  const { world } = known();
  const source = addSource(world, 'public', 'lumen');
  const lumen = addEntity(world, 'project', 'Lumen again', [source]);
  for (let index = 0; index < 20; index += 1) {
    commit(
      world,
      worksOn(ALEX, lumen.entityId, [source], { text: `lumen fact ${index} ${'many words here '.repeat(6)}` })
    );
  }
  const prefetch = {
    deadlineMs: 1000,
    maxTokens: 60,
    contextTokens: 10,
    excerptChars: 400,
    maxExcerpts: 8,
    trivial: [],
    deictic: [],
  };
  const excerpts = await excerptsOf(
    recaller(world, { recall: { ...recallConfig().recall, prefetch } }).prefetch(world.contexts.group)
  );
  const spent = excerpts.reduce((sum, one) => sum + estimateTokens(typeof one.lines === 'string' ? one.lines : ''), 0);
  assert.ok(spent <= prefetch.maxTokens, `${spent} tokens`);
  world.handle.close();
});

test('an explicit search returns structured facts beside the quotes', async () => {
  // Bug: the tool and the prefetch take two paths and answer differently for one question.
  const { world, fact } = known();
  const result = wrongly<{ assertions: Array<{ versionId: string }> }>(
    await recaller(world).search(world.contexts.group)
  );
  assert.ok(result.assertions.some((one) => one.versionId === fact.versionId));
  assert.ok(!JSON.stringify(result).includes(SECRET));
  world.handle.close();
});

test('a search and a prefetch never ask a model', async () => {
  // Bug: graph retrieval brings a query-planning call, which is both a cost and a helper deciding for her.
  const { world } = known();
  const rig = recaller(world);
  await rig.prefetch(world.contexts.group);
  await rig.search(world.contexts.group);
  assert.deepEqual(rig.asked, []);
  world.handle.close();
});

// ---- the memory session's prior evidence -----------------------------------------------------------------------------

const retrievedPage = (versionId: string, sourceId: string): MemoryPage => ({
  ...page(versionId),
  assertions: [{ ...page(versionId).assertions[0], evidence: [{ sourceId, role: 'supports' }] }],
  sourceIds: [sourceId],
});

function sessionWithPrior() {
  const env = fixture();
  chat(env);
  const stored = env.say({ native: 'old', minutesAgo: 9000, text: 'an old stored line' });
  const unseen = env.say({ native: 'never', minutesAgo: 9001, text: 'a line this run never showed' });
  env.db
    .prepare(
      "INSERT INTO claims (id, subject_kind, subject_id, kind, text, truth, shown, scope_kind, scope_iface) VALUES ('clm:prior', 'person', 'p', 'detail', 'prior', 'current', 1, 'group', 'discord')"
    )
    .run();
  env.db
    .prepare(
      "INSERT INTO claim_versions (id, claim_id, text, recorded_at, origin) VALUES ('cv:prior', 'clm:prior', 'prior', '2026-10-01T00:00:00.000Z', 'session')"
    )
    .run();
  const given = request(env);
  const retrieved = retrievedPage('cv:prior', stored);
  const built = buildSessionRequest({
    db: env.db,
    scope: given.scope,
    // The two old lines belong to an earlier batch: only `retrieved` can show one of them here.
    batch: given.batch.filter((line) => line.id !== stored && line.id !== unseen),
    config: wrongly(baseConfig()),
    prompts,
    selfName: 'Nep',
    now: Date.parse('2026-10-24T12:00:00.000Z'),
    retrieved,
  });
  return { env, built, stored, unseen };
}

const NEW_PROJECT = { handle: 'n1', kind: 'project', name: 'Lumen', language: 'en', sources: [1] };
const assertionCiting = (premises: Array<{ handle: string; role: string }>, sources: Array<number | string>) => ({
  predicate: { id: 'project.works_on', version: 1 },
  assertionKind: 'relation',
  text: 'Ada works on it',
  arguments: [
    { role: 'person', position: 0, ref: 'Ada' },
    { role: 'project', position: 0, ref: 'n1' },
  ],
  polarity: 'positive',
  how: 'inferred',
  sources,
  premises,
});

test('a session request records the prior versions and sources it shows, under their own handles', () => {
  // Bug: a claim is shown with no read row, so a later citation of it cannot be proved.
  const { env, built, stored } = sessionWithPrior();
  assert.deepEqual([...(built.maps.priorVersions?.values() ?? [])], ['cv:prior']);
  assert.ok([...built.maps.sources.values()].includes(stored));
  assert.ok(built.reads.some((read) => read.kind === 'claim_version' && read.id === 'cv:prior'));
  assert.ok(built.reads.some((read) => read.kind === 'source_id' && read.id === stored));
  env.done();
});

test('a shown prior version may be named as a premise and resolves to its exact id', () => {
  // Bug: she cannot build on what she was reminded of, so an inference loses its premise.
  const { env, built } = sessionWithPrior();
  const handle = [...(built.maps.priorVersions?.keys() ?? [])][0];
  const { plan } = validateAnswer(
    { entities: [NEW_PROJECT], assertions: [assertionCiting([{ handle, role: 'supports' }], [1])] },
    { maps: built.maps, people: built.people }
  );
  assert.deepEqual(plan.assertions?.[0]?.dependencies, [{ versionId: 'cv:prior', role: 'supports' }]);
  env.done();
});

test('a premise handle the request never gave is dropped with its reason', () => {
  // Bug: a guessed handle reaches a real version she was not shown.
  const { env, built } = sessionWithPrior();
  const { plan, counts } = validateAnswer(
    { entities: [NEW_PROJECT], assertions: [assertionCiting([{ handle: 'v99', role: 'supports' }], [1])] },
    { maps: built.maps, people: built.people }
  );
  assert.equal(counts.dropped.unknown_version, 1);
  assert.deepEqual(plan.assertions ?? [], []);
  env.done();
});

test('a raw source id is no citation, even of a real line, when the request did not show it', () => {
  // Bug: a displayed claim handle is taken as permission to cite its unseen source.
  const { env, built, unseen } = sessionWithPrior();
  assert.ok(![...built.maps.sources.values()].includes(unseen));
  const { plan, counts } = validateAnswer(
    { entities: [NEW_PROJECT], assertions: [assertionCiting([], [unseen])] },
    { maps: built.maps, people: built.people }
  );
  assert.equal(counts.dropped.unknown_source, 1);
  assert.deepEqual(plan.assertions ?? [], []);
  env.done();
});

test('a session with no retrieved page builds the request it always built', () => {
  // Bug: the new parameter changes every request's bytes and the prompt cache goes cold.
  const env = fixture();
  chat(env);
  const given = request(env);
  const built = buildSessionRequest({
    db: env.db,
    scope: given.scope,
    batch: given.batch,
    config: wrongly(baseConfig()),
    prompts,
    selfName: 'Nep',
    now: Date.parse('2026-10-24T12:00:00.000Z'),
    retrieved: null,
  });
  assert.deepEqual(built.messages, given.messages);
  env.done();
});
