// Tests for src/behavior/inner-output.ts: the output tags of an inner turn lowered into the
// calls a message.create / message.react.add of the persona's would be, in the order an addressed turn acts
// in, and the ones that must be refused carry their code. A picture is a tool call, never lowered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { innerOutputCalls } from '../../../src/behavior/inner-output.ts';
import { wrongly, present } from '../../fixtures/loose-types.ts';
import { createTurnRunner as createRealTurnRunner } from '../../../src/behavior/turn.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createDiscordInterface } from '../../../interfaces/discord/index.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import { createAdmin } from '../../../src/admin.ts';
import { feedbackFacts } from '../../../src/behavior/inner.ts';
import { labels } from '../../fixtures/labels.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { call, completionOf, toolAnswer } from '../../fixtures/tool-answers.ts';
import { createErrandStores } from '../../../src/errands/store.ts';
import { createErrandService } from '../../../src/errands/service.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { onWorld, useIface, world } from '../../fixtures/turn-world.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { chainsOnDefaults } from '../../fixtures/chains.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import '../../../src/tools/operations/index.ts';

const parsed = {
  reactions: [{ to: 2, emoji: '👍' }],
  untargetedReactions: [{ emoji: '🔥' }],
  messages: [
    { text: 'πρώτο', replyTo: 3 },
    { text: 'δεύτερο', replyTo: null },
  ],
  // A leftover picture tag is not lowered: a picture is the draw.create tool.
  draw: { text: 'a boat', self: true, replyTo: 4 },
};

// `<gif>` is no output tag, so an inner turn lowers reactions and messages.
test('innerOutputCalls: reactions and messages, in that order, and no picture, each as the call it stands for', () => {
  const calls = innerOutputCalls(parsed, { current: 'c1', turnChannel: 'c1' });
  assert.deepEqual(calls, [
    { skill: 'message.react.add', args: { message: '#2', emoji: '👍' } },
    { skill: 'message.react.add', args: { emoji: '🔥' }, refuse: { code: 'target-required', reason: 'react:to' } },
    { skill: 'message.create', args: { reply: '#3', text: 'πρώτο' } },
    { skill: 'message.create', args: { text: 'δεύτερο' } },
  ]);
});

test("innerOutputCalls: a current channel other than the turn's is named by the place argument", () => {
  const calls = innerOutputCalls({ messages: [{ text: 'x', replyTo: null }] }, { current: 'c9', turnChannel: 'c1' });
  assert.deepEqual(
    calls.map((call) => call.args.place),
    ['c9']
  );
});

test('innerOutputCalls: with no current channel every post is refused destination-required; a reaction naming its message is not', () => {
  const calls = innerOutputCalls(parsed, { current: null, turnChannel: 'c1' });
  const codes = calls.map((call) => `${call.skill}:${call.refuse?.code ?? ''}`);
  assert.deepEqual(codes, [
    'message.react.add:',
    'message.react.add:target-required',
    'message.create:destination-required',
    'message.create:destination-required',
  ]);
});

test('innerOutputCalls: nothing written, nothing lowered', () => {
  assert.deepEqual(
    innerOutputCalls(
      // `draw` is not a field the function reads; the test checks that an extra field lowers to nothing.
      wrongly({ messages: [], reactions: [], draw: null }),
      { current: 'c1', turnChannel: 'c1' }
    ),
    []
  );
  assert.deepEqual(innerOutputCalls(wrongly(null), { current: 'c1', turnChannel: 'c1' }), []);
});

// The chat is held by a fake interface named `fake`.
useIface('fake');

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
 * clock (NOW when none); `slowMs` delays every operation of the persona by that many real milliseconds.
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
  const wakes2 = hot.config.wakes;
  if (loop) wakes2.loop = { ...loop };
  const tools = hot.config.tools;
  if (skillsLoop) tools.loop = { ...tools.loop, ...skillsLoop };
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
    .map(({ args }: Record<string, Untyped>) => ({ to: args[0].chatId, ...args[1] }));
  return {
    result: wrongly<InnerResult>(result),
    logs,
    llm,
    sends,
    store,
    tasks: errands ? present(errands.store()).recent(10) : [],
  };
}

// `<gif>` runs nothing and tells a diagnostic. message.create gif= is the persona's way to post one.
test("inner turn, live: the persona's <msg> is a public action in the current channel, run through the gate like a message.create call, and a <gif> runs nothing", async () => {
  const gifs = { g1: { key: 'k1', id: 'g1', kind: 'link', url: 'https://tenor.example/cat' } };
  const run = await innerTurn({
    answers: ['<msg>γεια σας</msg><gif>g1</gif>', '<skip/>'],
    shadow: false,
    gifs,
  });
  assert.deepEqual(
    run.sends.map((send) => send.text),
    ['γεια σας']
  );
  const inner = run.result.inner;
  assert.deepEqual(
    inner.actions.map((a) => `${a.skill}:${a.status}:${a.result}`),
    ['message.create:executed:ok']
  );
  assert.equal(run.result.outcome, 'spoke');
  assert.equal(run.result.delivered, true);
  const action = inner.actions[0];
  assert.equal(action.target.channel, undefined, "the turn's own channel is the default: no channel argument");
});

test('inner turn, shadow: the tags are only proposed, as a message.create call is', async () => {
  const run = await innerTurn({
    answers: ['<msg>γεια σας</msg><react to="#2">👍</react>', '<skip/>'],
  });
  assert.deepEqual(run.sends, []);
  const inner = run.result.inner;
  assert.deepEqual(
    inner.actions.map((a) => `${a.skill}:${a.status}`),
    ['message.react.add:proposed', 'message.create:proposed']
  );
});

test('inner turn: with no current channel a <msg> or a draw.create without a channel is refused destination-required before any side effect; message.create with a channel goes', async () => {
  const gifs = { g1: { key: 'k1', id: 'g1', kind: 'link', url: 'https://tenor.example/cat' } };
  const run = await innerTurn({
    answers: [
      toolAnswer('<msg>γεια σας</msg><gif>g1</gif>', [call('draw.create', { people: [], text: 'ένας φάρος' })]),
      toolAnswer('', [call('message.create', { place: '#general', text: 'καλημέρα' })]),
      '<skip/>',
    ],
    shadow: false,
    gifs,
    gate: { currentChannel: null },
  });
  const inner = run.result.inner;
  assert.deepEqual(
    inner.actions.map((a) => `${a.skill}:${a.status}:${a.code ?? ''}`),
    ['draw.create:refused:destination-required', 'message.create:executed:']
  );
  assert.deepEqual(
    run.sends.map((send) => send.text),
    ['καλημέρα']
  );
  const result = labels.tools.result;
  const calls = run.llm.calls;
  assert.ok(
    calls[1]
      .filter((message: Record<string, Untyped>) => message.role === 'tool')
      .map((message: Record<string, Untyped>) => message.content)
      .join('\n')
      .includes(result.reasons['destination-required']),
    'the persona reads the refusal'
  );
  // The persona's speech tags, once the step lets them go out, are refused the same way.
  const tags = await innerTurn({
    answers: ['<msg>γεια σας</msg><gif>g1</gif>', '<skip/>'],
    shadow: false,
    gifs,
    gate: { currentChannel: null },
  });
  const inner2 = tags.result.inner;
  assert.deepEqual(
    inner2.actions.map((a) => `${a.skill}:${a.status}:${a.code ?? ''}`),
    // B7: the `<gif>` beside the `<msg>` is retired, so it is no call to refuse.
    ['message.create:refused:destination-required']
  );
  assert.deepEqual(tags.sends, []);
});

test('inner turn, live: a <react> needs a target; without one it is refused target-required, with one it reacts', async () => {
  const bare = await innerTurn({ answers: ['<react>👍</react>', '<skip/>'], shadow: false });
  const inner = bare.result.inner;
  assert.deepEqual(
    inner.actions.map((a) => `${a.skill}:${a.status}:${a.code}`),
    ['message.react.add:refused:target-required']
  );
  const calls = bare.llm.calls;
  assert.equal(
    calls.length,
    1,
    'a speech tag has no tool call to answer: nothing was left to read, so no request follows'
  );
  assert.deepEqual(
    feedbackFacts(bare.result).filter((fact) => fact.kind === 'callFailed'),
    [{ kind: 'callFailed', skill: 'message.react.add', status: 'refused', code: 'target-required' }],
    'the persona hears of it as a fact at the next turn'
  );
  const targeted = await innerTurn({
    answers: ['<react to="#2">👍</react>', '<skip/>'],
    shadow: false,
  });
  const inner2 = targeted.result.inner;
  assert.deepEqual(
    inner2.actions.map((a) => `${a.skill}:${a.status}`),
    ['message.react.add:executed']
  );
});

test(`inner turn, live: <msg reply="#N"> replies to that line; the persona's calls go first, then the tags, in the order of an addressed turn`, async () => {
  // PR 7d: the slice holds the channel's three lines (its bound is 30), so m2 is #3.
  const run = await innerTurn({
    answers: [
      toolAnswer('<msg reply="#3">πρώτο</msg><msg>δεύτερο</msg>', [call('message.create', { text: 'τρίτο' })]),
      '<skip/>',
    ],
    shadow: false,
  });
  assert.deepEqual(
    run.sends.map((send) => send.text),
    ['τρίτο', 'πρώτο', 'δεύτερο']
  );
  const secondSend = run.sends[1];
  assert.equal(secondSend.replyTo?.messageId, 'm2');
  const thirdSend = run.sends[2];
  assert.equal(thirdSend.replyTo, undefined);
});
