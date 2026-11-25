// The words of a stored fact's standing, and the queries and budgets of src/memory/retrieval-input.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factStateWords } from '../../../src/memory/retrieval-input.ts';
import { estimateTokens } from '../../../src/llm/tokens.ts';
import type { MemoryQuery, RetrievalBounds } from '../../../src/memory/db/semantic-types.ts';
import { memoryQueryFor, retrievalBounds, type RetrievalInput } from '../../../src/memory/retrieval-input.ts';
import { ALEX, KAI, ROOM } from '../../fixtures/memory-db/semantic-world.ts';

const STATES = { current: 'in force', unknown: 'unverified', negative: 'not so' };

test('a negative fact says so beside its state', () => {
  // Bug: "did not attend" reads as a plain current fact.
  assert.equal(factStateWords({ state: 'current', polarity: 'negative' }, STATES), 'in force, not so');
});

test('a state with no word and absent labels add nothing', () => {
  // Bug: a missing label prints `undefined` into the persona's request.
  assert.equal(factStateWords({ state: 'retired', polarity: 'positive' }, STATES), '');
  assert.equal(factStateWords({ state: 'current' }, null), '');
});

test('an old fact with no state reads as unverified', () => {
  // Bug: a version with no snapshot is shown as if it were known to be current.
  assert.equal(factStateWords({}, STATES), 'unverified');
});

// Every consumer's way into the one retrieval service. `memoryQueryFor` turns what a consumer already holds into
// a query with no model in between; `retrievalBounds` gives the budget, the prefetch sharing its existing deadline and
// tokens. The deciding turn's outcome, the publisher and the executor stay outside: these tests check that retrieval
// moves nothing there and never yields a destination. Fake model, real temporary databases, synthetic content.

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
const person = (id: string) => ({ kind: 'person' as const, id });
const place = (id: string) => ({ kind: 'place' as const, id });
const entity = (id: string) => ({ kind: 'entity' as const, id });

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
    'a memory session',
    { purpose: 'session', batch: ['lumen shipped'], people: [ALEX], places: [ROOM], entities: [] },
    'session',
  ],
  ['a task with no home root', { purpose: 'task', goal: 'finish lumen', refs: [] }, 'task'],
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
    // Bug: a clock, a random pick or a helper model decides what the persona is reminded of.
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
  // Bug: a diary entry about Monday quotes what the persona only learned on Friday.
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

test('a task carries its own refs and no root', () => {
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
  // Bug: a cached bound survives a `/set` until the next restart.
  const changed = { ...SETTINGS, memoryDb: { retrieval: { ...SETTINGS.memoryDb.retrieval, hops: 1 } } };
  assert.equal(retrievalBounds(changed, 'prefetch').hops, 1);
  assert.equal(retrievalBounds(SETTINGS, 'prefetch').hops, 2);
});

test('a bound that is no number is refused by name', () => {
  // Bug: a NaN or a string turns a bound into "no bound", and a hub loads whole.
  const broken = { ...SETTINGS, memoryDb: { retrieval: { ...SETTINGS.memoryDb.retrieval, edges: 'many' } } };
  assert.throws(() => retrievalBounds(broken, 'prefetch'), /memoryDb\.retrieval\.edges/);
});
