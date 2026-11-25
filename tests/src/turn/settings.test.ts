// Tests for src/turn/settings.ts: the pace of a turn and the bounds of its tool loop, read from the live config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loopSettings, paceSettings, createTurnRunner as createRealTurnRunner } from '../../../src/behavior/turn.ts';
import '../../../src/tools/operations/index.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createDiscordInterface } from '../../../interfaces/discord/index.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import { createAdmin } from '../../../src/admin.ts';
import { labels } from '../../fixtures/labels.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { call, completionOf, toolAnswer } from '../../fixtures/tool-answers.ts';
import { createErrandStores } from '../../../src/errands/store.ts';
import { createErrandService } from '../../../src/errands/service.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { onWorld, useIface, world } from '../../fixtures/turn-world.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { wrongly, present } from '../../fixtures/loose-types.ts';
import { chainsOnDefaults } from '../../fixtures/chains.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';

useIface('fake');

test("loopSettings: a missing or unusable value takes config.json's", () => {
  // PR 7c: the shipped settings live in config/config.json.
  const tracked = JSON.parse(fs.readFileSync(new URL('../../../config/config.json', import.meta.url), 'utf8')).tools
    .loop;
  assert.deepEqual(loopSettings({}), tracked);
  assert.deepEqual(loopSettings({ tools: { loop: { maxSteps: 0, timeBudgetMs: -1, maxCallsPerStep: 1.5 } } }), tracked);
  // The ordinary loop carries every key of tools.loop, remindAfterSteps included.
  assert.deepEqual(loopSettings({ tools: { loop: { maxSteps: 5, timeBudgetMs: 900, maxCallsPerStep: 2 } } }), {
    maxSteps: 5,
    timeBudgetMs: 900,
    maxCallsPerStep: 2,
    stepReserveTokens: tracked.stepReserveTokens,
    remindAfterSteps: tracked.remindAfterSteps,
  });
});

test('paceSettings: 0, a negative value or a non-number turns a limit off; a missing key keeps a positive limit', () => {
  const missing = paceSettings({});
  assert.ok((missing.prepareMs ?? 0) > 0 && (missing.prepareSearchMs ?? 0) > 0 && (missing.prepareMediaMs ?? 0) > 0);
  for (const off of [0, -5, '6000', null, Number.NaN, Infinity]) {
    const pace = paceSettings({ pace: { prepareMs: off, prepareSearchMs: off, prepareMediaMs: off } });
    assert.equal(pace.prepareMs, null, String(off));
    assert.equal(pace.prepareSearchMs, null, String(off));
    assert.equal(pace.prepareMediaMs, null, String(off));
  }
  assert.ok((missing.dropAfterMs ?? 0) > 0);
  assert.equal(paceSettings({ pace: { dropAfterMs: 0 } }).dropAfterMs, null);
  assert.ok((missing.replyHedgeMs ?? 0) > 0);
  for (const off of [0, -5, '500', null, Number.NaN, Infinity]) {
    assert.equal(paceSettings({ pace: { replyHedgeMs: off } }).replyHedgeMs, null, String(off));
  }
  assert.deepEqual(
    paceSettings({
      pace: {
        prepareMs: 2500,
        prepareSearchMs: 7000,
        prepareMediaMs: 8000,
        dropAfterMs: 9000,
        replyHedgeMs: 4000,
        settleMs: 3000,
        settleMaxMs: 9000,
      },
    }),
    {
      prepareMs: 2500,
      prepareSearchMs: 7000,
      prepareMediaMs: 8000,
      dropAfterMs: 9000,
      replyHedgeMs: 4000,
      settleMs: 3000,
      settleMaxMs: 9000,
    }
  );
  assert.deepEqual(paceSettings({ pace: 'fast' }), missing, 'a group that is not an object counts as missing');
});

test('paceSettings: settleMs is 0 (off) for 0, a negative value or a non-number; settleMaxMs is null for those', () => {
  for (const off of [0, -5, '500', null, Number.NaN, Infinity]) {
    const pace = paceSettings({ pace: { settleMs: off, settleMaxMs: off } });
    assert.equal(pace.settleMs, 0, String(off));
    assert.equal(pace.settleMaxMs, null, String(off));
  }
  assert.equal(paceSettings({ pace: { settleMs: 2500 } }).settleMs, 2500);
});

// The chat is held by a fake interface named `fake`.

const createTurnRunner = onWorld(wrongly(createRealTurnRunner));

/** What an inner turn reports, the fields these tests read. */
type InnerResult = {
  outcome: string;
  reason?: string;
  delivered?: boolean;
  shadow?: boolean;
  refused?: string;
  reasons?: Array<string>;
  inner: {
    actions: Array<{ skill: string; status: string; code?: string; [field: string]: Untyped }>;
    openFollowUp: Record<string, Untyped>;
    loop: Record<string, Untyped>;
    intentIds: Array<string>;
  };
};

const DISCORD = createDiscordInterface().capabilities;

const NOW = Date.parse('2026-10-19T12:00:00Z');

const INNER_TASK = 'Nobody wrote to you; read the wake block.';

function rawMessage({
  id,
  authorId = 'u1',
  authorName = 'Alice',
  ts = NOW - 60_000,
  content = 'καλημέρα',
}: {
  id: string;
  authorId?: string;
  authorName?: string;
  ts?: number;
  content?: string;
}) {
  return {
    id,
    placeId: 'c1',
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
}

/** The channel c1 of the root over `historyMessages`, in the test's world. */
function fakeChannel(historyMessages: Array<Record<string, Untyped>>) {
  return world().channel({ id: 'c1', name: 'general', placeId: 'g1', historyMessages });
}

function fakeStore() {
  return {
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
}

// PR 7d: the switches are code, a heartbeat holds to intention changes and the inner turn's slice of the channel is
// the constant 30 lines, so the config holds only the keys that are still settings.
function hotWith({
  access = {},
  wakes = {},
}: { access?: Record<string, Untyped>; wakes?: Record<string, Untyped> } = {}) {
  return {
    config: {
      bot: { timezone: 'UTC', owners: ['u1'], access },
      context: {
        channelMessages: 100,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { fetchTimeoutMs: 10_000 },
        pull: { sameAudience: true },
      },
      llm: { maxRequestTokens: 50000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      models: { routes: chainsOnDefaults({ analyzer: 'x/text' }) },
      tools: {
        safeMode: false,
        resultMaxChars: 2000,
        callTimeoutMs: 120000,
        loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 },
      },
      wakes: { mode: 'shadow', ...wakes },
    },
    prompts: {
      main: 'You are a regular member of this chat, not an assistant.',
      persona: 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      'turn/reply': 'Someone called you: {{author}}.',
      interject: 'Jump into the chat.',
      initiate: 'Start a topic.',
      'turn/inner': INNER_TASK,
      labels,
    },
  };
}

function personaGrants(names: Array<string>) {
  return Object.fromEntries(names.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }]));
}

function sequenceLlm(answers: Array<unknown>, { onCall = null }: { onCall?: ((calls: number) => void) | null } = {}) {
  const calls: Array<Untyped> = [];
  const options: Array<Untyped> = [];
  return {
    calls,
    options,
    complete: async (messages: Array<Record<string, Untyped>>, requestOptions: Record<string, Untyped>) => {
      calls.push(messages);
      options.push(requestOptions ?? {});
      const answer: unknown = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (onCall) onCall(calls.length);
      return completionOf(answer);
    },
  };
}

const WAKE = {
  kind: 'intention_due',
  items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
  intentions: [{ id: 'i1', purpose: 'πες καλημέρα στο κανάλι', dueAt: NOW - 60_000 }],
  now: NOW,
  timezone: 'UTC',
  channels: [],
};

/**
 * One inner turn in #general (c1) answered with `answers`; `shadow` its mode; `gate` overrides of
 * the inner parameter (mayAct); `loop` overrides of `wakes.loop` (the
 * inner turn's bounds), `skillsLoop` of `tools.loop` (an ordinary turn's); `clock` the turn's
 * clock (NOW when none); `slowMs` delays every operation of the persona's by that many real milliseconds.
 */
async function innerTurn({
  answers,
  shadow = true,
  gate = {},
  journal = null,
  allowed = ['lore.list'],
  onCall = null,
  intentions = null,
  withErrands = false,
  errandConfigured = true,
  loop = null,
  skillsLoop = null,
  clock = () => NOW,
  slowMs = 0,
  gifs = null,
  wakes = {},
  filler = 0,
}: {
  answers: Array<unknown>;
  shadow?: boolean;
  gate?: Record<string, Untyped>;
  journal?: Untyped;
  allowed?: Array<string>;
  onCall?: ((calls: number) => void) | null;
  intentions?: Untyped;
  withErrands?: boolean;
  errandConfigured?: boolean;
  loop?: Record<string, Untyped> | null;
  skillsLoop?: Record<string, Untyped> | null;
  clock?: () => number;
  slowMs?: number;
  gifs?: Record<string, Untyped> | null;
  wakes?: Record<string, Untyped>;
  filler?: number;
}) {
  const history = [
    rawMessage({ id: 'm0', ts: NOW - 120_000, content: 'πρώτο' }),
    ...Array.from({ length: filler }, (_, n) => rawMessage({ id: `f${n}`, ts: NOW - 110_000 + n, content: 'πάλι' })),
    rawMessage({ id: 'm1', authorId: 'u2', authorName: 'Zoë', content: 'δεύτερο' }),
    rawMessage({ id: 'm2', ts: NOW - 30_000, content: 'τρίτο' }),
  ];
  const hot: Record<string, Untyped> = hotWith({ access: personaGrants(allowed), wakes });
  if (loop) hot.config.wakes.loop = { ...loop };
  if (skillsLoop) hot.config.tools.loop = { ...hot.config.tools.loop, ...skillsLoop };
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW });
  const client = { user: { id: 'self-id', username: 'Bot' }, channels: { cache: new Map() } };
  const store = fakeStore();
  if (gifs)
    Object.assign(store, {
      findGif: (handle: string) => gifs[handle] ?? null,
      recordOwnGif: () => {},
    });
  // A real errand service over a temp task store, its runner a fake whose runs never end.
  let errands = null;
  if (withErrands) {
    hot.config.agents = { maxOpen: 3, scout: { enabled: true, daily: { tasks: 10 } } };
    const stores = createErrandStores(wrongly({ dataDir: tempDir('nep-inner-errand-'), config: () => hot.config }));
    errands = createErrandService({
      client: { configured: () => errandConfigured, run: () => new Promise(() => {}), cancel: () => true },
      stores,
      hot,
    });
  }
  const admin = createAdmin({
    discord: DISCORD,
    hot,
    store,
    client,
    isServedRoot: (id: unknown) => id === 'g1',
    port,
    reads: world().adopt(port),
    ...(errands ? { errands } : {}),
  });
  const llm = sequenceLlm(answers, { onCall });
  const calibrator = { ratio: 1, apply: (value: string) => value, observe: () => {} };
  const slow = (fn: Untyped) =>
    slowMs > 0
      ? async (...a: Array<Untyped>) => {
          await new Promise((resolve) => setTimeout(resolve, slowMs));
          return fn(...a);
        }
      : fn;
  const turns = createTurnRunner({
    discord: DISCORD,
    hot,
    store,
    llm,
    calibrator,
    client,
    now: clock,
    port,
    skills: skillRegistry(),
    journal,
    runOp: slow(admin.runSkillOp),
    runOwnOp: slow(admin.runOwnSkillOp),
    runInitiativeOp: slow(admin.runInitiativeSkillOp),
    intentions,
    ...(errands ? { errands } : {}),
  });
  const inner = { wake: WAKE, shadow, mayAct: () => true, ...gate };
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({
      channel: fakeChannel(history),
      placeId: 'g1',
      mode: 'inner',
      triggerKind: 'inner',
      inner,
    })
  );
  const sends = port.calls
    .filter((call) => call.op === 'send')
    .map((call: Record<string, Untyped>) => {
      const args = call.args;
      return { to: args[0].chatId, ...args[1] };
    });
  return {
    result: wrongly<InnerResult>(result),
    logs,
    llm,
    sends,
    store,
    tasks: errands ? present(errands.store()).recent(10) : [],
  };
}

/** The note that ends request `n` (0-based) of `run`: the trailing user message after the persona's answer and its tool messages ('' when there is none). */
function noteOf(run: { llm: { calls: Array<Untyped> } }, n: number): string {
  const runCalls = run.llm.calls;
  const last = runCalls[n].at(-1);
  return last.role === 'user' && runCalls[n].length > 2
    ? last.content.map((part: Record<string, Untyped>) => part.text).join('')
    : '';
}

const labelsTask = labels.task;
const LAST = labelsTask.step.lastInner;

test("loopSettings: an inner turn's bounds are wakes.loop's (config.json's when missing or unusable); an ordinary turn's stay tools.loop's", () => {
  // PR 7c: the shipped settings live in config/config.json.
  const tracked = JSON.parse(fs.readFileSync(new URL('../../../config/config.json', import.meta.url), 'utf8'));
  assert.deepEqual(loopSettings({}, { inner: true }), tracked.wakes.loop);
  // An inner turn waits for its errands, 50 steps and 1000 seconds.
  assert.deepEqual(tracked.wakes.loop, {
    maxSteps: 50,
    timeBudgetMs: 1000000,
    maxCallsPerStep: 4,
    callTimeoutMs: 60000,
  });
  assert.deepEqual(
    loopSettings(
      { wakes: { loop: { maxSteps: 0, timeBudgetMs: -1, maxCallsPerStep: 1.5, callTimeoutMs: 'x' } } },
      { inner: true }
    ),
    tracked.wakes.loop
  );
  assert.deepEqual(
    loopSettings(
      { wakes: { loop: { maxSteps: 2, timeBudgetMs: 900, maxCallsPerStep: 1, callTimeoutMs: 500 } } },
      { inner: true }
    ),
    { maxSteps: 2, timeBudgetMs: 900, maxCallsPerStep: 1, callTimeoutMs: 500 }
  );
  // tools.loop never reaches an inner turn, wakes.loop never an ordinary one.
  const both = {
    tools: { loop: { maxSteps: 1, timeBudgetMs: 5, maxCallsPerStep: 1 } },
    wakes: { loop: { maxSteps: 9, timeBudgetMs: 99, maxCallsPerStep: 9, callTimeoutMs: 9 } },
  };
  assert.deepEqual(loopSettings(both, { inner: true }), both.wakes.loop);
  // The ordinary loop carries every key of tools.loop, remindAfterSteps included.
  const { remindAfterSteps: remindAfter } = (tracked as { tools: { loop: { remindAfterSteps: number } } }).tools.loop;
  const trackedTools = tracked.tools;
  assert.deepEqual(loopSettings(both), {
    ...both.tools.loop,
    stepReserveTokens: trackedTools.loop.stepReserveTokens,
    remindAfterSteps: remindAfter,
  });
  assert.deepEqual(loopSettings(both, { inner: false }), {
    ...both.tools.loop,
    stepReserveTokens: trackedTools.loop.stepReserveTokens,
    remindAfterSteps: remindAfter,
  });
});

test("inner turn, budget: a slow call past tools.loop's 20 s completes inside wakes.loop; past wakes.loop.callTimeoutMs it is unknown as today", async () => {
  // The clock jumps 25 s while the second request is out: tools.loop's budget would be spent, wakes.loop's is not.
  const jumping = () => {
    let at = NOW;
    return {
      clock: () => at,
      onCall: (n: number) => {
        if (n === 2) at += 25_000;
      },
    };
  };
  let t = jumping();
  const run = await innerTurn({
    answers: [toolAnswer('', [call('lore.list')]), toolAnswer('', [call('lore.list')]), '<skip/>'],
    clock: t.clock,
    onCall: t.onCall,
    slowMs: 300,
    skillsLoop: { maxSteps: 1, timeBudgetMs: 1000 },
  });
  const runLlm = run.llm;
  assert.equal(runLlm.calls.length, 3, 'the read came back to the persona twice');
  const runInner = run.result.inner;
  assert.deepEqual(
    runInner.actions.map((a) => `${a.skill}:${a.status}:${a.result}`),
    ['lore.list:executed:ok', 'lore.list:executed:ok']
  );
  assert.ok(!noteOf(run, 2).includes(LAST), 'not the last step: 25 s is inside the inner budget');
  assert.ok(!run.logs.some((l) => l.msg === 'skills: loop cap'));
  // The inner per-call timeout: min(wakes.loop.callTimeoutMs, what is left) -- here 100 ms against a 300 ms call.
  t = jumping();
  const cut = await innerTurn({
    answers: [toolAnswer('', [call('lore.list')]), toolAnswer('', [call('lore.list')]), '<skip/>'],
    clock: t.clock,
    onCall: t.onCall,
    slowMs: 300,
    loop: { maxSteps: 4, timeBudgetMs: 180000, maxCallsPerStep: 4, callTimeoutMs: 100 },
  });
  const cutInner = cut.result.inner;
  assert.deepEqual(
    cutInner.actions.map((a) => `${a.skill}:${a.status}:${a.result}:${a.code}`),
    ['lore.list:executed:unknown:timeout', 'lore.list:executed:unknown:timeout']
  );
  // The inner budget spent: the next request is the last, as on every turn.
  // The budget is set here, since the shipped one is 1000 s.
  let at = NOW;
  const spent = await innerTurn({
    answers: [toolAnswer('', [call('lore.list')]), toolAnswer('', [call('lore.list')]), '<skip/>'],
    clock: () => at,
    onCall: (n: number) => {
      if (n === 2) at += 181_000;
    },
    loop: { maxSteps: 4, timeBudgetMs: 180000, maxCallsPerStep: 4, callTimeoutMs: 60000 },
  });
  const spentLlm = spent.llm;
  assert.equal(spentLlm.calls.length, 3);
  assert.ok(noteOf(spent, 2).includes(LAST), noteOf(spent, 2));
});
