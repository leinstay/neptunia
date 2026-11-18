// The service lane of her attention (src/turn/triggers.ts#takeAttention, src/behavior/attention.ts): a heartbeat turn
// and a diary turn hold a lane of their own, so a chat turn never waits for one and a service never waits for a chat
// turn, while one turn at a time still runs on each lane. The real turn runner over the test world with a model that
// answers on demand; the inner drain with fake turn runners; the lease over a real
// in-memory memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labels } from './fixtures/labels.ts';
import { world, useIface } from './fixtures/turn-world.ts';
import { createTurnRunner } from './fixtures/turn-runner.ts';
import { NOW, clock, fakeTurns, hotWith, intention, setup } from './fixtures/inner-rig.ts';
import type { InnerTurnParams } from '../src/behavior/inner/types.ts';
import { createLeasedAttention } from '../src/behavior/attention.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyWakeQueueWrite, leaseOf } from '../src/memory/db/wake-queue.ts';
import { MINUTE_MS } from '../src/time.ts';

useIface('fake');

/** A discord.js-shaped raw message of chat `placeId`. */
function rawMessage(id: string, placeId: string, authorId = 'u1') {
  return {
    id,
    placeId,
    author: { id: authorId, bot: false, globalName: authorId, username: authorId },
    member: { displayName: authorId },
    cleanContent: 'hey bot',
    createdTimestamp: Date.now() - 1000,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
}

/** The trigger the pipeline hands runTurn for `raw`. */
function triggerOf(raw: ReturnType<typeof rawMessage>) {
  return {
    id: raw.id,
    placeId: raw.placeId,
    authorId: raw.author.id,
    authorName: raw.author.globalName,
    self: false,
    bot: false,
    content: raw.cleanContent,
    ts: raw.createdTimestamp,
    replyToId: null,
    attachments: [],
    stickers: [],
  };
}

function fakeStore() {
  return {
    getPlace: () => ({}),
    getUser: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    liveRules: () => [],
    getDiary: () => ({ posts: [], updatedAt: 0 }),
    state: { data: {}, markDirty() {} },
  };
}

function fakeHot() {
  return {
    config: {
      bot: { timezone: 'UTC', dryRunChannelId: '' },
      context: {
        channelMessages: 100,
        neighborMessages: 5,
        neighborMaxAgeMinutes: 60,
        neighborMaxChannels: 8,
        maxMessageChars: 800,
        gapMarkerMinutes: 20,
        otherProfiles: 6,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: {
          maxImages: 2,
          tokensPerImage: 400,
          imageSize: 512,
          recentImages: 0,
          recentImageMinutes: 0,
          maxBytes: 1_500_000,
          fetchTimeoutMs: 10_000,
        },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [0, 0], minMs: 0, maxMs: 0, betweenMessagesMs: [0, 0] },
      diary: { world: false },
    },
    prompts: {
      main: 'SYSTEM',
      persona: 'CARD',
      format: 'Use <msg> and <react> tags.',
      'turn/reply': 'Someone called you: {{author}}.',
      'heartbeat/task': 'HEARTBEAT',
      'diary/task': 'DIARY',
      labels,
    },
  };
}

/** A model whose every request waits until the test answers it: `answer(i, text)` answers request `i`. */
function heldModel() {
  const calls: Array<unknown> = [];
  const answers: Array<(value: unknown) => void> = [];
  return {
    calls,
    complete: (messages: unknown) => {
      calls.push(messages);
      return new Promise<unknown>((resolve) => answers.push(resolve));
    },
    answer(index: number, text: string) {
      answers[index]?.({ text, usage: {}, estimated: 10 });
    },
  };
}

/** Waits, an event-loop turn at a time, until the model has `count` requests (or gives up after a bounded wait). */
async function untilCalls(model: { calls: Array<unknown> }, count: number) {
  for (let i = 0; i < 2000 && model.calls.length < count; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const BEAT_WAKE = {
  kind: 'heartbeat',
  items: [{ kind: 'heartbeat', reason: 'heartbeat', intentionIds: [] as Array<string>, errandId: null }],
  intentions: [],
  now: Date.now(),
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

/** A runner over two chats of the world, its model held, and the turns a test starts on it. */
function lanes() {
  const c1 = world().channel({ id: 'c1', name: 'general', placeId: 'g1', historyMessages: [rawMessage('m1', 'c1')] });
  const c2 = world().channel({ id: 'c2', name: 'other', placeId: 'g1', historyMessages: [rawMessage('m2', 'c2')] });
  const model = heldModel();
  const turns = createTurnRunner({
    hot: fakeHot(),
    store: fakeStore(),
    llm: model,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
  });
  const mention = (channel: typeof c1, id: string) =>
    turns.runTurn({ channel, mode: 'reply', trigger: triggerOf(rawMessage(id, channel.id)), triggerKind: 'mention' });
  const inner = (wake: typeof BEAT_WAKE, channel: typeof c1 | null = null) =>
    turns.runTurn({
      ...(channel ? { channel } : { chat: null }),
      mode: 'inner',
      triggerKind: 'inner',
      inner: { wake, shadow: false, mayAct: () => true, currentChannel: null },
    });
  const heartbeat = () => inner(BEAT_WAKE);
  const diary = () => turns.runTurn({ chat: null, mode: 'diary', diary: { kind: 'status', forced: false } });
  return { c1, c2, model, turns, mention, inner, heartbeat, diary };
}

test('a mention that arrives while a heartbeat turn is in flight starts its reply turn and is not held', async () => {
  const { c1, model, turns, mention, heartbeat } = lanes();
  const beat = heartbeat();
  await untilCalls(model, 1);
  assert.equal(model.calls.length, 1, 'the heartbeat reached the model');
  // The pipeline holds a call while the turn runner says a chat turn runs (src/pipeline/answer.ts).
  assert.equal(turns.isAnyBusy(), false, 'no chat turn runs');
  assert.equal(turns.isBusy('c1'), false);
  const reply = mention(c1, 'm1');
  await untilCalls(model, 2);
  assert.equal(model.calls.length, 2, 'the reply reached the model beside the heartbeat');
  model.answer(1, '<msg>hi</msg>');
  assert.equal((await reply).outcome, 'spoke');
  model.answer(0, '<skip/>');
  await beat;
});

test('a mention that arrives while a diary turn is in flight starts its reply turn and is not held', async () => {
  const { c1, model, turns, mention, diary } = lanes();
  const entry = diary();
  await untilCalls(model, 1);
  assert.equal(model.calls.length, 1, 'the diary reached the model');
  assert.equal(turns.isAnyBusy(), false, 'no chat turn runs');
  const reply = mention(c1, 'm1');
  await untilCalls(model, 2);
  assert.equal(model.calls.length, 2, 'the reply reached the model beside the diary');
  model.answer(1, '<msg>hi</msg>');
  assert.equal((await reply).outcome, 'spoke');
  model.answer(0, '<skip/>');
  await untilCalls(model, 3);
  model.answer(2, '<skip/>');
  await entry;
});

test('a heartbeat turn starts while a reply turn is in flight', async () => {
  const { c1, model, turns, mention, heartbeat } = lanes();
  const reply = mention(c1, 'm1');
  await untilCalls(model, 1);
  assert.equal(turns.isAnyBusy('service'), false, 'the service lane is free');
  const beat = heartbeat();
  await untilCalls(model, 2);
  assert.equal(model.calls.length, 2, 'the heartbeat reached the model beside the reply');
  model.answer(1, '<skip/>');
  assert.notEqual((await beat).outcome, 'busy');
  model.answer(0, '<msg>hi</msg>');
  await reply;
});

test('a diary turn that is due while a heartbeat turn is in flight is refused busy, and runs once the heartbeat ended', async () => {
  const { model, turns, heartbeat, diary } = lanes();
  const beat = heartbeat();
  await untilCalls(model, 1);
  assert.equal(turns.isAnyBusy('service'), true);
  assert.equal((await diary()).outcome, 'busy', 'one service turn at a time');
  assert.equal(model.calls.length, 1);
  model.answer(0, '<skip/>');
  await beat;
  assert.equal(turns.isAnyBusy('service'), false);
  const entry = diary();
  await untilCalls(model, 2);
  assert.equal(model.calls.length, 2, 'the diary reached the model after the heartbeat');
  model.answer(1, '<skip/>');
  await untilCalls(model, 3);
  model.answer(2, '<skip/>');
  assert.notEqual((await entry).outcome, 'busy');
});

test('an intention turn that is due while a reply turn is in flight is refused busy: it stays on the chat lane', async () => {
  const { c1, c2, model, mention, inner } = lanes();
  const reply = mention(c1, 'm1');
  await untilCalls(model, 1);
  assert.equal((await inner(DUE_WAKE, c2)).outcome, 'busy');
  assert.equal((await inner(DUE_WAKE)).outcome, 'busy', 'one with no place too');
  assert.equal(model.calls.length, 1);
  model.answer(0, '<msg>hi</msg>');
  await reply;
});

test('ending a service turn leaves the chat lane of a reply that still runs taken, and the reverse', async () => {
  const { c1, c2, model, turns, mention, heartbeat, diary } = lanes();
  const reply = mention(c1, 'm1');
  await untilCalls(model, 1);
  const beat = heartbeat();
  await untilCalls(model, 2);
  model.answer(1, '<skip/>');
  await beat;
  assert.equal(turns.isAnyBusy(), true, 'the reply still holds the chat lane');
  assert.equal(turns.isBusy('c1'), true);
  assert.equal((await mention(c2, 'm2')).outcome, 'busy');
  model.answer(0, '<msg>hi</msg>');
  await reply;

  const beatAgain = heartbeat();
  await untilCalls(model, 3);
  const replyAgain = mention(c1, 'm1');
  await untilCalls(model, 4);
  model.answer(3, '<msg>hi</msg>');
  await replyAgain;
  assert.equal(turns.isAnyBusy(), false);
  assert.equal(turns.isAnyBusy('service'), true, 'the heartbeat still holds the service lane');
  assert.equal((await diary()).outcome, 'busy');
  model.answer(2, '<skip/>');
  await beatAgain;
});

test('the end of a service turn starts no drain of held calls; the end of a chat turn does', async () => {
  const { c1, model, turns, mention, heartbeat } = lanes();
  let idle = 0;
  turns.setOnIdle(() => {
    idle += 1;
  });
  const beat = heartbeat();
  await untilCalls(model, 1);
  model.answer(0, '<skip/>');
  await beat;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idle, 0);
  const reply = mention(c1, 'm1');
  await untilCalls(model, 2);
  model.answer(1, '<msg>hi</msg>');
  await reply;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idle, 1);
});

test('the pause waits for a service turn too: waitIdle resolves once both lanes are free', async () => {
  const { model, turns, heartbeat } = lanes();
  const beat = heartbeat();
  await untilCalls(model, 1);
  let idle = false;
  void turns.waitIdle().then(() => {
    idle = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idle, false, 'the heartbeat still runs');
  model.answer(0, '<skip/>');
  await beat;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idle, true);
});

// --- The inner drain ---------------------------------------------------------------------------

const BEAT = { enabled: true, everyMinutes: 180, jitterMinutes: 60 };

/** Fake turns of the inner rig whose `isAnyBusy(lane)` says only the chat lane is taken. */
function chatLaneTaken() {
  const turns = fakeTurns();
  return Object.assign(turns, { isAnyBusy: (lane: string = 'chat') => lane === 'chat' });
}

test('inner drain: a heartbeat that is due while a reply turn is in flight starts', async () => {
  clock.t = NOW;
  const turns = chatLaneTaken();
  const run = setup({ turns, hot: hotWith({ heartbeat: BEAT }), rng: () => 0.5 });
  await run.inner.tick();
  clock.t = NOW + 181 * MINUTE_MS;
  await run.inner.tick();
  assert.deepEqual(
    turns.calls.map(({ inner }: InnerTurnParams) => inner.wake.kind),
    ['heartbeat']
  );
});

test('inner drain: an intention wake that is due while a reply turn is in flight is still deferred busy', async () => {
  clock.t = NOW;
  const turns = chatLaneTaken();
  const run = setup({ turns, records: [intention('i1', { dueAt: NOW - 5 * MINUTE_MS })] });
  const held = await run.inner.tick();
  assert.deepEqual(held.drained, { deferred: 'busy' });
  assert.equal(turns.calls.length, 0);
  assert.equal(run.inner.status().queue.length, 1);
});

test('inner drain: a heartbeat is not held behind people waiting for the chat lane', async () => {
  clock.t = NOW;
  const turns = fakeTurns();
  const run = setup({ turns, hot: hotWith({ heartbeat: BEAT }), rng: () => 0.5, peopleWaiting: () => true });
  await run.inner.tick();
  clock.t = NOW + 181 * MINUTE_MS;
  await run.inner.tick();
  assert.equal(turns.calls.length, 1);
});

// --- The leases ----------------------------------------------------------------------------------

test('a service turn holds a lease of its own name beside the chat lane, so another process sees both', async () => {
  const T = Date.parse('2026-10-31T12:00:00.000Z');
  const handle = openMemoryDb(':memory:');
  try {
    const memoryDb = { memoryWrite: (update: unknown) => Promise.resolve(applyWakeQueueWrite(handle, update)) };
    const hot = { config: { context: { turnLeaseMs: 300_000 } } };
    const options = { memoryDb, hot, holder: 'core-a', now: () => T, log: { warn() {} } };
    const attention = {
      chat: createLeasedAttention({ ...options, lane: 'chat' }),
      service: createLeasedAttention({ ...options, lane: 'service' }),
    };
    attention.chat.add('c1');
    attention.service.add('persona');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(leaseOf(handle, 'attention:*')?.expiresAt, T + 300_000);
    assert.equal(leaseOf(handle, 'attention:service')?.expiresAt, T + 300_000);
    attention.service.delete('persona');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(leaseOf(handle, 'attention:service')?.expiresAt, T, 'the service lease is released');
    assert.equal(leaseOf(handle, 'attention:*')?.expiresAt, T + 300_000, 'the chat lease stays');
    attention.chat.delete('c1');
  } finally {
    handle.close();
  }
});
