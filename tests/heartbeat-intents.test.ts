// Tests for what a heartbeat turn may do (docs/inner-life.md "What a heartbeat may do"): memory inspection, an
// intention change and a skip are accepted (other calls are refused heartbeat-only and she reads why), the turn ends
// after the first change that goes through with no further request, the engine stamps origin `heartbeat` on what the
// turn creates and the updates keep it, and the caps (maxOpen, maxRecurring) refuse naming the open ones. Over a real admin, a real intention service on a temp data dir and the fake interface
// adapter; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner as createRealTurnRunner } from '../src/behavior/turn.ts';
import { userText } from '../src/behavior/prompt.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { createDiscordInterface } from '../interfaces/discord/index.ts';
import '../src/tools/impl/index.ts';
import { skillRegistry } from '../src/tools/registry.ts';
import { createAdmin } from '../src/admin.ts';
import { createIntentionStores } from '../src/intentions/store.ts';
import { createIntentionService } from '../src/intentions/service.ts';
import { labels } from './fixtures/labels.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { call, completionOf, toolAnswer, textAnswer } from './fixtures/tool-answers.ts';
import { tempDir } from './fixtures/tmp.ts';
import { onWorld, useIface, world } from './fixtures/turn-world.ts';
import type { Untyped } from '../src/tools/types.ts';
import { present, wrongly } from './fixtures/loose-types.ts';

// The chat is held by a fake interface named `fake`.
useIface('fake');
const createTurnRunner = onWorld(wrongly(createRealTurnRunner));

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

function fakeStore() {
  return {
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
}

// PR 7d: the switches are code, the heartbeat holds to intention changes and its caps (3 open, 1 recurring) are
// constants, so the config holds only the keys that are still settings.
function hotWith({ access = {}, wakes = {} } = {}) {
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
      models: { base: { analyzer: 'x/text' } },
      tools: {
        safeMode: false,
        resultMaxChars: 2000,
        callTimeoutMs: 120000,
        loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 },
      },
      wakes: { mode: 'shadow', ...wakes },
    },
    prompts: {
      'system-prompt': 'You are a regular member of this chat, not an assistant.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      interject: 'Jump into the chat.',
      initiate: 'Start a topic.',
      inner: INNER_TASK,
      labels,
    },
  };
}

function personaGrants(names: Array<string>) {
  return Object.fromEntries(names.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }]));
}

function sequenceLlm(answers: Array<unknown>, { onCall = null }: { onCall?: ((calls: number) => void) | null } = {}) {
  const calls: Array<Untyped> = [];
  return {
    calls,
    complete: async (messages: Record<string, Untyped>) => {
      calls.push(messages);
      const answer: unknown = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (onCall) onCall(calls.length);
      return completionOf(answer);
    },
  };
}

const BEAT_WAKE = {
  kind: 'heartbeat',
  items: [{ kind: 'heartbeat', reason: 'heartbeat', intentionIds: [], errandId: null }],
  intentions: [],
  now: NOW,
  timezone: 'UTC',
  channels: [],
  chainId: 'heartbeat:1',
};
const DUE_WAKE = {
  ...BEAT_WAKE,
  kind: 'intention_due',
  items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
  chainId: 'i1',
};
const GRANTS = [
  'conversation.read',
  'lore.show',
  'lore.list',
  'message.create',
  'intention.set',
  'intention.update',
  'intention.cancel',
];

/** A real intention service over a temp data dir (guild g1) and a clock fixed at NOW. */
function intentionService(hot: Record<string, Untyped>) {
  const stores = createIntentionStores({ dataDir: tempDir('nep-hb-intents-'), now: () => NOW });
  return createIntentionService({ stores, hot, now: () => NOW, log: { info() {}, warn() {} } });
}

/**
 * One live inner turn in #general answered with `answers`, over the real intention service. `wake` is the turn's
 * wake (a heartbeat by default), `seed(service)`
 * what exists before the turn.
 */
async function liveTurn({
  answers,
  wake = BEAT_WAKE,
  seed = null,
  intentionsCfg = {},
  transport = 'native',
  lore = [],
}: Record<string, Untyped>) {
  const history = [rawMessage({ id: 'm0', ts: NOW - 120_000, content: 'πρώτο' })];
  const hot: Record<string, Untyped> = hotWith({
    access: personaGrants(GRANTS),
    wakes: { mode: 'live' },
  });
  hot.config.tools.transport = transport;
  hot.config.intentions = { expiresDays: 14, maxOpen: 20, ...intentionsCfg };
  const intentions = intentionService(hot);
  seed?.(intentions);
  const channel = world().channel({ id: 'c1', name: 'general', placeId: 'g1', historyMessages: history });
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW });
  const reads = world().adopt(port);
  const client = { user: { id: 'self-id', username: 'Bot' } };
  const store = fakeStore();
  store.getLore = () => lore;
  const admin = createAdmin({
    discord: DISCORD,
    hot,
    store,
    client,
    isServedRoot: (id: unknown) => id === 'g1',
    port,
    reads,
    intentions,
    now: () => NOW,
  });
  const llm = sequenceLlm(typeof answers === 'function' ? answers(intentions) : answers);
  const calibrator = { ratio: 1, apply: (value: Record<string, Untyped>) => value, observe: () => {} };
  const turns = createTurnRunner({
    hot,
    store,
    llm,
    calibrator,
    now: () => NOW,
    port,
    skills: skillRegistry(),
    journal: null,
    runOp: admin.runSkillOp,
    runOwnOp: admin.runOwnSkillOp,
    runInitiativeOp: admin.runInitiativeSkillOp,
    intentions,
  });
  const inner = { wake, shadow: false, mayAct: () => true, currentChannel: null };
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, placeId: 'g1', mode: 'inner', triggerKind: 'inner', inner })
  );
  const sends = port.calls.filter((call) => call.op === 'send');
  return { result, logs, llm, sends, intentions, hot, list: () => intentions.list({ all: true, closed: true }) };
}

const THINK = '<think>STEP 4. So: write it.</think>';
const SET = (text: string, extra = {}) => toolAnswer(THINK, [call('intention.set', { due: '0m', text, ...extra })]);
/** What she read of the calls of request `i`: the content of its tool messages, in order. */
const readOf = (run: Record<string, Untyped>, i: Untyped) =>
  run.llm.calls[i]
    .filter((message: Record<string, Untyped>) => message.role === 'tool')
    .map((message: Record<string, Untyped>) =>
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part: Record<string, Untyped>) => part.text).join('')
    )
    .join('\n');
const actionsOf = (run: Record<string, Untyped>) =>
  run.result.inner.actions.map((a: Record<string, Untyped>) => `${a.skill}:${a.status}:${a.code ?? a.result}`);

test('heartbeat turn: a post is refused and a memory read succeeds, she reads why, then one intention.set ends the turn with no further request', async () => {
  const run = await liveTurn({
    answers: [
      toolAnswer(THINK, [call('message.create', { text: 'γεια' }), call('lore.list')]),
      SET('check the thread in #general and answer if it is still open'),
    ],
  });
  assert.deepEqual(actionsOf(run), [
    'message.create:refused:heartbeat-only',
    'lore.list:executed:ok',
    'intention.set:executed:ok',
  ]);
  assert.deepEqual(run.sends, [], 'nothing was posted');
  assert.equal(run.llm.calls.length, 2, 'the refusal step, and no request after the change');
  assert.ok(readOf(run, 1).includes(labels.tools.result.reasons['heartbeat-only']), 'she reads the refusal');
  assert.equal(run.list().length, 1);
  assert.ok(
    !run.logs.some((log) => log.msg === 'heartbeat: call refused' && log.skill === 'lore.list'),
    'memory inspection is allowed'
  );
});

test('heartbeat turn: the first change that goes through ends the turn at once; a skip is one request', async () => {
  const set = await liveTurn({ answers: [SET('look at the diary draft'), '<skip/>'] });
  assert.equal(set.llm.calls.length, 1, 'no acknowledgement step');
  assert.deepEqual(actionsOf(set), ['intention.set:executed:ok']);
  const skip: Record<string, Untyped> = await liveTurn({ answers: [`${THINK}<skip/>`] });
  assert.equal(skip.llm.calls.length, 1);
  assert.equal(skip.result.outcome, 'skip');
  assert.deepEqual(skip.list(), []);
});

test('heartbeat turn: a second intention call in the same step is refused, and a refused change does not end the turn', async () => {
  const two = await liveTurn({
    answers: [
      toolAnswer(`${THINK}`, [
        call('intention.set', { due: `1h`, text: `first thing` }),
        call('intention.set', { due: `2h`, text: `second thing` }),
      ]),
      '<skip/>',
    ],
  });
  assert.deepEqual(actionsOf(two), ['intention.set:executed:ok', 'intention.set:refused:heartbeat-only']);
  assert.equal(two.list().length, 1);
  assert.equal(two.llm.calls.length, 1);
  const bad = await liveTurn({
    answers: [toolAnswer(`${THINK}`, [call('intention.set', { due: `soon`, text: `a thing` })]), SET('a thing')],
  });
  assert.deepEqual(actionsOf(bad), ['intention.set:executed:bad-time', 'intention.set:executed:ok']);
  assert.equal(bad.llm.calls.length, 2, 'she saw the failure and corrected the call');
});

test('heartbeat turn: the engine stamps origin heartbeat on what it creates; an update keeps it, a heartbeat updating another one does not relabel it', async () => {
  const run = await liveTurn({
    answers: (service: ReturnType<typeof intentionService>) => [
      toolAnswer(`${THINK}`, [
        call('intention.update', { id: `${service.list({ all: true })[0].id}`, text: `new words` }),
      ]),
    ],
    seed: (service: ReturnType<typeof intentionService>) =>
      service.set({ purpose: 'her own earlier one', dueAt: NOW + 3_600_000 }),
  });
  assert.deepEqual(actionsOf(run), ['intention.update:executed:ok']);
  assert.equal(run.list()[0].purpose, 'new words');
  assert.equal(run.list()[0].origin, undefined, 'not relabelled');
  const made = await liveTurn({ answers: [SET('made by a heartbeat')] });
  assert.equal(made.list()[0].origin, 'heartbeat', 'stamped by the engine');
  const id = made.list()[0].id;
  assert.equal(
    present(made.intentions.update(id, { purpose: 'reworded', by: 'persona' }).intention).origin,
    'heartbeat'
  );
  assert.equal(present(made.intentions.update(id, { dueAt: NOW + 7_200_000 }).intention).origin, 'heartbeat');
});

test('intention.set outside a heartbeat carries no origin and no heartbeat cap', async () => {
  const run = await liveTurn({
    wake: DUE_WAKE,
    answers: [SET('one'), '<skip/>'],
    seed: (service: ReturnType<typeof intentionService>) => {
      for (const n of [1, 2, 3])
        service.set({ purpose: `from a heartbeat ${n}`, dueAt: NOW + n * 3_600_000, origin: 'heartbeat' });
    },
  });
  assert.equal(run.list().length, 4);
  assert.equal(present(run.list().find((r) => r.purpose === 'one')).origin, undefined);
});

test('heartbeat caps: at maxOpen intention.set is refused heartbeat-cap and the result names the open ones; closing one frees the room', async () => {
  const seed = (service: ReturnType<typeof intentionService>) => {
    for (const n of [1, 2, 3])
      service.set({ purpose: `heartbeat thing ${n}`, dueAt: NOW + n * 3_600_000, origin: 'heartbeat' });
  };
  const run = await liveTurn({ answers: [SET('a fourth'), '<skip/>'], seed });
  assert.deepEqual(actionsOf(run), ['intention.set:executed:heartbeat-cap']);
  assert.equal(run.list().length, 3);
  const ids = run.list().map((r) => r.id);
  const shown = readOf(run, 1);
  for (const id of ids) assert.ok(shown.includes(id), `the result names ${id}`);
  assert.ok(shown.includes('heartbeat thing 2'));
  const freed = await liveTurn({
    answers: [SET('a fourth')],
    seed: (service: ReturnType<typeof intentionService>) => {
      seed(service);
      const first = service.list({ all: true })[0];
      service.cancel(first.id, { all: true });
    },
  });
  assert.deepEqual(actionsOf(freed), ['intention.set:executed:ok']);
});

test('heartbeat caps: one recurring at most, for a new one and for a one-off made recurring', async () => {
  const seed = (service: ReturnType<typeof intentionService>) => {
    service.set({
      purpose: 'regular thing',
      dueAt: NOW + 3_600_000,
      every: { period: 'day', at: null },
      origin: 'heartbeat',
    });
    service.set({ purpose: 'one-off', dueAt: NOW + 7_200_000, origin: 'heartbeat' });
  };
  const fresh = await liveTurn({ answers: [SET('another regular', { every: 'day' }), '<skip/>'], seed });
  assert.deepEqual(actionsOf(fresh), ['intention.set:executed:heartbeat-recurring-cap']);
  const plain = await liveTurn({ answers: [SET('plain one')], seed });
  assert.deepEqual(actionsOf(plain), ['intention.set:executed:ok']);
  const made = await liveTurn({
    answers: (service: ReturnType<typeof intentionService>) => [
      toolAnswer(`${THINK}`, [
        call('intention.update', {
          id: `${present(service.list({ all: true }).find((r: Record<string, Untyped>) => r.purpose === 'one-off')).id}`,
          every: `day`,
        }),
      ]),
      '<skip/>',
    ],
    seed,
  });
  assert.deepEqual(actionsOf(made), ['intention.update:executed:heartbeat-recurring-cap']);
  assert.equal(made.list().filter((r) => r.every).length, 1);
});

test('an intention_due turn is not limited to intention changes', async () => {
  const run = await liveTurn({
    wake: { ...DUE_WAKE, intentions: [{ id: 'i1', purpose: 'say hello', dueAt: NOW }] },
    answers: [toolAnswer(`${THINK}`, [call('message.create', { place: `#general`, text: `γεια` })]), '<skip/>'],
  });
  assert.equal(run.sends.length, 1);
});

for (const transport of ['native', 'text']) {
  test(`heartbeat ${transport}: a read result is inspected before one intention ends the turn`, async () => {
    const answer = transport === 'native' ? toolAnswer : textAnswer;
    const run = await liveTurn({
      transport,
      lore: [{ id: 'l1', title: 'Weekend tournament', keys: ['tournament'], text: 'A shared game', always: false }],
      answers: [
        answer(THINK, [call('lore.list')]),
        answer(THINK, [call('intention.set', { due: '1h', text: 'ask about the remembered chat' })]),
        answer(THINK, [call('lore.list')]),
      ],
    });
    assert.deepEqual(actionsOf(run), ['lore.list:executed:ok', 'intention.set:executed:ok']);
    assert.equal(run.llm.calls.length, 2);
    assert.equal(run.list().length, 1);
    assert.deepEqual(run.sends, []);
    assert.ok(
      JSON.stringify(run.llm.calls[1].slice(2)).includes('Weekend tournament'),
      'the continuation receives the memory result'
    );
  });
}

test('heartbeat: inspecting memory may end in a skip without creating an intention', async () => {
  const run = await liveTurn({ answers: [toolAnswer(THINK, [call('lore.list')]), '<skip/>'] });
  assert.deepEqual(actionsOf(run), ['lore.list:executed:ok']);
  assert.equal(run.llm.calls.length, 2);
  assert.deepEqual(run.list(), []);
  assert.deepEqual(run.sends, []);
});

test('heartbeat: an external read remains forbidden even though memory reads are allowed', async () => {
  const run = await liveTurn({
    answers: [toolAnswer(THINK, [call('web.read', { url: 'https://example.com' })]), '<skip/>'],
  });
  assert.deepEqual(actionsOf(run), ['web.read:refused:heartbeat-only']);
  assert.equal(run.llm.calls.length, 2);
  assert.deepEqual(run.sends, []);
});

test('heartbeat: a failed memory read is returned to the model and can end in a skip', async () => {
  const run: Record<string, Untyped> = await liveTurn({
    answers: [toolAnswer(THINK, [call('lore.show', { id: 'missing' })]), '<skip/>'],
  });
  assert.equal(run.result.inner.actions[0].code, 'not-found');
  assert.equal(run.llm.calls.length, 2);
  assert.ok(readOf(run, 1).includes('missing'));
  assert.deepEqual(run.list(), []);
});

test('heartbeat: chat inspection returns real lines before creating a targeted intention', async () => {
  const run = await liveTurn({
    answers: [
      toolAnswer(THINK, [call('conversation.read', { place: '#general', last: 1 })]),
      SET('reply to the remembered message in general'),
    ],
  });
  assert.deepEqual(actionsOf(run), ['conversation.read:executed:ok', 'intention.set:executed:ok']);
  assert.ok(readOf(run, 1).includes('πρώτο'), 'the continuation sees the actual chat line');
  assert.equal(run.llm.calls.length, 2);
  assert.deepEqual(run.sends, []);
});
