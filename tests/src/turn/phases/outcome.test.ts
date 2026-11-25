import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createDiscordInterface } from '../../../../interfaces/discord/index.ts';
import { createFakeAdapter } from '../../../../scripts/lib/fake.ts';
import { createAdmin } from '../../../../src/admin.ts';
import { createTurnRunner as createRealTurnRunner } from '../../../../src/behavior/turn.ts';
import { createErrandService } from '../../../../src/errands/service.ts';
import { createErrandStores } from '../../../../src/errands/store.ts';
import { createIntentionService } from '../../../../src/intentions/service.ts';
import { createIntentionStores } from '../../../../src/intentions/store.ts';
import { DailyCapError } from '../../../../src/llm/openrouter.ts';
import type { JournalLinesWrite } from '../../../../src/memory/db/journal-lines.ts';
import { createJournal } from '../../../../src/memory/journal.ts';
import { objectMediaCache } from '../../../../src/memory/store-media.ts';
import '../../../../src/tools/operations/index.ts';
import { skillRegistry } from '../../../../src/tools/registry.ts';
import type { Untyped } from '../../../../src/tools/types.ts';
import { withCapturedLogs } from '../../../fixtures/capture-logs.ts';
import { chainsOf } from '../../../fixtures/chains.ts';
import { publishTo } from '../../../fixtures/diary-mirror.ts';
import type { SceneMemory } from '../../../fixtures/diary-scene.ts';
import { labels } from '../../../fixtures/labels.ts';
import { wrongly } from '../../../fixtures/loose-types.ts';
import { openTestMemorySync } from '../../../fixtures/memory-db/service.ts';
import { directorAnswer } from '../../../fixtures/scene-answer.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { call, completionOf, toolAnswer } from '../../../fixtures/tool-answers.ts';
import { type Channel, onWorld, useIface, useSelf, world } from '../../../fixtures/turn-world.ts';
import { worldTurnRunner } from '../../../fixtures/world-runner.ts';

useIface('fake');

useSelf('self-id');

const NOW = Date.UTC(2026, 9, 6, 19, 30, 0);

type Appended = { post: Record<string, unknown>; opts: unknown };

function fakeStore() {
  const appended: Array<Appended> = [];
  return {
    appended,
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
    getDiary: () => ({ posts: [], updatedAt: 0 }),
    appendDiaryPost: (post: Record<string, unknown>, opts: unknown) => appended.push({ post, opts }),
    state: { data: {}, markDirty() {} },
  };
}

/** A model that answers the director with a scene and the persona's requests with `answers` in order, the last repeated. */
function fakeLlm(answers: Array<unknown>) {
  let composed = 0;
  return {
    complete: (messages: unknown, opts: { purpose?: string }) => {
      const scene = directorAnswer(messages, opts);
      if (scene) return Promise.resolve(scene);
      const answer = answers[Math.min(composed, answers.length - 1)];
      composed += 1;
      return Promise.resolve(completionOf(answer));
    },
  };
}

const hot = {
  config: {
    bot: { timezone: 'Europe/Athens' },
    context: {
      channelMessages: 50,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
      vision: { fetchTimeoutMs: 10_000 },
      pull: { sameAudience: true },
    },
    llm: { maxRequestTokens: 50000 },
    typing: { reactionDelayMs: [0, 0], msPerChar: [0, 0], minMs: 0, maxMs: 0, betweenMessagesMs: [0, 0] },
    diary: { placeId: 'd1', world: false },
  },
  prompts: {
    main: 'SYSTEM for {{name}}',
    persona: 'CARD_TEXT',
    format: 'FORMAT_TEXT',
    'diary/task': 'DIARY_TASK for {{name}}',
    'diary/scene': 'SCENE_TASK',
    'diary/seeds/place': 'a pier',
    'diary/seeds/setting': 'fog',
    labels,
  },
};

test('a diary turn whose refused call is followed by a skip ends skip and records no entry', async () => {
  // Bug: a turn that held nothing ended `spoke`, so the scheduler counted the slot as an entry posted.
  const channel = world().channel({ id: 'd1', name: 'journal', placeId: 'g1' });
  const store = fakeStore();
  const llm = fakeLlm([toolAnswer('', [call('message.create', { text: 'ένα βράδυ' })]), '<skip/>']);
  const runner = worldTurnRunner({
    hot,
    store,
    llm,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    images: null,
    lookup: null,
    rng: () => 0.5,
    now: () => NOW,
  });
  const result = (await runner.runTurn({
    channel,
    mode: 'diary',
    diary: { kind: 'thought', forced: false },
  })) as { outcome?: unknown; reason?: unknown };
  assert.equal(result.outcome, 'skip');
  assert.equal(result.reason, 'nothing-to-do');
  assert.deepEqual(store.appended, [], 'no entry is recorded');
});

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

// onWorld takes a creator of any options; the real runner takes its own input type, so the options are cast once, here.
const createWorldRunner = onWorld((options) =>
  createRealTurnRunner(options as Parameters<typeof createRealTurnRunner>[0])
);

/**
 * A turn runner whose `runTurn` first opens the chat a test gave as a diary channel (see diaryChannel).
 */
function createTurnRunner(options: Parameters<typeof createWorldRunner>[0]) {
  const turns = createWorldRunner(options);
  return {
    ...turns,
    runTurn: (params: Record<string, unknown> & { channel?: { open?: () => unknown } }) => {
      params.channel?.open?.();
      return turns.runTurn(params);
    },
  };
}

const TZ = 'Europe/Athens';

/**
 * A diary channel the persona owns: every permission, Attach Files only when `attachFiles`. The chat is made in
 * the test's world when a turn runs in it (`open`), and `sent` and `reactCalls` read what the persona did there.
 */
function diaryChannel({
  attachFiles = true,
  historyMessages = [],
}: { attachFiles?: boolean; historyMessages?: Array<Rec> } = {}) {
  let handle: Channel | null = null;
  return {
    id: 'd1',
    open() {
      handle ??= world().channel({
        id: 'd1',
        name: 'journal',
        placeId: 'g1',
        permissions: { attach: attachFiles },
        historyMessages,
      });
      return handle;
    },
    get sent() {
      return handle?.sent ?? [];
    },
    get reactCalls() {
      return handle?.reactCalls ?? [];
    },
  };
}

/**
 * Stage 3, the diary wake: a diary turn records the persona's entry and sends nothing itself, and the diary's mirror
 * publishes the entry (src/behavior/mirror.ts). The cases that asserted the turn's send call this where the send used
 * to happen: it checks that the turn sent nothing to `channel`, then publishes the entry to a mirror on `d1` of `port`,
 * so what `channel.sent` or the adapter shows after it is what the publication sent.
 * @param result  The diary turn's result.
 * @param channel  The diary channel of the case, or null when the case reads the adapter.
 */
async function published(result: Untyped, channel: Untyped, port = world().port) {
  assert.deepEqual(channel?.sent ?? [], [], 'the turn itself sends nothing');
  return publishTo(result, port, { now: NOW });
}

/**
 * An LLM that answers the director with `scene` (a scene's text, an Error it throws, or `{ raw }` sent as it is), then
 * the persona's requests with `post` (a list: one answer per request, the last repeated). `calls` holds every request,
 * the director's first.
 */
function diaryTurnFakeLlm(scene: string | Error | { raw: string } | null, post: Untyped) {
  const calls: Array<Untyped> = [];
  const options: Array<Untyped> = [];
  let composed = 0;
  return {
    calls,
    options,
    complete: async (messages: Untyped, opts: Untyped) => {
      calls.push(messages);
      options.push(opts);
      if (opts?.purpose === 'diary-scene') {
        if (scene instanceof Error) throw scene;
        if (scene !== null && typeof scene === 'object') return { text: scene.raw, usage: {}, estimated: 5 };
        return directorAnswer(messages, opts, typeof scene === 'string' ? scene : undefined);
      }
      const answer = Array.isArray(post) ? post[Math.min(composed, post.length - 1)] : post;
      composed += 1;
      return completionOf(answer);
    },
  };
}

const drawAnswer = (text: string, n = 1, self = false) =>
  toolAnswer(
    text,
    Array.from({ length: n }, (_, i) =>
      call('draw.create', {
        people: [],
        text: n === 1 ? 'a pier at night' : `scene ${i + 1}`,
        ...(self && i === 0 ? { self: true } : {}),
      })
    )
  );

type Rec = Record<string, Untyped>;

function diaryTurnFakeStore({ posts = [], data = {} }: { posts?: Array<Rec>; data?: Rec } = {}) {
  const appended: Array<Untyped> = [];
  return {
    appended,
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
    getDiary: () => ({ posts, updatedAt: 0 }),
    appendDiaryPost: (post: Untyped, opts: Untyped) => appended.push({ post, opts }),
    state: { data: { ...data }, markDirty() {} },
  };
}

function fakeImages({ used = 0, cap = 10, fail = null }: { used?: number; cap?: number; fail?: Error | null } = {}) {
  const prompts: Array<Untyped> = [];
  return {
    prompts,
    quota: () => ({ used, cap, userUsed: 0, userCap: 5, spent: used >= cap, userSpent: false }),
    generate: async ({ prompt }: { prompt: Untyped }) => {
      prompts.push(prompt);
      if (fail) throw fail;
      return { buffer: Buffer.from('png'), mediaType: 'image/png', seconds: 1, cost: 0 };
    },
  };
}

// PR 7d: the switches are code, the dry run and the daily caps are gone, and the diary's kinds, sets, gist length and
// message count are constants of src/behavior/diary.ts, so the config holds only the keys that are still settings.
function fakeHot({ diary = {}, prompts = {} }: { diary?: Untyped; prompts?: Untyped } = {}) {
  return {
    config: {
      bot: { timezone: TZ },
      context: {
        channelMessages: 50,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { fetchTimeoutMs: 10_000 },
        pull: { sameAudience: true },
      },
      llm: { maxRequestTokens: 50000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [0, 0], minMs: 0, maxMs: 0, betweenMessagesMs: [0, 0] },
      image: {},
      diary: {
        placeId: 'd1',
        world: false,
        ...diary,
      },
    },
    prompts: {
      main: 'SYSTEM for {{name}}',
      persona: 'CARD_TEXT',
      format: 'FORMAT_TEXT',
      'diary/task': 'DIARY_TASK for {{name}}',
      'diary/scene': 'SCENE_TASK',
      'diary/kinds/thought': 'THOUGHT_TASK',
      'diary/kinds/story': 'STORY_TASK',
      'diary/seeds/place': 'a pier',
      'diary/seeds/setting': 'fog',
      draw: 'DRAW for {{name}}\n{{when}}\n{{request}}',
      labels,
      ...prompts,
    },
  };
}

function runner({
  hot = fakeHot(),
  store = diaryTurnFakeStore(),
  llm,
  images = fakeImages(),
  lookup = null,
  // The code draws the diary's kind.
  rng = () => 0.5,
  extra = {},
}: {
  hot?: Untyped;
  store?: Untyped;
  llm?: Untyped;
  images?: Untyped;
  lookup?: Untyped;
  rng?: () => number;
  extra?: Record<string, unknown>;
} = {}) {
  return createTurnRunner({
    hot,
    store,
    llm,
    calibrator: { ratio: 1, apply: (n: Untyped) => n, observe: () => {} },
    images,
    lookup,
    rng,
    now: () => NOW,
    ...extra,
  });
}

test('diary turn: a request cap on the director refuses the turn', async () => {
  const llm = diaryTurnFakeLlm(new DailyCapError('daily cap'), '<msg>x</msg>');
  const channel = diaryChannel();
  const result = await runner({ llm }).runTurn({ channel, mode: 'diary', diary: { kind: 'story', forced: false } });
  assert.equal(loose(result).outcome, 'refused');
  assert.equal(llm.calls.length, 1);
  assert.equal(channel.sent.length, 0);
});

test('diary turn: a skip posts nothing and records nothing', async () => {
  const llm = diaryTurnFakeLlm(null, '<skip/>');
  const store = diaryTurnFakeStore();
  const channel = diaryChannel();
  const result = await runner({ llm, store }).runTurn({ channel, mode: 'diary', diary: {} });
  assert.equal(loose(result).outcome, 'skip');
  assert.equal(channel.sent.length, 0);
  assert.equal(store.appended.length, 0);
});

test('diary turn: a post of a picture alone is a spoken turn', async () => {
  const llm = diaryTurnFakeLlm(null, drawAnswer('', 1, true));
  const store = diaryTurnFakeStore();
  const channel = diaryChannel();
  const result = await runner({ llm, store }).runTurn({ channel, mode: 'diary', diary: {} });
  assert.equal(loose(result).outcome, 'spoke');
  // Stage 3: nothing reaches a chat from the turn, so it delivers nothing and the post records no message id; the
  // picture is one message of files once the mirror publishes the entry.
  await published(result, channel);
  assert.equal(channel.sent.length, 1);
  const firstSent = channel.sent[0];
  assert.ok(Array.isArray(firstSent.files));
  const firstAppended = store.appended[0];
  assert.equal(firstAppended.post.gist, '');
});

// The diary wake keeps the id of its turn on the entry as `extra.turnId`, written through the one writer. The
// wake runs the real turn runner over tests/fixtures/diary-scene.ts with a real journal. Invented ids and
// synthetic text only.

/** The scenes a test opened, closed when the file is done. */
const OPEN: Array<SceneMemory> = [];

after(async () => {
  for (const scene of OPEN.splice(0)) await scene.memory.close();
});

const innerSkipOutcomeCreateTurnRunner = onWorld(wrongly(createRealTurnRunner));

const DISCORD = createDiscordInterface().capabilities;

const INNER_SKIP_OUTCOME_NOW = Date.parse('2026-10-19T12:00:00Z');

const OPENED: Array<ReturnType<typeof openTestMemorySync>> = [];

after(async () => {
  for (const memory of OPENED) await memory.close();
});

const itemOf = (kind: string) => ({ kind, reason: kind, intentionIds: [], errandId: null });

const WAKES: Readonly<Record<string, Record<string, Untyped>>> = {
  heartbeat: { kind: 'heartbeat', items: [itemOf('heartbeat')] },
  review: { kind: 'review', items: [itemOf('review')] },
  intention_due: {
    kind: 'intention_due',
    items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
    intentions: [{ id: 'i1', purpose: 'πες καλημέρα', dueAt: INNER_SKIP_OUTCOME_NOW - 60_000 }],
  },
};

type Result = {
  outcome: string;
  reason?: string;
  delivered?: boolean;
  inner: { actions: Array<{ skill: string; status: string }> };
};

/** One inner turn on `kind` answered with `answers`, the persona granted `allowed`. */
async function innerTurn({
  answers,
  kind = 'heartbeat',
  allowed = ['lore.list', 'memory.journal.read'],
  shadow = false,
  withIntentions = false,
  errands = false,
  gate = {},
}: {
  answers: ReadonlyArray<unknown>;
  kind?: string;
  allowed?: ReadonlyArray<string>;
  shadow?: boolean;
  withIntentions?: boolean;
  errands?: boolean;
  gate?: Record<string, Untyped>;
}) {
  const grants = Object.fromEntries(allowed.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }]));
  const hot = {
    config: {
      bot: { timezone: 'UTC', owners: ['u1'], access: grants },
      context: {
        channelMessages: 100,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { fetchTimeoutMs: 10_000 },
        pull: { sameAudience: true },
      },
      llm: { maxRequestTokens: 50000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      models: { routes: chainsOf({ analyzer: 'x/text' }) },
      tools: {
        safeMode: false,
        resultMaxChars: 2000,
        callTimeoutMs: 120000,
        loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 },
      },
      wakes: { mode: shadow ? 'shadow' : 'live' },
      intentions: { expiresDays: 14, maxOpen: 20 },
      agents: { maxOpen: 3, scout: { enabled: errands, daily: { tasks: 10 } } },
    },
    prompts: {
      main: 'You are a regular member of this chat, not an assistant.',
      persona: 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      'turn/reply': 'Someone called you: {{author}}.',
      interject: 'Jump into the chat.',
      initiate: 'Start a topic.',
      'turn/inner': 'Nobody wrote to you; read the wake block.',
      labels,
    },
  };
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => INNER_SKIP_OUTCOME_NOW });
  const client = { user: { id: 'self-id', username: 'Bot' }, channels: { cache: new Map() } };
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
  };
  const service = errands
    ? createErrandService({
        client: { configured: () => true, run: () => new Promise(() => {}), cancel: () => true },
        stores: createErrandStores(wrongly({ dataDir: tempDir('nep-skip-errand-'), config: () => hot.config })),
        hot,
      })
    : null;
  const intentions = withIntentions
    ? createIntentionService({
        stores: createIntentionStores({ dataDir: tempDir('nep-skip-intents-'), now: () => INNER_SKIP_OUTCOME_NOW }),
        hot,
        now: () => INNER_SKIP_OUTCOME_NOW,
        log: { info() {}, warn() {} },
      })
    : null;
  const admin = createAdmin({
    discord: DISCORD,
    hot,
    store,
    client,
    isServedRoot: (id: unknown) => id === 'g1',
    port,
    reads: world().adopt(port),
    ...(service ? { errands: service } : {}),
  });
  let asked = 0;
  const llm = {
    complete: () => {
      const answer: unknown = answers[Math.min(asked, answers.length - 1)];
      asked += 1;
      return Promise.resolve(completionOf(answer));
    },
  };
  const memory = openTestMemorySync();
  OPENED.push(memory);
  const lines: Array<{ outcome?: unknown }> = [];
  let n = 0;
  const journal = createJournal({
    memoryDb: {
      ...memory.memoryDb,
      writeJournalLines: (write: JournalLinesWrite) => {
        for (const line of write.lines) lines.push(line);
        return memory.memoryDb.writeJournalLines(write);
      },
    },
    dataDir: 'fake-data',
    config: () => ({ thinkChars: 4000 }),
    now: () => INNER_SKIP_OUTCOME_NOW,
    uuid: () => `u${(n += 1)}`,
  });
  const turns = innerSkipOutcomeCreateTurnRunner({
    discord: DISCORD,
    hot,
    store,
    llm,
    calibrator: { ratio: 1, apply: (value: string) => value, observe: () => {} },
    client,
    now: () => INNER_SKIP_OUTCOME_NOW,
    port,
    skills: skillRegistry(),
    journal,
    runOp: admin.runSkillOp,
    runOwnOp: admin.runOwnSkillOp,
    runInitiativeOp: admin.runInitiativeSkillOp,
    intentions,
    ...(service ? { errands: service } : {}),
  });
  const channel = world().channel({ id: 'c1', name: 'general', placeId: 'g1', historyMessages: [] });
  const wake = {
    intentions: [],
    now: INNER_SKIP_OUTCOME_NOW,
    timezone: 'UTC',
    channels: [],
    ...(WAKES[kind] ?? {}),
  };
  const { result } = await withCapturedLogs(() =>
    turns.runTurn({
      channel,
      placeId: 'g1',
      mode: 'inner',
      triggerKind: 'inner',
      inner: { wake, shadow, mayAct: () => true, ...gate },
    })
  );
  const sends = port.calls.filter((one) => one.op === 'send');
  return { result: wrongly<Result>(result), sends, lines };
}

// Changed: the read is tools.describe, granted and accepted by every wake, since the persona's tools hold no task.status.
// Changed: the read is memory.journal.read, since tools.describe is an operation of the console and no tool of the persona.
const READ_THEN_SKIP = [toolAnswer('', [call('memory.journal.read', { n: 1 })]), '<skip/>'];

for (const kind of Object.keys(WAKES)) {
  test(`a ${kind} wake that only read and answered skip ends skip`, async () => {
    // Bug: `wake_runs` says `spoke` for a wake that said nothing, so status counts a silent day as talk.
    const run = await innerTurn({ answers: READ_THEN_SKIP, kind });
    assert.equal(run.result.outcome, 'skip');
    assert.equal(run.result.delivered ?? false, false);
    assert.equal(run.sends.length, 0);
  });
}

// Changed: the read that cannot answer is intention.list with no intention store, since the persona's tools hold no task.status.
test('a read that could not answer ends skip too', async () => {
  // Bug: a read that came back failed counts as an effect, because its status is not `executed`.
  const run = await innerTurn({
    answers: [toolAnswer('', [call('intention.list')]), '<skip/>'],
    allowed: ['lore.list', 'intention.list'],
  });
  assert.equal(run.result.outcome, 'skip');
});

test('several reads over several steps end skip too', async () => {
  // Bug: only the first step is looked at, and a longer look around still reads as speech.
  const run = await innerTurn({
    answers: [
      toolAnswer('', [call('lore.list')]),
      toolAnswer('', [call('lore.list'), call('memory.journal.read', { n: 1 })]),
      '<skip/>',
    ],
  });
  assert.equal(run.result.outcome, 'skip');
});

test("a skip after reads gives the same reason as a skip at once, and keeps the persona's actions", async () => {
  // Bug: the new path loses the reason the status counts by, or the actions the next wake's feedback is built from.
  const atOnce = await innerTurn({ answers: ['<skip/>'] });
  const after = await innerTurn({ answers: READ_THEN_SKIP });
  assert.equal(after.result.outcome, 'skip');
  assert.equal(after.result.reason, atOnce.result.reason);
  const afterInner = after.result.inner;
  assert.deepEqual(
    afterInner.actions.map((one) => `${one.skill}:${one.status}`),
    ['memory.journal.read:executed']
  );
});

test('the journal holds the skip', async () => {
  // Bug: the result is corrected on its way out, and `day` and `wake_runs` still read `spoke` from the journal line.
  const run = await innerTurn({ answers: READ_THEN_SKIP });
  assert.equal(run.result.outcome, 'skip');
  const ended = run.lines.flatMap((line) => (typeof line.outcome === 'string' ? [line.outcome] : []));
  assert.ok(ended.includes('skip'), JSON.stringify(ended));
  assert.equal(ended.includes('spoke'), false);
});

test('a post refused by the gate and a skip end skip: nothing happened', async () => {
  // Bug: `refused` is taken for an effect, and a turn stopped by the kill switch reads as speech.
  const run = await innerTurn({
    answers: [toolAnswer('', [call('message.create', { text: 'καλημέρα' })]), '<skip/>'],
    allowed: ['lore.list'],
    gate: { mayAct: () => false },
  });
  assert.equal(run.result.outcome, 'skip');
  assert.equal(run.sends.length, 0);
});

test('reads end skip, and every effect stays as it was: a message, an intention, an errand, a shadow proposal', async () => {
  // Bug: the fix goes by the last answer alone, so a wake that posted and then skipped is recorded as silent.
  assert.equal((await innerTurn({ answers: READ_THEN_SKIP })).result.outcome, 'skip');

  // An intention that came due may speak; a heartbeat's post is refused, which the test above covers.
  const message = await innerTurn({
    answers: [toolAnswer('', [call('message.create', { text: 'καλημέρα' })]), '<skip/>'],
    kind: 'intention_due',
  });
  assert.equal(message.result.outcome, 'spoke');
  assert.equal(message.result.delivered, true);
  assert.equal(message.sends.length, 1);

  const tag = await innerTurn({ answers: ['<msg>γεια σας</msg>', '<skip/>'], kind: 'intention_due' });
  assert.equal(tag.result.outcome, 'spoke');

  const mixed = await innerTurn({
    answers: [
      toolAnswer('', [call('lore.list')]),
      toolAnswer('', [call('message.create', { text: 'καλημέρα' })]),
      toolAnswer('', [call('lore.list')]),
      '<skip/>',
    ],
    kind: 'intention_due',
  });
  assert.equal(mixed.result.outcome, 'spoke');

  const changed = await innerTurn({
    answers: [toolAnswer('', [call('intention.set', { due: '0m', text: 'κοίτα το νήμα' })]), '<skip/>'],
    kind: 'heartbeat',
    allowed: ['intention.set'],
    withIntentions: true,
  });
  const changedInner = changed.result.inner;
  const firstAction = changedInner.actions[0];
  assert.equal(firstAction?.status, 'executed');
  assert.equal(changed.result.outcome, 'spoke');

  const errand = await innerTurn({
    answers: [toolAnswer('', [call('errand.scout', { goal: 'βρες τον πίνακα' })]), '<skip/>'],
    kind: 'intention_due',
    allowed: ['errand.scout'],
    errands: true,
  });
  const errandInner = errand.result.inner;
  const errandInnerFirstAction = errandInner.actions[0];
  assert.equal(errandInnerFirstAction?.status, 'executed');
  assert.equal(errand.result.outcome, 'spoke');

  const proposed = await innerTurn({
    answers: [toolAnswer('', [call('message.create', { text: 'καλημέρα' })]), '<skip/>'],
    kind: 'intention_due',
    shadow: true,
  });
  const proposedInner = proposed.result.inner;
  const proposedInnerFirstAction = proposedInner.actions[0];
  assert.equal(proposedInnerFirstAction?.status, 'proposed');
  assert.equal(proposed.result.outcome, 'spoke');
});
