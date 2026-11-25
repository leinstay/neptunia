import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEED_RING_PLACES, SEED_RING_TURNS, createSeedRing, seedRefsOf } from '../../../src/turn/seed-ring.ts';
import type { Mind, PersonEntry, PlaceEntry } from '../../../src/memory/db/mind-read.ts';
import { addLine, addPerson, addRoom, rootId } from '../../fixtures/memory-db/mind-world.ts';
import type { World } from '../../fixtures/memory-db/mind-world.ts';
import { useIface, onWorld, world } from '../../fixtures/turn-world.ts';
import { TURN_NOW, blockOf, replyTurns, serviceWorld, SERVICE_CONTEXT } from '../../fixtures/service-turn.ts';
import { createTurnRunner as createRealTurnRunner } from '../../../src/behavior/turn.ts';
import { userText } from '../../../src/behavior/prompt.ts';
import { createAdmin } from '../../../src/admin.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createJournal } from '../../../src/memory/journal.ts';
import { issueContext } from '../../../src/memory/db/scope.ts';
import { placeRefOf } from '../../../src/memory/db/frame-reads.ts';
import { placeChainInDb } from '../../../src/memory/db/place-tree.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import '../../../src/tools/operations/index.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import { openTestMemorySync } from '../../fixtures/memory-db/service.ts';
import { shippedLabels } from '../../fixtures/shipped-labels.ts';
import { completionOf } from '../../fixtures/tool-answers.ts';
import { OWNER_PERSON } from '../../fixtures/owner-accounts.ts';
import { chainsOnDefaults } from '../../fixtures/chains.ts';

const person = (personId: string, extra: Partial<PersonEntry> = {}): PersonEntry =>
  ({ personId, nodeId: `person:${personId}`, evidence: 'word', candidate: false, ...extra }) as PersonEntry;
const place = (placeId: string, extra: Partial<PlaceEntry> = {}): PlaceEntry =>
  ({ placeId, nodeId: `place:${placeId}`, evidence: 'place', candidate: false, ...extra }) as PlaceEntry;
const mindOf = (people: Array<PersonEntry>, places: Array<PlaceEntry>): Mind => ({
  people,
  places,
  interfaces: [],
  lore: [],
  found: [],
  leftOut: {},
  reads: [],
});

test('a turn of a place gives its seeds to the next turn of that place and to no other place', () => {
  const ring = createSeedRing();
  ring.note('c1', 't1', [{ kind: 'person', rowId: 'p1' }]);
  assert.deepEqual(ring.previous('c1', 't2'), [{ kind: 'person', rowId: 'p1' }]);
  assert.deepEqual(ring.previous('c2', 't2'), []);
});

test('a turn reads none of its own seeds back, and a second note of the same turn replaces the first', () => {
  const ring = createSeedRing();
  ring.note('c1', 't1', [{ kind: 'person', rowId: 'p1' }]);
  ring.note('c1', 't1', [{ kind: 'person', rowId: 'p2' }]);
  assert.deepEqual(ring.previous('c1', 't1'), []);
  assert.deepEqual(ring.previous('c1', 't2'), [{ kind: 'person', rowId: 'p2' }]);
});

test('a node two earlier turns raised is given once, and a turn older than the last few leaves the ring', () => {
  const ring = createSeedRing();
  ring.note('c1', 't0', [{ kind: 'person', rowId: 'old' }]);
  for (let n = 1; n <= SEED_RING_TURNS; n += 1) ring.note('c1', `t${n}`, [{ kind: 'place', rowId: 'c1' }]);
  assert.deepEqual(ring.previous('c1', 'next'), [{ kind: 'place', rowId: 'c1' }]);
});

test('the place noted longest ago leaves the ring when it holds too many places', () => {
  const ring = createSeedRing();
  for (let n = 0; n <= SEED_RING_PLACES; n += 1) ring.note(`c${n}`, 't', [{ kind: 'person', rowId: `p${n}` }]);
  assert.deepEqual(ring.previous('c0', 'next'), []);
  assert.deepEqual(ring.previous(`c${SEED_RING_PLACES}`, 'next'), [{ kind: 'person', rowId: `p${SEED_RING_PLACES}` }]);
});

test('the seeds of a mind are its people and places a line raised, no candidate and nothing an edge brought', () => {
  const mind = mindOf(
    [person('named'), person('guess', { candidate: true }), person('carried', { evidence: 'edge' })],
    [place('here'), place('prose', { evidence: 'prose' })]
  );
  assert.deepEqual(seedRefsOf(mind), [
    { kind: 'person', rowId: 'named' },
    { kind: 'place', rowId: 'here' },
  ]);
});

useIface('fake');

const MIN = 60_000;

const THINK = '<think>STEP 4. So: answer.</think>';

const SAY = `${THINK}<msg>γεια</msg>`;

const NIKOS = 'person:fake:4242';

const NIKOS_LINE = 'ΓΡΑΜΜΗ-ΣΤΟΝ-ΜΟΛΟ';

const iso = (at: number): string => new Date(at).toISOString();

/** The service world with Νίκος, who wrote one line in the room `μόλος` and nowhere else; the persona's line after it when the flag is set. */
function pierWorld({ personaAfter }: { personaAfter: boolean }): World {
  const world = serviceWorld();
  const pier = addRoom(world.db, { iface: 'fake', native: 'c9', root: rootId('fake', 'g1'), name: 'μόλος' });
  addPerson(world.db, { id: NIKOS, accounts: [{ id: 'fake:4242', iface: 'fake', native: '4242', names: ['Νίκος'] }] });
  addLine(world.db, {
    id: 'p1',
    iface: 'fake',
    place: pier,
    author: 'fake:4242',
    text: NIKOS_LINE,
    at: iso(TURN_NOW - 21 * MIN),
  });
  if (personaAfter)
    addLine(world.db, {
      id: 'p2',
      iface: 'fake',
      place: pier,
      author: 'self',
      text: 'ΔΙΚΗ-ΤΗΣ-ΜΟΛΟΣ',
      at: iso(TURN_NOW - 20 * MIN),
    });
  return world;
}

/** The body of `<people>` in the `<memory>` of a request's user text, '' when absent. */
const peopleOf = (request: string | undefined): string =>
  /<people>([\s\S]*?)<\/people>/.exec(blockOf(request ?? '', 'memory'))?.[1] ?? '';

test("a person the persona's previous turn in the place raised is in <people> of the next turn", async () => {
  // Bug: `previous` is always passed empty, so a person named a moment ago leaves the persona's memory as soon as the line that
  // named the person falls out of the reader's window, and the next answer in the same talk forgets who that is.
  const world = pierWorld({ personaAfter: false });
  try {
    const [first = [], second = []] = await replyTurns({
      world,
      // One line of the window seeds the reader, so only the line the persona answers names anyone.
      settings: { windowMessages: 1 },
      steps: [
        { trigger: { id: 'r2', text: 'ξέρεις τον Νίκος;', at: TURN_NOW - 3 * MIN }, answers: [SAY] },
        { trigger: { id: 'r3', text: 'εντάξει', at: TURN_NOW - MIN }, answers: [SAY] },
      ],
    });
    assert.match(peopleOf(first[0]), /Νίκος/, 'the first turn raised Νίκος by name');
    assert.match(peopleOf(second[0]), /Νίκος/);
  } finally {
    world.close();
  }
});

const createTurnRunner = onWorld(wrongly(createRealTurnRunner));

const DAY = 24 * 60 * MIN;

const GRANTED = ['conversation.read', 'memory.search', 'message.create'];

const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** A line of `c1` the persona answers, by Ελένη unless another author is named. */
type Line = { id: string; text: string; at: number; authorId?: string; authorName?: string };

/** One reply turn: the line the persona answers and the model's answers to its requests, each a text or a function of the request. */
type Step = { trigger: Line; answers: ReadonlyArray<unknown> };

/** A line of `c1` as the platform hands it over. */
const rawLine = ({ id, text, at, authorId = '111', authorName = 'Ελένη' }: Line): Record<string, unknown> => ({
  id,
  placeId: 'c1',
  author: { id: authorId, bot: false, globalName: authorName, username: authorName },
  member: { displayName: authorName },
  cleanContent: text,
  createdTimestamp: at,
  reference: null,
  attachments: new Map(),
  stickers: new Map(),
});

/** The person an account of the world belongs to, null for an account no row holds. */
function personOfAccountIn(mind: World, account: string): string | null {
  const row: unknown = mind.db.prepare('SELECT person_id FROM accounts WHERE id = ?').get(account);
  const person: unknown = row && typeof row === 'object' ? Reflect.get(row, 'person_id') : null;
  return typeof person === 'string' ? person : null;
}

/**
 * Reply turns in `c1` over `mind`, one runner per life: with `restartBefore` a step runs on a new runner over the same
 * journal, memory, store and interface, seeded from the journal as src/core.ts seeds one at start. Returns the user
 * texts of every request, one list per step.
 */
async function replyLives(spec: {
  mind: World;
  steps: ReadonlyArray<Step>;
  restartBefore?: number | null;
  settings?: Record<string, number>;
}): Promise<Array<Array<string>>> {
  const { mind, steps } = spec;
  const hot: Record<string, unknown> = {
    config: {
      bot: {
        timezone: 'UTC',
        ownerPerson: OWNER_PERSON,
        access: Object.fromEntries(GRANTED.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }])),
      },
      context: { ...SERVICE_CONTEXT, memory: { ...SERVICE_CONTEXT.memory, ...spec.settings } },
      dm: { enabled: true },
      llm: { maxRequestTokens: 60000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      models: { routes: chainsOnDefaults({ analyzer: 'x/text' }) },
      tools: {
        safeMode: false,
        resultMaxChars: 2000,
        callTimeoutMs: 120000,
        loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 },
      },
      wakes: { mode: 'live' },
    },
    prompts: {
      main: 'You are a regular member of this chat.',
      persona: 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      'turn/reply': 'Someone called you: {{author}}.',
      labels: shippedLabels,
    },
  };
  world().channel({ id: 'c1', name: 'γενικά', placeId: 'g1', historyMessages: [] });
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => TURN_NOW });
  const reads = world().adopt(port);
  const store = {
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    countUsers: () => 0,
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
    state: { data: {}, markDirty() {} },
    placeRefOf: (id: string) => placeRefOf(mind.db, id),
    placeOfChat: (given: { id?: unknown; iface?: unknown }) =>
      `${typeof given.iface === 'string' ? given.iface : 'fake'}:channel:${String(given.id)}`,
    accountOf: (native: string, iface?: string) => `${iface ?? 'fake'}:${native}`,
    personOfAccount: (account: string) => personOfAccountIn(mind, account),
    placeChainOf: (placeId: string) => placeChainInDb(mind.db, placeId),
  };
  const admin = createAdmin({
    hot,
    store,
    client: { user: { id: 'self-id', username: 'Bot' } },
    isServedRoot: (id: unknown) => id === 'g1',
    port,
    reads,
    now: () => TURN_NOW,
  });
  const memory = openTestMemorySync({ now: () => TURN_NOW });
  let n = 0;
  const journal = createJournal({
    memoryDb: memory.memoryDb,
    dataDir: 'fake-data',
    config: () => ({ thinkChars: 4000 }),
    now: () => TURN_NOW,
    uuid: () => `u${(n += 1)}`,
  });
  const requests: Array<string> = [];
  let step = 0;
  let firstOfStep = 1;
  const llm = {
    complete: (messages: Array<{ content: unknown }>) => {
      const text = messages.map((message) => userText(message.content)).join('\n');
      requests.push(text);
      const answers = steps[step]?.answers ?? ['<skip/>'];
      const value: unknown = answers[Math.min(requests.length - firstOfStep, answers.length - 1)];
      const answer: unknown = typeof value === 'function' ? Reflect.apply(value, undefined, [text]) : value;
      return Promise.resolve(completionOf(answer));
    },
  };
  let contexts = 0;
  const runner = () =>
    createTurnRunner({
      hot,
      store,
      llm,
      calibrator: { ratio: 1, apply: (value: unknown) => value, observe: () => {} },
      now: () => TURN_NOW,
      port,
      skills: skillRegistry(),
      journal,
      journalDb: () => mind.db,
      memoryContext: (given: Parameters<typeof issueContext>[0]) =>
        issueContext({ iface: 'fake', ...given, now: () => TURN_NOW, newId: () => `ctx:restart:${(contexts += 1)}` }),
      runOp: admin.runSkillOp,
      runOwnOp: admin.runOwnSkillOp,
      runInitiativeOp: admin.runInitiativeSkillOp,
    });
  /** A runner after a restart: seeded from the journal of yesterday and today for every place it may hold records of. */
  async function restarted() {
    const fresh = runner() as unknown as {
      seedTriggerLinks: (pairs: unknown) => void;
      seedCallMarks: (marks: unknown) => void;
    };
    const days = [utcDay(TURN_NOW - DAY), utcDay(TURN_NOW)];
    for (const placeId of ['g1', 'c1']) {
      fresh.seedTriggerLinks(await journal.triggerLinks(placeId, { days }));
      fresh.seedCallMarks({ ...(await journal.callMarks(placeId, { days })), placeId });
    }
    // The seeding of the lookups and the thinks reads the journal on its own (src/behavior/turn.ts#seedCallMarks).
    await new Promise((resolve) => setTimeout(resolve, 50));
    return fresh as unknown as ReturnType<typeof runner>;
  }
  let turns = runner();
  const out: Array<Array<string>> = [];
  for (const [index, one] of steps.entries()) {
    if (index === spec.restartBefore) {
      await journal.flush?.();
      turns = await restarted();
    }
    step = index;
    firstOfStep = requests.length + 1;
    const { id, text, at, authorId = '111', authorName = 'Ελένη' } = one.trigger;
    world().seed('c1', [rawLine(one.trigger)]);
    const trigger = { id, placeId: 'c1', authorId, authorName, self: false, bot: false, content: text, ts: at };
    await withCapturedLogs(() =>
      turns.runTurn({ chat: { iface: 'fake', chatId: 'c1' }, mode: 'reply', trigger, triggerKind: 'mention' })
    );
    await new Promise((resolve) => setImmediate(resolve));
    out.push(requests.slice(firstOfStep - 1));
  }
  await memory.close();
  return out;
}

/** The service world with Νίκος and the one line of Νίκος in `μόλος`. */
function restartPierWorld(): World {
  const mind = serviceWorld();
  const pier = addRoom(mind.db, { iface: 'fake', native: 'c9', root: rootId('fake', 'g1'), name: 'μόλος' });
  addPerson(mind.db, { id: NIKOS, accounts: [{ id: 'fake:4242', iface: 'fake', native: '4242', names: ['Νίκος'] }] });
  addLine(mind.db, {
    id: 'p1',
    iface: 'fake',
    place: pier,
    author: 'fake:4242',
    text: 'ΓΡΑΜΜΗ-ΣΤΟΝ-ΜΟΛΟ',
    at: iso(TURN_NOW - 21 * MIN),
  });
  return mind;
}

/** A turn that names Νίκος, then one that names nobody, with or without a restart between them. */
async function nikosThenNobody(restart: boolean): Promise<Array<Array<string>>> {
  const mind = restartPierWorld();
  try {
    return await replyLives({
      mind,
      restartBefore: restart ? 1 : null,
      // One line of the window seeds the reader, so only the line the persona answers names anyone.
      settings: { windowMessages: 1 },
      steps: [
        { trigger: { id: 'r2', text: 'ξέρεις τον Νίκος;', at: TURN_NOW - 3 * MIN }, answers: [SAY] },
        { trigger: { id: 'r3', text: 'εντάξει', at: TURN_NOW - MIN }, answers: [SAY] },
      ],
    });
  } finally {
    mind.close();
  }
}

test('<people> and <places> of the first turn after a restart are those it would have had without the restart', async () => {
  // Bug: the ring of what the persona's last turns raised lives in process only, so a restart between two answers of one talk
  // drops the person the first one was about, and the second forgets who that is.
  const [, kept = []] = await nikosThenNobody(false);
  const [, restarted = []] = await nikosThenNobody(true);
  const blocks = (request: string | undefined) =>
    ['people', 'places'].map(
      (tag) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(blockOf(request ?? '', 'memory'))?.[1] ?? ''
    );
  assert.match(blocks(kept[0])[0] ?? '', /Νίκος/, 'without a restart the second turn holds Νίκος');
  assert.deepEqual(blocks(restarted[0]), blocks(kept[0]));
});
