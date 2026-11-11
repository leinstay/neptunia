// Her context is the same after a restart as before it, in every block (the owner, 2026-11-11; plan 2026-11-10
// tools-and-reads, item 32). Two things a reply turn hands the next one live in process only: the lines each `#N` of a
// lookup's extract named (src/turn/calls.ts#Lookup `lines`), which `<recall>` numbers anew in each request, and the people
// and places her last turns in a place raised (src/turn/seed-ring.ts), which seed the graph reader of the next. A restart
// is a new turn runner over the same journal, memory and interface, seeded from the journal the way src/core.ts does at
// start (`journal.triggerLinks` and `journal.callMarks` of yesterday and today for every served place). Reply turns in
// `c1` of the service world (tests/fixtures/service-turn.ts), a scripted model, synthetic names in Greek.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner as createRealTurnRunner } from '../src/behavior/turn.ts';
import { userText } from '../src/behavior/prompt.ts';
import { createAdmin } from '../src/admin.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { createJournal } from '../src/memory/journal.ts';
import { issueContext } from '../src/memory/db/scope.ts';
import { placeRefOf } from '../src/memory/db/frame-reads.ts';
import { placeChainInDb } from '../src/memory/db/place-tree.ts';
import { objectMediaCache } from '../src/memory/store-media.ts';
import '../src/tools/operations/index.ts';
import { skillRegistry } from '../src/tools/registry.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { addLine, addPerson, addRoom, rootId } from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';
import { openTestMemorySync } from './fixtures/memory-db/service.ts';
import { shippedLabels } from './fixtures/shipped-labels.ts';
import { completionOf, call, toolAnswer } from './fixtures/tool-answers.ts';
import { onWorld, useIface, world } from './fixtures/turn-world.ts';
import { OWNER_PERSON } from './fixtures/owner-accounts.ts';
import { chainsOnDefaults } from './fixtures/chains.ts';
import { SERVICE_CONTEXT, TURN_NOW, blockOf, serviceWorld } from './fixtures/service-turn.ts';

useIface('fake');

const createTurnRunner = onWorld(wrongly(createRealTurnRunner));
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const THINK = '<think>STEP 4. So: answer.</think>';
const SAY = `${THINK}<msg>γεια</msg>`;
const GRANTED = ['conversation.read', 'memory.search', 'message.create'];
const iso = (at: number): string => new Date(at).toISOString();
const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** A line of `c1` she answers, by Ελένη unless another author is named. */
type Line = { id: string; text: string; at: number; authorId?: string; authorName?: string };
/** One reply turn: the line she answers and the model's answers to its requests, each a text or a function of the request. */
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
        transport: 'native',
        resultMaxChars: 2000,
        callTimeoutMs: 120000,
        loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 },
      },
      wakes: { mode: 'live' },
    },
    prompts: {
      'system-prompt': 'You are a regular member of this chat.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
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

// `<recall>` across a restart. The first turn reads the garden `c2` of the service world, Ελένη's line and hers after it.

const GARDEN = { eleni: 'ΕΛΕΝΗ-ΣΤΟΝ-ΚΗΠΟ', hers: 'ΔΙΚΗ-ΤΗΣ-ΚΗΠΟΣ' } as const;
const READ_GARDEN = toolAnswer(THINK, [call('conversation.read', { place: 'κήπος', last: 10 })]);

/** The line of `text` that holds `marker`, '' when none does. */
const lineWith = (text: string, marker: string): string => text.split('\n').find((line) => line.includes(marker)) ?? '';
/** The `#N` that opens the line of `text` holding `marker`, null when the line opens with none. */
const numberOf = (text: string, marker: string): string | null => /^#\d+\b/.exec(lineWith(text, marker))?.[0] ?? null;
/** What follows the `<task>` of a request: her answers and the results of her calls in a tool round. */
const afterTask = (request: string): string => request.split('</task>').slice(1).join('</task>');
/** How many times `marker` stands in `text`. */
const countOf = (text: string, marker: string): number => text.split(marker).length - 1;

/** Her answer that reads the garden around the number that opens the line of `marker` in `<recall>`, that line alone. */
const aroundRecalled =
  (marker: string) =>
  (request: string): unknown =>
    toolAnswer(THINK, [
      call('conversation.read', {
        place: 'κήπος',
        around: numberOf(blockOf(request, 'recall'), marker) ?? '#0',
        before: '0',
        after: '0',
      }),
    ]);

/** The garden read, then a turn that answers `second`, with or without a restart between them. */
async function gardenThenAsk(second: ReadonlyArray<unknown>, restart: boolean): Promise<Array<Array<string>>> {
  const mind = serviceWorld();
  try {
    return await replyLives({
      mind,
      restartBefore: restart ? 1 : null,
      steps: [
        { trigger: { id: 'r2', text: 'τι γράφουν στον κήπο;', at: TURN_NOW - 3 * MIN }, answers: [READ_GARDEN, SAY] },
        { trigger: { id: 'r3', text: 'τι είπε η Ελένη;', at: TURN_NOW - MIN }, answers: second },
      ],
    });
  } finally {
    mind.close();
  }
}

test('the first request after a restart shows <recall> as it would have without the restart, numbers included', async () => {
  // Bug: the journal restores her lookup without the lines its numbers named, so after a restart the extract shows no
  // number until she reads again, and the request differs from the one she would have had.
  const [, kept = []] = await gardenThenAsk([SAY], false);
  const [, restarted = []] = await gardenThenAsk([SAY], true);
  const before = blockOf(kept[0] ?? '', 'recall');
  assert.match(numberOf(before, GARDEN.eleni) ?? '', /^#\d+$/, 'without a restart her line has a number');
  assert.equal(blockOf(restarted[0] ?? '', 'recall'), before);
});

test('a number of <recall> after a restart reads that line in a call', async () => {
  // Bug: a number <recall> shows after a restart must name the line it named before it, in the turn's registry.
  const [, second = []] = await gardenThenAsk([aroundRecalled(GARDEN.eleni), SAY], true);
  assert.match(numberOf(blockOf(second[0] ?? '', 'recall'), GARDEN.eleni) ?? '', /^#\d+$/, 'her line has a number');
  const result = afterTask(second[1] ?? '');
  assert.equal(countOf(result, GARDEN.eleni), 1, result);
  assert.equal(countOf(result, GARDEN.hers), 0, 'the call read the line the number names and no other');
});

// The seeds of her earlier turns across a restart: Νίκος, who wrote one line in the room `μόλος`, is raised by the line
// she answers in the first turn, and the reader of the second sees one line of the window, which names nobody.

const NIKOS = 'person:fake:4242';

/** The service world with Νίκος and his one line in `μόλος`. */
function pierWorld(): World {
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
  const mind = pierWorld();
  try {
    return await replyLives({
      mind,
      restartBefore: restart ? 1 : null,
      // One line of the window seeds the reader, so only the line she answers names anyone.
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
  // Bug: the ring of what her last turns raised lives in process only, so a restart between two answers of one talk
  // drops the person the first one was about, and the second forgets who he is.
  const [, kept = []] = await nikosThenNobody(false);
  const [, restarted = []] = await nikosThenNobody(true);
  const blocks = (request: string | undefined) =>
    ['people', 'places'].map(
      (tag) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(blockOf(request ?? '', 'memory'))?.[1] ?? ''
    );
  assert.match(blocks(kept[0])[0] ?? '', /Νίκος/, 'without a restart the second turn holds him');
  assert.deepEqual(blocks(restarted[0]), blocks(kept[0]));
});
