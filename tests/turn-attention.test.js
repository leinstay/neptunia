// Tests for the "one attention" rail in src/behavior/turn.js:
// isAnyBusy(), the busy-elsewhere refusal (mention.oneAtATime), and
// setOnIdle(). Kept in its own file (rather than tests/turn.test.js)
// deliberately: its fixtures are otherwise identical to turn.test.js's, but
// living alongside that file's ~40 other cases made a couple of these tests
// never get scheduled by node's test runner in this environment (verified
// with instrumentation: the test body simply never ran) -- a harness quirk,
// not a bug in the tests or in the code under test. In isolation, in this
// smaller file, every test here runs reliably.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner as createRealTurnRunner } from '../src/behavior/turn.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { onWorld, world } from './fixtures/turn-world.ts';

const createTurnRunner = onWorld(createRealTurnRunner);

/** A discord.js-shaped raw message, just enough for normalizeMessage. */
function rawMessage({ id, authorId = 'u1', authorName = 'Alice', ts = Date.now() - 1000, content = 'hey bot' }) {
  return {
    id,
    channelId: 'c1',
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
}

/** The normalized shape pipeline.js would hand to runTurn as `trigger`. */
function normalizedTrigger(raw) {
  return {
    id: raw.id,
    channelId: raw.channelId,
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

function fakeTurnChannel({ id = 'c1', name = 'general', guildId = 'g1', historyMessages = [], ...more } = {}) {
  return world().channel({ id, name, guildId, historyMessages, ...more });
}

function fakeStore() {
  return {
    getGuild: () => ({}),
    getUser: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    state: { data: {}, markDirty() {} },
  };
}

function identityCalibrator() {
  return { ratio: 1, apply: (n) => n, observe: () => {} };
}

function fakeHot(configOverrides = {}) {
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
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      features: {},
      media: { maxPerTurn: 6, filePreviewChars: 500 },
      mention: { oneAtATime: true },
      ...configOverrides,
    },
    prompts: {
      'system-prompt': 'You are a regular member of this chat, not an assistant.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      interject: 'Jump into the conversation.',
      initiate: 'Start a topic.',
      memory: 'Summarize what happened.',
      labels,
    },
  };
}

function fakeLlm(responseText) {
  const calls = [];
  return {
    calls,
    complete: async (messages) => {
      calls.push(messages);
      return { text: responseText, usage: {}, estimated: 10 };
    },
  };
}

/** An LLM whose `complete()` never resolves on its own -- resolveNext() finishes the oldest pending call. */
function controllableLlm(responseText = '<msg>ok</msg>') {
  const calls = [];
  const pendingResolvers = [];
  return {
    calls,
    complete: (messages) => {
      calls.push(messages);
      return new Promise((resolve) => pendingResolvers.push(resolve));
    },
    resolveNext() {
      const resolve = pendingResolvers.shift();
      if (resolve) resolve({ text: responseText, usage: {}, estimated: 10 });
    },
  };
}

/** Waits (microtask by microtask, no real timer) until `llm.calls.length` reaches `count`. */
async function waitForCalls(llm, count) {
  for (let i = 0; i < 200 && llm.calls.length < count; i += 1) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// isAnyBusy() / busy-elsewhere refusal (mention.oneAtATime)

test('createTurnRunner: a turn in another channel is refused as busy while one is running (mention.oneAtATime on)', async () => {
  const raw1 = rawMessage({ id: 'm1' });
  const channel1 = fakeTurnChannel({ id: 'c1', historyMessages: [raw1] });
  const raw2 = rawMessage({ id: 'm2', authorId: 'u2' });
  const channel2 = fakeTurnChannel({ id: 'c2', historyMessages: [raw2] });
  const llm = controllableLlm();
  const store = fakeStore();
  const hot = fakeHot({});
  const turns = createTurnRunner({
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
  });

  const firstPromise = turns.runTurn({
    channel: channel1,
    mode: 'reply',
    trigger: normalizedTrigger(raw1),
    triggerKind: 'mention',
  });
  assert.equal(turns.isAnyBusy(), true, 'busy.add happens synchronously before the first await');

  const secondResult = await turns.runTurn({
    channel: channel2,
    mode: 'reply',
    trigger: normalizedTrigger(raw2),
    triggerKind: 'mention',
  });
  assert.equal(secondResult.outcome, 'busy');
  assert.equal(channel2.sent.length, 0);

  await waitForCalls(llm, 1);
  llm.resolveNext();
  const firstResult = await firstPromise;
  assert.equal(firstResult.outcome, 'spoke');
  assert.equal(turns.isAnyBusy(), false, 'the channel is freed once the turn finishes');
});

test('createTurnRunner: the SAME channel is still refused as busy exactly as before oneAtATime existed', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = controllableLlm();
  const store = fakeStore();
  const hot = fakeHot({});
  const turns = createTurnRunner({
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
  });

  const firstPromise = turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(raw),
    triggerKind: 'mention',
  });
  const secondResult = await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(raw),
    triggerKind: 'mention',
  });
  assert.equal(secondResult.outcome, 'busy');

  await waitForCalls(llm, 1);
  llm.resolveNext();
  await firstPromise;
});

test("createTurnRunner: mention.oneAtATime=false lets two different channels run concurrently (today's behaviour)", async () => {
  const raw1 = rawMessage({ id: 'm1' });
  const channel1 = fakeTurnChannel({ id: 'c1', historyMessages: [raw1] });
  const raw2 = rawMessage({ id: 'm2', authorId: 'u2' });
  const channel2 = fakeTurnChannel({ id: 'c2', historyMessages: [raw2] });
  const llm = controllableLlm();
  const store = fakeStore();
  const hot = fakeHot({ mention: { oneAtATime: false } });
  const turns = createTurnRunner({
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
  });

  const firstPromise = turns.runTurn({
    channel: channel1,
    mode: 'reply',
    trigger: normalizedTrigger(raw1),
    triggerKind: 'mention',
  });
  const secondPromise = turns.runTurn({
    channel: channel2,
    mode: 'reply',
    trigger: normalizedTrigger(raw2),
    triggerKind: 'mention',
  });

  await waitForCalls(llm, 2);
  assert.equal(llm.calls.length, 2, 'both turns must have reached the model, neither blocked the other');

  llm.resolveNext();
  llm.resolveNext();
  const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(firstResult.outcome, 'spoke');
  assert.equal(secondResult.outcome, 'spoke');
});

test('createTurnRunner: a hot change to mention.oneAtATime is picked up without recreating the runner', async () => {
  const raw1 = rawMessage({ id: 'm1' });
  const channel1 = fakeTurnChannel({ id: 'c1', historyMessages: [raw1] });
  const raw2 = rawMessage({ id: 'm2', authorId: 'u2' });
  const channel2 = fakeTurnChannel({ id: 'c2', historyMessages: [raw2] });
  const llm = controllableLlm();
  const store = fakeStore();
  const hot = fakeHot({});
  const turns = createTurnRunner({
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
  });

  const firstPromise = turns.runTurn({
    channel: channel1,
    mode: 'reply',
    trigger: normalizedTrigger(raw1),
    triggerKind: 'mention',
  });
  const busyResult = await turns.runTurn({
    channel: channel2,
    mode: 'reply',
    trigger: normalizedTrigger(raw2),
    triggerKind: 'mention',
  });
  assert.equal(busyResult.outcome, 'busy', 'oneAtATime true: channel2 is refused');

  hot.config.mention = { oneAtATime: false };
  const secondPromise = turns.runTurn({
    channel: channel2,
    mode: 'reply',
    trigger: normalizedTrigger(raw2),
    triggerKind: 'mention',
  });
  await waitForCalls(llm, 2);
  assert.equal(llm.calls.length, 2, 'once flipped off, the second channel is no longer refused');

  llm.resolveNext();
  llm.resolveNext();
  await Promise.all([firstPromise, secondPromise]);
});

// ---------------------------------------------------------------------------
// setOnIdle()

test('createTurnRunner: setOnIdle fires once a turn finishes, after the channel is freed', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  const turns = createTurnRunner({
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
  });

  let seenBusyOnIdle = null;
  let idleCalls = 0;
  turns.setOnIdle(() => {
    idleCalls += 1;
    seenBusyOnIdle = turns.isAnyBusy();
  });

  const result = await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(raw),
    triggerKind: 'mention',
  });
  assert.equal(result.outcome, 'spoke');

  // onIdle is fired fire-and-forget (a microtask), not awaited by runTurn.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(idleCalls, 1);
  assert.equal(seenBusyOnIdle, false);
});

test('createTurnRunner: a throwing onIdle is logged, never thrown into the caller of runTurn', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  const turns = createTurnRunner({
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
  });
  turns.setOnIdle(() => {
    throw new Error('boom');
  });

  const { result, logs } = await withCapturedLogs(async () => {
    const r = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
    await Promise.resolve();
    await Promise.resolve();
    return r;
  });

  assert.equal(result.outcome, 'spoke');
  assert.ok(logs.some((l) => l.msg === 'turn: onIdle failed'));
});

test('createTurnRunner: with no onIdle set, a turn finishes without throwing', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  const turns = createTurnRunner({
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
  });

  // The idle notification runs fire-and-forget behind a .catch, so a missing guard would not
  // reject runTurn: it would only log 'turn: onIdle failed'. Capture past that microtask.
  const { result, logs } = await withCapturedLogs(async () => {
    const r = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
    await new Promise((resolve) => setImmediate(resolve));
    return r;
  });

  assert.equal(result.outcome, 'spoke');
  assert.equal(
    logs.some((l) => l.msg === 'turn: onIdle failed'),
    false,
    'no idle callback is called when none is set'
  );
});

// ---------------------------------------------------------------------------
// spokeAfterSeeing() -- the pending-ping drain's double-answer check

test('createTurnRunner: spokeAfterSeeing is true for a message in the history of the last turn that spoke there', async () => {
  const raw1 = rawMessage({ id: 'm1' });
  const raw2 = rawMessage({ id: 'm2', authorId: 'u2' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw1, raw2] });
  const turns = createTurnRunner({
    hot: fakeHot({}),
    store: fakeStore(),
    llm: fakeLlm('<msg>ok</msg>'),
    calibrator: identityCalibrator(),
  });

  assert.equal(turns.spokeAfterSeeing('c1', 'm2'), false, 'no turn has spoken yet');
  const result = await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(raw1),
    triggerKind: 'mention',
  });

  assert.equal(result.outcome, 'spoke');
  assert.equal(turns.spokeAfterSeeing('c1', 'm2'), true);
  assert.equal(turns.spokeAfterSeeing('c1', 'm3'), false, 'not in that history');
  assert.equal(turns.spokeAfterSeeing('c2', 'm2'), false, 'another channel');
});

// ---------------------------------------------------------------------------
// A routed turn: a call from a channel the bot cannot write in, answered in another one.

test('turn: a routed turn marks the destination busy, not the source', async () => {
  const destination = fakeTurnChannel({
    id: 'c1',
    historyMessages: [rawMessage({ id: 'm1', authorId: 'u2', authorName: 'Bob' })],
  });
  const call = { ...rawMessage({ id: 'd1', authorName: 'Éloïse', content: '@Bot εδώ;' }), channelId: 'c2' };
  // The source: a readable text channel of the same guild where the bot may not send.
  fakeTurnChannel({ id: 'c2', name: 'diary', historyMessages: [call], permissions: { send: false } });
  const llm = controllableLlm();
  const turns = createTurnRunner({
    hot: fakeHot({}),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
  });

  const running = withCapturedLogs(() =>
    turns.runTurn({
      channel: destination,
      mode: 'reply',
      trigger: normalizedTrigger(call),
      triggerKind: 'mention',
      source: { channelId: 'c2', reason: 'routed' },
    })
  );
  await waitForCalls(llm, 1);
  assert.equal(llm.calls.length, 1, 'the turn reached the model');
  assert.equal(turns.isBusy('c1'), true, 'the destination is busy');
  assert.equal(turns.isBusy('c2'), false, 'the source is not');

  llm.resolveNext();
  const { result } = await running;
  assert.equal(result.outcome, 'spoke');
  assert.equal(turns.isAnyBusy(), false);
});

test('createTurnRunner: spokeAfterSeeing covers the source lines a routed turn showed, under the source', async () => {
  const destination = fakeTurnChannel({
    id: 'c1',
    historyMessages: [rawMessage({ id: 'm1', authorId: 'u2', authorName: 'Bob' })],
  });
  const earlier = {
    ...rawMessage({ id: 'd1', authorId: 'u3', authorName: 'Zoë', ts: Date.now() - 5000, content: 'ο κήπος άνθισε' }),
    channelId: 'c2',
  };
  const call = { ...rawMessage({ id: 'd2', authorName: 'Éloïse', content: '@Bot εδώ;' }), channelId: 'c2' };
  fakeTurnChannel({ id: 'c2', name: 'diary', historyMessages: [earlier, call], permissions: { send: false } });
  const turns = createTurnRunner({
    hot: fakeHot({}),
    store: fakeStore(),
    llm: fakeLlm('<msg>ok</msg>'),
    calibrator: identityCalibrator(),
  });

  const { result } = await withCapturedLogs(() =>
    turns.runTurn({
      channel: destination,
      mode: 'reply',
      trigger: normalizedTrigger(call),
      triggerKind: 'mention',
      source: { channelId: 'c2', reason: 'routed' },
    })
  );

  assert.equal(result.outcome, 'spoke');
  assert.equal(turns.spokeAfterSeeing('c2', 'd1'), true, 'a call queued meanwhile and already in view');
  assert.equal(turns.spokeAfterSeeing('c2', 'd2'), true);
  assert.equal(turns.spokeAfterSeeing('c1', 'm1'), true, "the destination's history as before");
  assert.equal(turns.spokeAfterSeeing('c1', 'd1'), false, 'never under the destination');
});

test('createTurnRunner: spokeAfterSeeing stays false after a turn that chose to skip', async () => {
  const raw1 = rawMessage({ id: 'm1' });
  const raw2 = rawMessage({ id: 'm2', authorId: 'u2' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw1, raw2] });
  const turns = createTurnRunner({
    hot: fakeHot({}),
    store: fakeStore(),
    llm: fakeLlm('<skip/>'),
    calibrator: identityCalibrator(),
  });

  const result = await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(raw1),
    triggerKind: 'mention',
  });

  assert.equal(result.outcome, 'skip');
  assert.equal(turns.spokeAfterSeeing('c1', 'm2'), false);
});
