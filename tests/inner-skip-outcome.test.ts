// How an inner turn ends when its calls changed nothing (src/turn/phases/outcome.ts, src/turn/outcome.ts): a selfimprovement
// wake that only read `task.status` and answered `<skip/>` was recorded in `wake_runs` as `spoke` with nothing said. Calls
// with no outward effect and a last answer of skip end `skip`, on every inner kind; a call with an outward or durable
// effect stays as it is. Over a real admin and the fake interface, with a fake model answering from a script.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdmin } from '../src/admin.ts';
import { createTurnRunner as createRealTurnRunner } from '../src/behavior/turn.ts';
import { createErrandService } from '../src/errands/service.ts';
import { createErrandStores } from '../src/errands/store.ts';
import { createIntentionService } from '../src/intentions/service.ts';
import { createIntentionStores } from '../src/intentions/store.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { createJournal } from '../src/memory/journal.ts';
import '../src/tools/impl/index.ts';
import { skillRegistry } from '../src/tools/registry.ts';
import type { Untyped } from '../src/tools/types.ts';
import { createDiscordInterface } from '../interfaces/discord/index.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { labels } from './fixtures/labels.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { openTestMemorySync } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';
import { call, completionOf, toolAnswer } from './fixtures/tool-answers.ts';
import { onWorld, useIface, world } from './fixtures/turn-world.ts';

useIface('fake');
const createTurnRunner = onWorld(wrongly(createRealTurnRunner));
const DISCORD = createDiscordInterface().capabilities;
const NOW = Date.parse('2026-10-19T12:00:00Z');

const OPENED: Array<ReturnType<typeof openTestMemorySync>> = [];
after(async () => {
  for (const memory of OPENED) await memory.close();
});

const itemOf = (kind: string) => ({ kind, reason: kind, intentionIds: [], errandId: null });
const WAKES: Readonly<Record<string, Record<string, Untyped>>> = {
  heartbeat: { kind: 'heartbeat', items: [itemOf('heartbeat')] },
  selfimprovement: { kind: 'selfimprovement', items: [itemOf('selfimprovement')] },
  review: { kind: 'review', items: [itemOf('review')] },
  intention_due: {
    kind: 'intention_due',
    items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
    intentions: [{ id: 'i1', purpose: 'πες καλημέρα', dueAt: NOW - 60_000 }],
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
  kind = 'selfimprovement',
  allowed = ['lore.list', 'task.status'],
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
      models: { base: { analyzer: 'x/text' } },
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
      'system-prompt': 'You are a regular member of this chat, not an assistant.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      interject: 'Jump into the conversation.',
      initiate: 'Start a topic.',
      inner: 'Nobody wrote to you; read the wake block.',
      labels,
    },
  };
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW });
  const client = { user: { id: 'self-id', username: 'Bot' }, channels: { cache: new Map() } };
  const store = {
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    countUsers: () => 0,
    getLore: () => [],
    getMediaCache: () => ({}),
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
        stores: createIntentionStores({ dataDir: tempDir('nep-skip-intents-'), now: () => NOW }),
        hot,
        now: () => NOW,
        log: { info() {}, warn() {} },
      })
    : null;
  const admin = createAdmin({
    discord: DISCORD,
    hot,
    store,
    client,
    isServedCommunity: (id: unknown) => id === 'g1',
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
      writeUnit: (update: unknown) => {
        for (const line of (update as { lines?: ReadonlyArray<{ outcome?: unknown }> }).lines ?? []) lines.push(line);
        return memory.memoryDb.writeUnit(update);
      },
    },
    dataDir: 'fake-data',
    config: () => ({ thinkChars: 4000 }),
    now: () => NOW,
    uuid: () => `u${(n += 1)}`,
  });
  const turns = createTurnRunner({
    discord: DISCORD,
    hot,
    store,
    llm,
    calibrator: { ratio: 1, apply: (value: string) => value, observe: () => {} },
    client,
    now: () => NOW,
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
    now: NOW,
    timezone: 'UTC',
    channels: [],
    budgets: { chain: { used: 0, cap: 3, left: 3 } },
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

const READ_THEN_SKIP = [toolAnswer('', [call('lore.list')]), '<skip/>'];

for (const kind of Object.keys(WAKES)) {
  test(`a ${kind} wake that only read and answered skip ends skip`, async () => {
    // Bug: `wake_runs` says `spoke` for a wake that said nothing, so status and the watcher count a silent day as talk.
    const run = await innerTurn({ answers: READ_THEN_SKIP, kind });
    assert.equal(run.result.outcome, 'skip');
    assert.equal(run.result.delivered ?? false, false);
    assert.equal(run.sends.length, 0);
  });
}

test('the read that production saw, task.status, ends skip whether or not it could answer', async () => {
  // Bug: a read that came back failed counts as an effect, because its status is not `executed`.
  const run = await innerTurn({ answers: [toolAnswer('', [call('task.status')]), '<skip/>'] });
  assert.equal(run.result.outcome, 'skip');
});

test('several reads over several steps end skip too', async () => {
  // Bug: only the first step is looked at, and a longer look around still reads as speech.
  const run = await innerTurn({
    answers: [toolAnswer('', [call('lore.list')]), toolAnswer('', [call('lore.list'), call('task.status')]), '<skip/>'],
  });
  assert.equal(run.result.outcome, 'skip');
});

test('a skip after reads gives the same reason as a skip at once, and keeps her actions', async () => {
  // Bug: the new path loses the reason the status counts by, or the actions the next wake's feedback is built from.
  const atOnce = await innerTurn({ answers: ['<skip/>'] });
  const after = await innerTurn({ answers: READ_THEN_SKIP });
  assert.equal(after.result.outcome, 'skip');
  assert.equal(after.result.reason, atOnce.result.reason);
  assert.deepEqual(
    after.result.inner.actions.map((one) => `${one.skill}:${one.status}`),
    ['lore.list:executed']
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

  // An intention that came due may speak; a selfimprovement wake's post is refused, which the test above covers.
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
  assert.equal(changed.result.inner.actions[0]?.status, 'executed');
  assert.equal(changed.result.outcome, 'spoke');

  const errand = await innerTurn({
    answers: [toolAnswer('', [call('errand.run', { agent: 'scout', goal: 'βρες τον πίνακα' })]), '<skip/>'],
    kind: 'intention_due',
    allowed: ['errand.run'],
    errands: true,
  });
  assert.equal(errand.result.inner.actions[0]?.status, 'executed');
  assert.equal(errand.result.outcome, 'spoke');

  const proposed = await innerTurn({
    answers: [toolAnswer('', [call('message.create', { text: 'καλημέρα' })]), '<skip/>'],
    kind: 'intention_due',
    shadow: true,
  });
  assert.equal(proposed.result.inner.actions[0]?.status, 'proposed');
  assert.equal(proposed.result.outcome, 'spoke');
});
