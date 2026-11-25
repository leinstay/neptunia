// Tests for src/errands/turns.ts: the turn an errand's end opens. An end reaches its result turn along three paths:
// the service reopening unseen ends at start, the door replaying an `errand.done` the core never marked delivered, and
// the retry timer of a turn that was held back. However they interleave, one end opens one turn. The first section runs
// `createErrandTurns` with a fake turn runner, fake reads and a fake timer, so every order is fixed. The second opens the
// persona's turn in the chat the errand was asked in, with `<errand_result>`, through the fake interface.
import assert from 'node:assert/strict';
import { test, after, describe, beforeEach } from 'node:test';
import { createErrandTurns, errandDoneEvent, RESULT_ATTEMPTS } from '../../../src/errands/turns.ts';
import type { ErrandRecord } from '../../../src/errands/types.ts';
import type { Reads } from '../../../src/interface/reads.ts';
import { userText } from '../../../src/behavior/prompt.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';

import { createEventDoor } from '../../../src/interface/door.ts';
import { validateEvent } from '../../../src/protocol/index.ts';
import { labels } from '../../fixtures/labels.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { useIface, world } from '../../fixtures/turn-world.ts';
import { createTurnRunner } from '../../fixtures/turn-runner.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { asRecord } from '../../fixtures/records.ts';
import { createTurnRunner as faultCreateTurnRunner } from '../../../src/behavior/turn.ts';
import { createReads } from '../../../src/interface/reads.ts';
import { createInnerLife } from '../../../src/behavior/inner.ts';
import { createDiscordInterface } from '../../../interfaces/discord/index.ts';
import { personaJournal } from '../../../src/behavior/inner/persona-sources.ts';
import { createErrandStores } from '../../../src/errands/store.ts';
import { createErrandService } from '../../../src/errands/service.ts';
import { runOp } from '../../../src/tools/operations/index.ts';
import { createOpsEnv } from '../../../src/tools/operations/env.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import { createAdmin } from '../../../src/admin.ts';
import { completionOf } from '../../fixtures/tool-answers.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { openTestMemorySync } from '../../fixtures/memory-db/service.ts';
import { wrongly, present } from '../../fixtures/loose-types.ts';
import { OWNER_PERSON, ownedBy } from '../../fixtures/owner-accounts.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';

const T0 = Date.UTC(2026, 10, 5, 9, 0, 0);
const MINUTE = 60_000;

const ERRAND = {
  id: 'errand-1',
  agent: 'scout',
  goal: 'find the opening hours',
  state: 'done',
  requester: { accountId: 'u1', kind: 'member' },
  origin: { placeId: 'c1' },
} as unknown as ErrandRecord;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function rig({ busy = () => false }: { busy?: () => boolean } = {}) {
  let now = T0;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const turns: Array<Record<string, unknown>> = [];
  const held: Array<(outcome: string) => void> = [];
  const failed: Array<string> = [];
  let hold = false;
  const read = new Set<string>();
  const service = createErrandTurns({
    hot: { config: { errands: { resultRetrySeconds: 30 } } },
    // The fake holds the two reads a result turn uses.
    reads: {
      chatInfo: () => Promise.resolve({ id: 'c1' }),
      fetchMessages: () => Promise.resolve({ messages: [] }),
    } as unknown as Reads,
    iface: () => 'fake',
    turns: {
      isBusy: busy,
      isAnyBusy: busy,
      runTurn: (input) => {
        turns.push(input);
        if (!hold) return Promise.resolve({ outcome: 'spoke' });
        return new Promise((resolve) => held.push((outcome) => resolve({ outcome })));
      },
    },
    errands: {
      markSeen: () => 1,
      markRead: ({ ids = [] }: { ids?: ReadonlyArray<string> }) => {
        for (const id of ids) read.add(id);
        return ids.length;
      },
      markResultFailed: ({ ids = [] }: { ids?: ReadonlyArray<string> }) => {
        failed.push(...ids);
        return ids.length;
      },
      store: () =>
        ({ get: (id: string) => (read.has(id) ? { ...ERRAND, readAt: now } : ERRAND) }) as unknown as ReturnType<
          NonNullable<Parameters<typeof createErrandTurns>[0]['errands']>['store'] & object
        >,
    } as Parameters<typeof createErrandTurns>[0]['errands'],
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { at: now + ms, fn, live: true };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
  });
  return {
    service,
    turns,
    read,
    failed,
    /** The timers armed and not yet fired. */
    armed: () => timers.filter((one) => one.live).length,
    holdTurns: () => {
      hold = true;
    },
    finishHeld: (outcome = 'spoke') => {
      for (const finish of held.splice(0)) finish(outcome);
    },
    /** Moves the clock and fires every timer due by then. */
    advance: async (ms: number): Promise<void> => {
      now += ms;
      for (const timer of timers.filter((one) => one.live && one.at <= now)) {
        timer.live = false;
        timer.fn();
        await settle();
      }
    },
  };
}

test('new reproduction: the restart reopening an end and the door replaying it open one turn', async () => {
  // Bug: at a restart `start` calls onFinished for an unseen end while the door replays its errand.done, and neither
  // knows of the other, so two result turns answer one errand and the persona repeats it in the channel.
  const { service, turns, holdTurns, finishHeld } = rig();
  holdTurns();
  const reopened = service.onFinished(ERRAND);
  const replayed = service.onEvent(errandDoneEvent(ERRAND, () => T0));
  await settle();
  finishHeld();
  await settle();
  await Promise.all([reopened, replayed]);
  assert.equal(turns.length, 1);
});

test('new reproduction: the same end replayed while its first turn runs opens no second turn', async () => {
  // Bug: `readAt` is only written when the turn ends, so a second delivery during the turn finds the end unread.
  const { service, turns, holdTurns, finishHeld, advance } = rig();
  holdTurns();
  const first = service.onEvent(errandDoneEvent(ERRAND, () => T0));
  await settle();
  await service.onEvent(errandDoneEvent(ERRAND, () => T0 + 1));
  await settle();
  finishHeld();
  await first;
  await advance(2 * MINUTE);
  finishHeld();
  await settle();
  assert.equal(turns.length, 1);
});

test('new reproduction: a retry timer that fires after the end was read opens no turn', async () => {
  // Bug: the timer holds the errand as it was when the turn was held back, and never asks whether the persona has read it since.
  let busy = true;
  const { service, turns, read, advance } = rig({ busy: () => busy });
  await service.onEvent(errandDoneEvent(ERRAND, () => T0));
  assert.equal(turns.length, 0, 'held back by the attention');
  busy = false;
  read.add(ERRAND.id);
  await advance(MINUTE);
  assert.equal(turns.length, 0);
});

test('new reproduction: two deliveries held back at once arm one retry, so one turn comes of them', async () => {
  // Bug: the second retry overwrites the first in `waiting`, both timers stay armed, stop clears only the last, and
  // when the attention frees up each opens a turn.
  let busy = true;
  const { service, turns, advance } = rig({ busy: () => busy });
  await service.onEvent(errandDoneEvent(ERRAND, () => T0));
  await service.onEvent(errandDoneEvent(ERRAND, () => T0 + 1));
  busy = false;
  await advance(MINUTE);
  await advance(2 * MINUTE);
  assert.equal(turns.length, 1);
});

test('a result turn that fails after the stop arms no retry and leaves the result unread', async () => {
  // Bug: the core's stop clears the timers armed so far, but a result turn still running comes back `error` and arms a
  // new timer on the stopped service, which opens the turn again every `errands.resultRetrySeconds`.
  const { service, read, failed, armed, holdTurns, finishHeld } = rig();
  holdTurns();
  const running = service.onFinished(ERRAND);
  await settle();
  service.stop();
  finishHeld('error');
  await running;
  assert.equal(armed(), 0, 'the stopped service armed a retry');
  assert.deepEqual([read.has(ERRAND.id), failed], [false, []], 'the result is left unread for the next start');
});

test('an end that reaches the stopped service opens no result turn', async () => {
  // Bug: the stop closes the errand client, which ends every running errand `disconnected`, and each end opened its
  // result turn on the service the core had stopped.
  const { service, turns, armed } = rig();
  service.stop();
  await service.onEvent(errandDoneEvent(ERRAND, () => T0));
  assert.deepEqual([turns.length, armed()], [0, 0]);
});

// The casts through `Parameters<typeof f>` hand a function a fake that carries only the fields the test reads.

// The chats are held by a fake interface named `fake`.
useIface('fake');

const TURNS_NOW = Date.parse('2026-10-17T12:00:00Z');
const TURNS_MINUTE = 60_000;

/** A discord.js-shaped raw message, just enough for normalizeMessage. */
function rawMessage({
  id,
  authorId = 'u1',
  authorName = 'Zoë',
  ts = TURNS_NOW - 10 * TURNS_MINUTE,
  content = 'βρες μου κάτι',
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

/** A channel of guild g1 whose history is `historyMessages`; `fetch(id)` gives one of them. */
function fakeChannel({ historyMessages = [] }: { historyMessages?: Array<Record<string, unknown>> } = {}) {
  return world().channel({ id: 'c1', name: 'general', placeId: 'g1', historyMessages });
}

function fakeStore() {
  return {
    getPlace: () => ({}),
    getUser: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    liveRules: () => [],
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
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      features: { typingSimulation: false },
      media: { maxPerTurn: 6, filePreviewChars: 500 },
      mention: { oneAtATime: true },
      errands: { resultMaxChars: 40, resultCooldownSeconds: 60, resultRetrySeconds: 30 },
    },
    prompts: {
      main: 'You are a regular member of this chat, not an assistant.',
      persona: 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      'turn/reply': 'Someone called you: {{author}}.',
      interject: 'Jump into the chat.',
      initiate: 'Start a topic.',
      labels,
    },
  };
}

function fakeLlm(responseText: string) {
  const calls: Array<Untyped> = [];
  return {
    calls,
    complete: async (messages: unknown) => {
      calls.push(messages);
      return { text: responseText, usage: {}, estimated: 10 };
    },
  };
}

/** The errand service as the turn sees it: `view` lists `tasks`, `markSeen` is recorded. */
function fakeErrands(tasks = []) {
  const seen: Array<{ ids: Array<string> }> = [];
  const read: Array<{ ids: Array<string> }> = [];
  const failed: Array<{ ids: Array<string> }> = [];
  return {
    tasks,
    seen,
    read,
    failed,
    view: () => tasks,
    markSeen: ({ ids }: { ids: Array<string> }) => seen.push({ ids }),
    markRead: ({ ids }: { ids: Array<string> }) => read.push({ ids }),
    markResultFailed: ({ ids }: { ids: Array<string> }) => failed.push({ ids }),
    budget: () => ({ spent: false }),
    fileOf: () => null,
  };
}

const doneTask = {
  id: 'tab02',
  agent: 'scout',
  goal: 'find a meme',
  state: 'done',
  createdAt: TURNS_NOW - 3 * TURNS_MINUTE,
  origin: { placeId: 'c1', messageId: 'm1' },
  requester: { accountId: 'u1', kind: 'member' },
  scope: 'group',
  result: {
    text: 'Found one on a public board; it is about cats and keyboards, posted this morning.',
    sources: ['https://example.org/board/1', 'https://example.org/board/2'],
    files: [{ path: '/elsewhere/meme.png', name: 'meme.png', contentType: 'image/png', bytes: 2048 }],
  },
  error: null,
  usage: { usd: 0.02, steps: 4 },
};

// A text over its bound is summarized or kept whole, never cut.
test("task turns: a finished errand opens the persona's turn where it was asked, with <errand_result>, through the interface", async () => {
  const raw = rawMessage({ id: 'm1', content: 'βρες μου ένα meme' });
  fakeChannel({ historyMessages: [raw] });
  const errands = fakeErrands([doneTask] as unknown as Parameters<typeof fakeErrands>[0]);
  const llm = fakeLlm('<msg reply="#1">βρήκα κάτι</msg>');
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id' });
  const hot = fakeHot();
  const turns = createTurnRunner({
    hot,
    store: fakeStore(),
    llm,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    port,
    errands,
    now: () => TURNS_NOW,
  });
  const taskTurns = createErrandTurns({
    hot,
    reads: world().reads,
    iface: () => 'fake',
    turns,
    // @ts-expect-error: the fake errand service carries the few members a turn reads
    errands,
    isServedRoot: (id: unknown) => id === 'g1',
    now: () => TURNS_NOW,
  });
  const { result } = await withCapturedLogs(() =>
    taskTurns.onFinished(doneTask as unknown as Parameters<typeof taskTurns.onFinished>[0])
  );
  assert.equal(result?.outcome, 'spoke');
  assert.equal(llm.calls.length, 1);
  const [call] = llm.calls;
  const text = userText(call[1].content);
  assert.ok(
    text.includes('<errand_result>\nerrand tab02 (scout) ended done: find a meme\nresult:\n'),
    'the block, its header first'
  );
  assert.ok(
    text.includes('sources:\n1. https://example.org/board/1\n2. https://example.org/board/2'),
    'the sources numbered'
  );
  assert.ok(text.includes('files:\nfile:tab02/meme.png | image/png | 2048 bytes'), 'the file as its handle');
  assert.ok(
    text.includes('posted this morning'),
    'with no summarizer the result over errands.resultMaxChars is kept whole'
  );
  assert.equal(text.includes('<errands>'), false, 'the errand of this turn is not listed twice');
  const sends = port.calls.filter((call) => call.op === 'send');
  assert.equal(sends.length, 1);
  const [send] = sends;
  assert.equal(asRecord(send.args[1]).text, 'βρήκα κάτι');
  assert.deepEqual(
    asRecord(send.args[1]).replyTo,
    { iface: 'fake', chatId: 'c1', messageId: 'm1' },
    'the answer replies to the message that asked'
  );
  assert.deepEqual(errands.seen.at(-1), { ids: ['tab02'] });
});

test('task turns: held back while the attention is taken, tried again after errands.resultRetrySeconds', async () => {
  const runs: Array<Untyped> = [];
  let busy = true;
  const turns = {
    isBusy: () => false,
    isAnyBusy: () => busy,
    runTurn: async (params: unknown) => {
      runs.push(params);
      return { outcome: 'skip' };
    },
  };
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const errands = fakeErrands();
  fakeChannel({ historyMessages: [rawMessage({ id: 'm1' })] });
  const taskTurns = createErrandTurns({
    hot: fakeHot(),
    reads: world().reads,
    iface: () => 'fake',
    turns,
    errands,
    now: () => TURNS_NOW,
    setTimer: (fn: () => void, ms: number) => timers.push({ fn, ms }),
  } as unknown as Parameters<typeof createErrandTurns>[0]);
  await withCapturedLogs(async () => {
    await taskTurns.onFinished(doneTask as unknown as Parameters<typeof taskTurns.onFinished>[0]);
    assert.equal(runs.length, 0, 'nothing runs while a turn holds the attention');
    assert.deepEqual(
      timers.map((t) => t.ms),
      [30_000]
    );
    busy = false;
    timers.shift()?.fn();
    for (let i = 0; i < 50 && runs.length === 0; i += 1) await new Promise((r) => setImmediate(r));
  });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].triggerKind, 'errand');
  assert.equal(runs[0].mode, 'reply');
  const [run] = runs;
  assert.equal(run.trigger.id, 'm1');
  assert.equal(run.taskResult.id, 'tab02');
  assert.deepEqual(runs[0].requester, { id: 'u1' });
  assert.deepEqual(errands.seen, [{ ids: ['tab02'] }]);
});

test('task turns: an errand end enters through the event door as errand.done, once, and opens the same turn', async () => {
  const runs: Array<Untyped> = [];
  const turns = {
    isBusy: () => false,
    isAnyBusy: () => false,
    runTurn: async (params: unknown) => {
      runs.push(params);
      return { outcome: 'spoke' };
    },
  };
  fakeChannel({ historyMessages: [rawMessage({ id: 'm1' })] });
  const errands = fakeErrands();
  const taskTurns = createErrandTurns({
    hot: fakeHot(),
    reads: world().reads,
    iface: () => 'fake',
    turns,
    // @ts-expect-error: the fake errand service carries the few members a turn reads
    errands,
    now: () => TURNS_NOW,
  });
  const door = createEventDoor({ handlers: { 'errand.done': (event) => taskTurns.onEvent(event) } });
  const event = errandDoneEvent(doneTask as unknown as Parameters<typeof errandDoneEvent>[0], () => TURNS_NOW);
  assert.deepEqual(validateEvent(event), { ok: true });
  assert.deepEqual(
    { ...event, raw: undefined },
    { kind: 'errand.done', at: TURNS_NOW, errandId: 'tab02', status: 'done', raw: undefined }
  );
  const first = await withCapturedLogs(() => door.submit(event));
  assert.equal(first.result.status, 'ok');
  assert.deepEqual(
    (
      await door.submit(
        errandDoneEvent(doneTask as unknown as Parameters<typeof errandDoneEvent>[0], () => TURNS_NOW + 5)
      )
    ).status,
    'duplicate',
    'the same end delivered twice runs no second turn'
  );
  assert.equal(runs.length, 1);
  assert.equal(runs[0].triggerKind, 'errand');
  const [run] = runs;
  assert.equal(run.taskResult.id, 'tab02');
  assert.deepEqual(errands.seen, [{ ids: ['tab02'] }]);
});

test("task turns: an event without the task in hand asks the guild's task store; an unknown task opens nothing", async () => {
  const runs: Array<Untyped> = [];
  const turns = {
    isBusy: () => false,
    isAnyBusy: () => false,
    runTurn: async (params: unknown) => {
      runs.push(params);
      return { outcome: 'spoke' };
    },
  };
  fakeChannel({ historyMessages: [rawMessage({ id: 'm1' })] });
  const errands = {
    ...fakeErrands(),
    store: () => ({ get: (id: string) => (id === 'tab02' ? doneTask : null) }),
  };
  const taskTurns = createErrandTurns({
    hot: fakeHot(),
    reads: world().reads,
    iface: () => 'fake',
    turns,
    errands,
    now: () => TURNS_NOW,
  } as unknown as Parameters<typeof createErrandTurns>[0]);
  const { raw: _raw, ...bare } = errandDoneEvent(
    doneTask as unknown as Parameters<typeof errandDoneEvent>[0],
    () => TURNS_NOW
  );
  await withCapturedLogs(async () => {
    assert.equal(
      await taskTurns.onEvent({ ...bare, errandId: 'nope' } as unknown as Parameters<typeof taskTurns.onEvent>[0]),
      null
    );
    assert.equal(runs.length, 0);
    await taskTurns.onEvent(bare as unknown as Parameters<typeof taskTurns.onEvent>[0]);
  });
  assert.equal(runs.length, 1);
  const [run] = runs;
  assert.equal(run.taskResult.id, 'tab02');
});

/** Let the promises a fired timer started run. */
async function flush() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('task turns: a result turn that spoke or chose silence marks the task seen and read', async () => {
  for (const outcome of ['spoke', 'skip']) {
    const errands = fakeErrands();
    const turns = { isBusy: () => false, isAnyBusy: () => false, runTurn: async () => ({ outcome }) };
    fakeChannel({ historyMessages: [rawMessage({ id: 'm1' })] });
    const taskTurns = createErrandTurns({
      hot: fakeHot(),
      reads: world().reads,
      iface: () => 'fake',
      turns,
      errands,
      now: () => TURNS_NOW,
      setTimer: () => null,
    } as unknown as Parameters<typeof createErrandTurns>[0]);
    await withCapturedLogs(() =>
      taskTurns.onFinished(doneTask as unknown as Parameters<typeof taskTurns.onFinished>[0])
    );
    assert.deepEqual(errands.seen, [{ ids: ['tab02'] }], outcome);
    assert.deepEqual(errands.read, [{ ids: ['tab02'] }], outcome);
  }
});

test('task turns: an unread end with no place runs a result turn with no chat and marks it read', async () => {
  // Bug caught: an errand started in a heartbeat or from a console with no place ends and never reaches the persona.
  const errands = fakeErrands();
  const llm = fakeLlm('<skip/>');
  const hot = fakeHot();
  const turns = createTurnRunner({
    hot,
    store: fakeStore(),
    llm,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    port: createFakeAdapter({ iface: 'fake', selfId: 'self-id' }),
    errands,
    now: () => TURNS_NOW,
  });
  const taskTurns = createErrandTurns({
    hot,
    reads: world().reads,
    iface: () => 'fake',
    turns,
    // @ts-expect-error: the fake errand service carries the few members a turn reads
    errands,
    now: () => TURNS_NOW,
  });
  const nowhere = { ...doneTask, origin: { placeId: null, messageId: null } };
  const { result } = await withCapturedLogs(() =>
    taskTurns.onFinished(nowhere as unknown as Parameters<typeof taskTurns.onFinished>[0])
  );
  assert.equal(result?.outcome, 'skip');
  const text = JSON.stringify(llm.calls[0]);
  assert.deepEqual([text.includes('<errand_result>'), text.includes('<chat>')], [true, false]);
  assert.deepEqual(errands.read, [{ ids: ['tab02'] }]);
});

test('task turns: a result turn that ended error or refused marks nothing and is tried again', async () => {
  const outcomes = [{ outcome: 'error' }, { outcome: 'refused' }, { outcome: 'spoke' }];
  const runs = [];
  const turns = {
    isBusy: () => false,
    isAnyBusy: () => false,
    runTurn: async (params: unknown) => {
      runs.push(params);
      return outcomes[runs.length - 1];
    },
  };
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const errands = fakeErrands();
  fakeChannel({ historyMessages: [rawMessage({ id: 'm1' })] });
  const taskTurns = createErrandTurns({
    hot: fakeHot(),
    reads: world().reads,
    iface: () => 'fake',
    turns,
    errands,
    now: () => TURNS_NOW,
    setTimer: (fn: () => void, ms: number) => timers.push({ fn, ms }),
  } as unknown as Parameters<typeof createErrandTurns>[0]);
  await withCapturedLogs(async () => {
    await taskTurns.onFinished(doneTask as unknown as Parameters<typeof taskTurns.onFinished>[0]);
    assert.deepEqual(
      [errands.seen.length, errands.read.length, timers.length],
      [0, 0, 1],
      'error: nothing marked, a retry waits'
    );
    timers.shift()?.fn();
    await flush();
    assert.deepEqual([errands.seen.length, errands.read.length, timers.length], [0, 0, 1], 'refused: the same');
    timers.shift()?.fn();
    await flush();
  });
  assert.equal(runs.length, 3);
  assert.deepEqual(errands.read, [{ ids: ['tab02'] }], 'the third try spoke: read');
});

test('task turns: after the attempts a result that never got its turn stays unread and is noted as failed', async () => {
  const turns = { isBusy: () => false, isAnyBusy: () => false, runTurn: async () => ({ outcome: 'error' }) };
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const errands = fakeErrands();
  fakeChannel({ historyMessages: [rawMessage({ id: 'm1' })] });
  const taskTurns = createErrandTurns({
    hot: fakeHot(),
    reads: world().reads,
    iface: () => 'fake',
    turns,
    errands,
    now: () => TURNS_NOW,
    setTimer: (fn: () => void, ms: number) => timers.push({ fn, ms }),
  } as unknown as Parameters<typeof createErrandTurns>[0]);
  await withCapturedLogs(async () => {
    await taskTurns.onFinished(doneTask as unknown as Parameters<typeof taskTurns.onFinished>[0]);
    for (let i = 0; i < 40 && timers.length > 0; i += 1) {
      timers.shift()?.fn();
      await flush();
    }
  });
  assert.deepEqual([errands.seen, errands.read], [[], []]);
  assert.deepEqual(errands.failed, [{ ids: ['tab02'] }]);
});

test("task turns: a result for the command line's chat is tried again while the chat cannot be read, then runs there", async () => {
  // Bug: the result turn asks the served interface for `cli:dm:owner`, finds no chat and returns with no retry, so
  // the result of an errand asked at the command line is never told.
  const chats: Array<unknown> = [];
  const turns = {
    isBusy: () => false,
    isAnyBusy: () => false,
    runTurn: (params: { chat?: unknown }) => {
      chats.push(params.chat);
      return Promise.resolve({ outcome: 'spoke' });
    },
  };
  const asked: Array<{ iface: string; chatId: string }> = [];
  let readable = false;
  const cliChat = {
    id: 'cli:dm:owner',
    kind: 'dm',
    rootId: null,
    name: 'owner',
    partnerId: 'owner',
    iface: 'cli',
    permissions: { read: true, send: true, attach: true, react: false },
  };
  const reads = {
    chatInfo: (chat: { iface: string; chatId: string }) => {
      asked.push(chat);
      return Promise.resolve(
        readable && chat.iface === 'cli' && chat.chatId === 'cli:dm:owner' ? { chat: cliChat } : null
      );
    },
    fetchMessages: () => Promise.resolve({ messages: [] }),
  };
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const errands = fakeErrands();
  const taskTurns = createErrandTurns({
    hot: fakeHot(),
    reads,
    iface: () => 'fake',
    turns,
    errands,
    now: () => TURNS_NOW,
    setTimer: (fn: () => void, ms: number) => timers.push({ fn, ms }),
  } as unknown as Parameters<typeof createErrandTurns>[0]);
  const cliTask = { ...doneTask, id: 'tab09', origin: { placeId: 'cli:dm:owner' } };
  await withCapturedLogs(async () => {
    await taskTurns.onFinished(cliTask as unknown as Parameters<typeof taskTurns.onFinished>[0]);
    assert.equal(chats.length, 0, 'no turn while the chat cannot be read');
    assert.equal(timers.length, 1, 'the result is tried again');
    readable = true;
    timers.shift()?.fn();
    for (let i = 0; i < 50 && chats.length === 0; i += 1) await new Promise((r) => setImmediate(r));
  });
  assert.deepEqual(chats, [{ iface: 'cli', chatId: 'cli:dm:owner' }]);
  assert.deepEqual(
    asked.map((chat) => chat.iface),
    ['cli', 'cli'],
    'the command line is asked for its chat, never the served interface'
  );
  assert.deepEqual(errands.read, [{ ids: ['tab09'] }]);
});

/** The memory database of each data directory used here (a restart opens the same one); closed when the file is done. */
const MEMORY = new Map<string, ReturnType<typeof openTestMemorySync>>();
after(async () => {
  for (const { close } of MEMORY.values()) await close();
});
function memoryOf(dataDir: string) {
  if (!MEMORY.has(dataDir)) MEMORY.set(dataDir, openTestMemorySync({ dataDir }));
  return present(MEMORY.get(dataDir)).memoryDb;
}

const DISCORD = createDiscordInterface().capabilities;
const NOW0 = Date.parse('2026-10-19T12:00:00Z');
const GUILD = 'g1';
const SELF = 'self-id';
const SILENT = { info() {}, warn() {}, error() {} };
const INNER_TASK = 'Nobody wrote to you; read the wake block.';
const clock = { t: NOW0 };

/** A model call that never returns: the process dies there. */
const HANG = Symbol('hang');
/** A provider failure the way the client raises it (a 429). */
const providerLimit = () => Object.assign(new Error('OpenRouter HTTP 429'), { statusCode: 429, body: '{}' });
const faultFlush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

// ---- the chat: what survives a "death" (the chats, the model, the log of what was asked) ----

/**
 * The chat world: a fake port holding every message (seeded and sent), the channels reading their
 * history from it, a scripted model, and the records the invariant checks. It is built once per
 * scenario and outlives every boot.
 */
const names: Record<string, string> = { u1: 'Alice', u2: 'Zoë', [SELF]: 'Bot' };

type Chat = ReturnType<typeof makeChat>;

/** The scripted model of a chat: every request it got, and the answer it plays. */
type ChatLlm = {
  calls: Array<Array<Record<string, Untyped>>>;
  complete: (messages: Array<Record<string, Untyped>>) => Promise<unknown>;
};

function makeChat() {
  let stamp = 0;
  const port = createFakeAdapter({ iface: 'fake', selfId: SELF, now: () => clock.t - 5000 + (stamp += 1) });
  const injected: Array<Untyped> = []; // the sends a fault turned into a failure: { n, chat, text }
  const failures = new Map<number, Record<string, Untyped>>(); // send attempt number -> the result it gets
  const dyingAfter = new Set(); // send attempt numbers after which the process dies: the message is in the chat, the answer never comes
  let attempts = 0;
  const send = port.send.bind(port);
  port.send = wrongly<typeof port.send>(
    async (target: Parameters<typeof send>[0], content: Parameters<typeof send>[1]) => {
      attempts += 1;
      if (dyingAfter.has(attempts)) {
        await send(target, content);
        chat.hung = true;
        return new Promise(() => {});
      }
      const result = failures.get(attempts);
      if (!result) return send(target, content);
      port.calls.push({ op: 'send', args: [target, content] });
      injected.push({ n: attempts, chat: target.chatId, text: content?.text ?? '' });
      return result;
    }
  );

  // The chats of the chat: #c1, #c2 and #c3 of the root and the direct chat d1 (c9 is unknown to the interface).
  const infoOf = (id: string, { send = true }: { send?: boolean } = {}) => ({
    id,
    kind: id === 'd1' ? 'dm' : 'channel',
    rootId: id === 'd1' ? null : GUILD,
    name: id === 'd1' ? null : `chan-${id}`,
    topic: null,
    category: null,
    chatType: id === 'd1' ? 'dm' : 'channel',
    ...(id === 'd1' ? { partnerId: 'u1' } : {}),
    iface: 'fake',
    permissions: { read: true, send, attach: true, react: true },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
    audience:
      id === 'd1'
        ? null
        : {
            everyone: true,
            groups: [],
            groupAllow: [],
            groupDeny: [],
            memberAllow: [],
            memberDeny: [],
            memberGroups: {},
          },
  });
  for (const id of ['c1', 'c2', 'c3', 'd1']) port.seedChat(wrongly(infoOf(id)));

  const results: Array<Untyped> = []; // every turn that ended: { placeId, mode, result, failedSends }
  const requests: Array<{ audience: string | null; text: string }> = []; // every request a model call got: { audience, text }
  const completed: Array<Untyped> = []; // every model call that answered: { at, audience }
  const script: Array<Untyped> = []; // the next answers: a text, an Error, a function of the messages, or HANG
  const fallback: unknown = '<skip/>';
  const audience = null;
  const gifs = null;
  const llm = wrongly<ChatLlm>(null);
  const chat = {
    port,
    injected,
    results,
    requests,
    completed,
    script,
    fallback,
    hung: false,
    audience,
    gifs,
    /** The nth send attempt (1-based, counted over the whole scenario) fails with `result`. */
    failSend(n: number, result = { status: 'failed', error: { code: 'rate-limited', retryable: false } }) {
      failures.set(n, result);
    },
    /** The process dies right after the nth send attempt reached the chat. */
    dieAfterSend(n: number) {
      dyingAfter.add(n);
    },
    get sendAttempts() {
      return attempts;
    },
    /** Where the persona may write: the chats in `unwritable` may not be written in, the others may. */
    permit(unwritable: Array<string> = []) {
      for (const id of ['c1', 'c2', 'c3', 'd1'])
        port.seedChat(wrongly(infoOf(id, { send: !unwritable.includes(wrongly(id)) })));
    },
    /** A line by `authorId` in `chatId` (the persona's own when it is `SELF`); its raw form. */
    /**
     */
    say(chatId: string, authorId: Untyped, text: string) {
      stamp += 1;
      const at = clock.t - 5000 + stamp;
      const id = `s${stamp}`;
      if (authorId === SELF) {
        port.seed(chatId, { authorId, text, messageId: id });
      } else {
        // A member's line is a whole event, the way an interface reports it, with the name the member goes by.
        port.seedEvent({
          kind: 'message.received',
          iface: 'fake',
          at,
          id: `fake:message:${id}`,
          chat: {
            id: chatId,
            kind: chatId === 'd1' ? 'dm' : 'channel',
            rootId: chatId === 'd1' ? null : GUILD,
            name: chatId === 'd1' ? null : `chan-${chatId}`,
          },
          message: {
            id,
            author: { id: authorId, name: names[authorId] ?? authorId, self: false, bot: false },
            content: text,
            sourceText: text,
            system: false,
            at,
            replyToId: null,
            replyPingAccountId: null,
            forwardedFrom: null,
            attachments: [],
            links: [],
            forwarded: [],
            stickers: [],
            emojis: [],
            reactions: [],
          },
          addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
        });
      }
      return { id, placeId: chatId, cleanContent: text, createdTimestamp: at };
    },
    ownMessages(chatId: string, n = 20) {
      return port
        .messagesIn(chatId)
        .filter((message) => message.authorId === SELF)
        .slice(-n)
        .map((message) => ({
          id: message.ref.messageId,
          content: message.text,
          replyToId: message.replyTo?.messageId ?? null,
          createdAt: message.at,
        }));
    },
    textsFromSelf(chatId: string) {
      return port
        .messagesIn(chatId)
        .filter((message) => message.authorId === SELF)
        .map((message) => message.text);
    },
    llm,
  };
  chat.llm = {
    calls: [],
    complete: async (messages: Array<Record<string, Untyped>>) => {
      const calls = chat.llm.calls;
      calls.push(messages);
      chat.requests.push(wrongly({ audience: chat.audience, text: userText(messages[1].content) }));
      let step: unknown = chat.script.length > 0 ? chat.script.shift() : chat.fallback;
      if (typeof step === 'function') step = await wrongly<(messages: Untyped) => Promise<unknown>>(step)(messages);
      if (step === HANG) {
        chat.hung = true;
        return new Promise(() => {});
      }
      if (step instanceof Error) throw step;
      chat.completed.push(wrongly({ at: clock.t, audience: chat.audience }));
      return completionOf(step);
    },
  };
  return chat;
}

/** The text of the request the model got as its `i`th call. */
const requestText = (chat: Chat, i: number): string => present(chat.requests[i]).text;

/** A fake intention service over `records` (mutable, outlives a boot): the due ones are pending with a passed dueAt. */
function fakeIntentions(records: Untyped) {
  return {
    records,
    due: () =>
      records
        .filter(
          (r: Record<string, Untyped>) => r.status === 'pending' && Number.isFinite(r.dueAt) && r.dueAt <= clock.t
        )
        .map((r: Record<string, Untyped>) => ({ intention: r, reason: 'due', at: r.dueAt })),
    reconcile: () => ({ arrived: 0, missing: 0, deadline: 0, expired: 0 }),
    list: () => records.filter((r: Record<string, Untyped>) => ['pending', 'waiting', 'proposed'].includes(r.status)),
    store: () => ({
      get: (id: string) => records.find((r: Record<string, Untyped>) => r.id === id) ?? null,
      list: () => records,
    }),
  };
}

const personaGrants = (names: Array<string>) =>
  Object.fromEntries(names.map((name) => [name, { everyone: false, roles: [], users: [SELF] }]));

function hotWith({
  features = {},
  wakes = {},
  timezone = 'UTC',
  grants = [],
  config = {},
}: {
  features?: Record<string, Untyped>;
  wakes?: Record<string, Untyped>;
  timezone?: string;
  grants?: Array<Untyped>;
  config?: Record<string, Untyped>;
} = {}) {
  return {
    config: {
      bot: { timezone, dryRunChannelId: '', ownerPerson: OWNER_PERSON, access: personaGrants(grants) },
      context: {
        channelMessages: 100,
        neighborMessages: 5,
        neighborMaxAgeMinutes: 60,
        neighborMaxChannels: 8,
        maxMessageChars: 800,
        gapMarkerMinutes: 20,
        otherProfiles: 6,
        failedTurnsKept: 3,
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
        pull: { scanMessages: 20, maxChannels: 1, sameAudience: true },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      features: {
        memory: true,
        reactions: true,
        multiMessage: true,
        typingSimulation: false,
        vision: false,
        callMarkers: true,
        coreTools: true,
        wakes: true,
        intentions: true,
        ...features,
      },
      models: { routes: chainsOf({ analyzer: 'x/text' }) },
      media: { maxPerTurn: 6, filePreviewChars: 500 },
      gifs: { maxPerDay: 40 },
      mention: { oneAtATime: true },
      tools: {
        safeMode: false,
        resultMaxChars: 2000,
        callTimeoutMs: 120000,
        loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 },
      },
      wakes: {
        mode: 'live',
        tickSeconds: 60,
        queueMax: 20,
        chatMessages: 30,
        caps: { perChain: 3 },
        ...wakes,
      },
      heartbeat: { enabled: false },
      errands: { maxOpen: 3, resultMaxChars: 1000, resultCooldownSeconds: 60, resultRetrySeconds: 30 },
      agents: { scout: { enabled: true, daily: { tasks: 10 } } },
      ...config,
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
    reloadConfig: () => true,
  };
}

function faultFakeStore(gifs = null) {
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
  if (gifs)
    Object.assign(store, {
      findGif: (handle: string) => gifs[handle] ?? null,
      recordOwnGif: () => {},
    });
  return store;
}

/**
 * One boot: a turn runner, an inner life, an errand service with its result turns, all over the
 * chat and `dataDir` -- what src/index.ts builds at start, less Discord. A second boot over the same
 * `dataDir` is a restart. `records` are the intentions (they outlive a boot, like their file would).
 * `die`: the errand service's end hook does nothing (the process died before the result turn).
 */
function boot(
  chat: Chat,
  {
    dataDir,
    records = [],
    hot = hotWith(),
    unwritable = [],
    recall = null,
    failOps = [],
    journal = null,
    record = null,
    gifs = null,
    runErrand = null,
    die = false,
    store = faultFakeStore(gifs),
    ready = undefined,
    innerMemory = null,
  }: {
    dataDir: string;
    records?: Array<Untyped>;
    hot?: ReturnType<typeof hotWith>;
    unwritable?: Array<string>;
    recall?: Untyped;
    failOps?: Array<string>;
    journal?: Untyped;
    record?: Untyped;
    gifs?: Untyped;
    runErrand?: Untyped;
    die?: boolean;
    store?: ReturnType<typeof faultFakeStore>;
    ready?: Untyped;
    innerMemory?: Untyped;
  }
) {
  const intentions = fakeIntentions(records);
  const timers: Array<Untyped> = [];
  const accepted = new Set();
  const client = { user: { id: SELF, username: 'Bot' } };
  const port = chat.port;
  chat.permit(unwritable);
  const reads = createReads(port, SILENT);
  const admin = createAdmin({
    discord: DISCORD,
    hot,
    store,
    client,
    isServedRoot: (id: unknown) => id === GUILD,
    port,
    reads,
  });
  const runOp =
    failOps.length === 0
      ? admin.runSkillOp
      : async (op: string, args: Record<string, Untyped>, context: Record<string, Untyped>) =>
          failOps.includes(op)
            ? { status: 'failed', code: 'error', summary: 'it did not work', data: null }
            : admin.runSkillOp(op, args, context);

  // The errand service over the real task store; its runner is a fake that ends at once.
  const stores = createErrandStores({ memoryDb: memoryOf(dataDir), config: () => hot.config, log: SILENT });
  let taskTurns = wrongly<ReturnType<typeof createErrandTurns>>(null);
  const errands = createErrandService({
    client: {
      configured: () => true,
      run: async (task) =>
        runErrand ? runErrand(task) : { status: 'done', result: { text: 'found it' }, usage: { usd: 0.01 } },
      cancel: () => true,
    },
    stores,
    hot,
    log: SILENT,
    onFinished: (task) => (die ? null : taskTurns.onFinished(task)),
  });

  const turns = faultCreateTurnRunner({
    hot,
    store,
    llm: chat.llm,
    calibrator: { ratio: 1, apply: (value) => value, observe: () => {} },
    now: () => clock.t,
    port,
    reads,
    selfId: () => SELF,
    getSelfName: () => 'Bot',
    memberOf: (placeId: string, accountId: string) =>
      accountId in names ? { name: names[accountId], bot: false } : null,
    membersOf: () => Object.entries(names).map(([id, name]) => ({ id, name, bot: false })),
    chatName: (id: string) => (id === 'd1' ? null : `chan-${id}`),
    skills: skillRegistry(),
    journal,
    runOp,
    runOwnOp: admin.runOwnSkillOp,
    runInitiativeOp: admin.runInitiativeSkillOp,
    errands,
    ...(recall ? { recall } : {}),
  });
  // Every turn that ends is recorded with the sends a fault failed during it.
  const recorded = {
    isAnyBusy: () => turns.isAnyBusy?.() ?? false,
    isBusy: (id: string) => turns.isBusy?.(id) ?? false,
    runTurn: async (params: Record<string, Untyped>) => {
      chat.audience = params.chat?.chatId ?? null;
      const before = chat.sendAttempts;
      const result = await turns.runTurn(params);
      chat.results.push({
        placeId: params.chat?.chatId ?? null,
        mode: params.mode,
        result,
        failedSends: chat.injected.filter((f) => f.n > before && f.n <= chat.sendAttempts),
      });
      return result;
    },
  };
  taskTurns = createErrandTurns({
    hot,
    reads,
    iface: () => 'fake',
    turns: recorded,
    errands,
    now: () => clock.t,
    setTimer: wrongly((fn: string, ms: Array<Record<string, Untyped>>) => timers.push({ fn, ms })),
    log: SILENT,
  });

  let inner: ReturnType<typeof createInnerLife>;
  const door = createEventDoor({ handlers: { 'inner.wake': (event) => inner.onWake(event) }, log: SILENT });
  inner = createInnerLife({
    hot,
    dataDir,
    turns: recorded,
    intentions,
    record,
    journal: journal ? personaJournal(wrongly(journal), () => [GUILD]) : null,
    reads,
    iface: () => 'fake',
    ...(ready ? { ready } : {}),
    submit: (event) => {
      accepted.add(event.id);
      return door.submit(event);
    },
    store: { state: { data: {} } },
    meter: { run: async (fn) => ({ result: await fn(), usd: 0, requests: 1, voice: 1 }) },
    ...(innerMemory ? { memoryDb: innerMemory } : {}),
    rng: () => 0.5,
    now: () => clock.t,
    log: SILENT,
  });
  turns.setFactsSource(inner.facts);

  const quiet = async (fn: () => unknown) => (await withCapturedLogs(fn)).result;
  const world = {
    chat,
    hot,
    dataDir,
    store,
    client,
    port,
    reads,
    turns,
    inner,
    errands,
    taskTurns,
    intentions,
    records,
    accepted,
    timers,
    journal,
    /** A wake handed to the door, as the scheduler would; remembered as accepted work. */
    accept: (wake: Record<string, Untyped>) => {
      accepted.add(wake.id);
      return door.submit({ kind: 'inner.wake', at: clock.t, id: wake.id, rootId: GUILD, wake });
    },
    tick: () => quiet(() => inner.tick()),
    /** Alice's line in `chatId`, answered by an addressed turn (the model's next answers are `chat.script`). */
    ask: (chatId: string, text: Untyped, { dm = false }: { dm?: boolean } = {}) =>
      quiet(async () => {
        const raw = chat.say(chatId, 'u1', text);
        const trigger = {
          id: raw.id,
          placeId: raw.placeId,
          authorId: 'u1',
          authorName: 'Alice',
          self: false,
          bot: false,
          content: raw.cleanContent,
          ts: raw.createdTimestamp,
          replyToId: null,
          attachments: [],
          stickers: [],
        };
        return recorded.runTurn({
          chat: { iface: 'fake', chatId },
          ...(dm ? { placeId: GUILD } : {}),
          mode: 'reply',
          trigger,
          triggerKind: 'mention',
        });
      }),
    quiet,
    state: () => inner.state(),
    factKinds: () =>
      inner.state().facts.map((fact: Record<string, Untyped>) => `${fact.kind}${fact.told ? ':told' : ''}`),
  };
  return world;
}

/** The task of a request's text as a list of lines, for the tasks block. */
const tasksBlockOf = (text: string) => /<errands>\n([\s\S]*?)\n<\/errands>/.exec(text)?.[1] ?? '';

// ---- the invariant ----

/**
 * What no scenario may end with (spec section 1), checked from the fakes' records:
 * 1. no accepted work lost: every wake the door accepted is queued or has a handled outcome, and no
 *    errand is left open by a process that is gone;
 * 2. no false success: a turn that had a send fail never reads `spoke` with something delivered
 *    unless it says `partial` (or one of its calls is recorded as not ok);
 * 3. no blind duplicate: the persona never said the same text twice in one chat;
 * 4. no premature told: a fact marked told is backed by a model answer that completed after it was born;
 * 5. audience-correct: nothing marked private (`privateMarks`) is in a request made in another chat,
 *    and a private fact belongs to one of `dmChats`.
 */
/** What a test adds to the invariants: wakes it accepted, the private chats, and the marks that must stay private. */
type Invariants = { accepted?: Array<Untyped>; dmChats?: Untyped; privateMarks?: Array<Untyped> };

function assertNoSilentFailure(run: Record<string, Untyped>, options: Invariants = {}) {
  const { accepted = [], dmChats = ['d1'], privateMarks = [] } = options;
  const { chat } = run;
  const state = run.inner.state(GUILD);
  for (const id of new Set([...accepted, ...run.accepted])) {
    assert.ok(
      state.queue.some((wake: Record<string, Untyped>) => wake.id === id) || state.handled[id],
      `1: the accepted wake ${id} is neither queued nor handled`
    );
  }
  const open = run.errands.store()?.open() ?? [];
  assert.deepEqual(
    open.map((task: Record<string, Untyped>) => task.id),
    [],
    '1: an errand is left open with no process to run it'
  );
  for (const { placeId, mode, result, failedSends } of chat.results) {
    if (failedSends.length === 0) continue;
    const callNotOk = (result?.inner?.actions ?? []).some((action: Record<string, Untyped>) => action.result !== 'ok');
    const readsAsSuccess =
      result?.outcome === 'spoke' && result.delivered === true && result.partial !== true && !callNotOk;
    assert.equal(readsAsSuccess, false, `2: the ${mode} turn in ${placeId} lost a send but reads as a success`);
  }
  assertSaidOnce(chat);
  assertPrivateKept(chat, state, { dmChats, privateMarks });
}

/** Invariant 3: the persona never said the same thing twice in one chat. */
function assertSaidOnce(chat: Chat) {
  const said = new Map();
  const messages = chat.port.messages;
  for (const message of messages.values()) {
    if (message.authorId !== SELF || message.deleted) continue;
    const key = `${message.ref.chatId}\n${message.text}`;
    said.set(key, (said.get(key) ?? 0) + 1);
  }
  for (const [key, count] of said) {
    if (count > 1) assert.fail(`3: the persona said twice in ${key.split('\n')[0]}: ${key.split('\n')[1]}`);
  }
}

/** Invariants 4 and 5: a told fact has a model answer after it, and private facts and marks stay in the private chats. */
function assertPrivateKept(
  chat: Chat,
  state: Record<string, Untyped>,
  { dmChats, privateMarks }: { dmChats: Untyped; privateMarks: Array<Untyped> }
) {
  for (const fact of state.facts) {
    if (fact.told)
      assert.ok(
        chat.completed.some((done: { at: number }) => done.at >= fact.at),
        `4: the fact ${fact.kind} is told but no model answer completed after it was born`
      );
    if (fact.dmChat) assert.ok(dmChats.includes(fact.placeId), `5: a private fact belongs to ${fact.placeId}`);
  }
  for (const request of chat.requests) {
    if (request.audience !== null && dmChats.includes(request.audience)) continue;
    for (const mark of privateMarks)
      assert.ok(!request.text.includes(mark), `5: a request in ${request.audience} carries a private mark`);
  }
}

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['u1']);

describe('a fault around the result turn of an errand', () => {
  beforeEach(() => {
    clock.t = NOW0;
  });

  test("row 3: the process dies after an errand's result was stored and before its result turn ran -- the turn is reopened after the reload and errand.read gives the whole text", async () => {
    const dataDir = tempDir('nep-fault-');
    const chat = makeChat();
    const text = Array.from({ length: 250 }, (_, i) => `line${i}`).join(' ');
    const origin = chat.say('c1', 'u1', 'find the changelog');
    const runErrand = async () => ({
      status: 'done',
      result: { text, sources: ['https://example.org/a'] },
      usage: { usd: 0.02 },
    });
    const before = boot(chat, { dataDir, die: true, runErrand });
    const submitted = before.errands.submit({
      agent: 'scout',
      goal: 'find the changelog',
      requester: { accountId: 'u1', kind: 'member' },
      origin: { placeId: 'c1', messageId: origin.id },
      scope: 'group',
    });
    assert.equal(submitted.ok, true);
    await before.errands.idle();
    // The result is stored: its write reached the database before the process died.
    await present(before.errands.store()).flush();
    const id = submitted.errand.id;
    assert.equal(present(present(before.errands.store()).get(id)).state, 'done');
    const calls = chat.llm.calls;
    assert.equal(calls.length, 0, 'the result turn never ran');

    const after = boot(chat, { dataDir, runErrand });
    await withCapturedLogs(async () => {
      after.errands.start();
      const { calls } = chat.llm;
      for (let i = 0; i < 100 && calls.length === 0; i += 1) await faultFlush(1);
      await faultFlush();
    });
    const chatCalls = chat.llm.calls;
    assert.equal(chatCalls.length, 1, 'the result turn is reopened after the reload');
    assert.ok(requestText(chat, 0).includes('<errand_result>'), 'with the result in front of the persona');
    const task = present(after.errands.store()).get(id);
    assert.ok(present(task).seen && present(task).readAt, 'a turn that completed marks the task seen and read');

    // errand.read pages through the whole text.
    const env = createOpsEnv({
      discord: DISCORD,
      hot: after.hot,
      store: after.store,
      client: after.client,
      reads: after.reads,
      spontaneous: {},
      calibrator: { ratio: 1 },
      isServedRoot: (id: unknown) => id === GUILD,
      errands: after.errands,
    });
    let from = 0;
    let got = '';
    for (let page = 0; page < 10; page += 1) {
      const read = await runOp('errand.read', from > 0 ? { id, from } : { id }, {
        env,
        placeId: GUILD,
        chatId: 'c1',
        accountId: 'u1',
        roleIds: [],
      });
      assert.equal(read.status, 'ok');
      const lines = read.summary.split('\n');
      const at = lines.findIndex((line) => line.startsWith('result: characters'));
      got += lines[at + 1];
      const next = lines.find((line) => line.startsWith('next: from='));
      if (!next) break;
      from = Number(next.slice('next: from='.length));
    }
    assert.equal(got, text, 'errand.read returned the full text');

    // A second restart does not open the same turn again.
    const third = boot(chat, { dataDir, runErrand });
    await withCapturedLogs(async () => {
      third.errands.start();
      await faultFlush();
    });
    const chatCalls2 = chat.llm.calls;
    assert.equal(chatCalls2.length, 1);
    assertNoSilentFailure(third);
  });

  test('row 11: an errand completes and its result turn fails every time -- the task stays unread with the failed-turn note and errand.read returns it', async () => {
    const dataDir = tempDir('nep-fault-');
    const chat = makeChat();
    const text = 'the changelog says: nothing breaking, two fixes, one new switch';
    const origin = chat.say('c1', 'u1', 'find the changelog');
    const run = boot(chat, {
      dataDir,
      runErrand: async () => ({ status: 'done', result: { text }, usage: { usd: 0.01 } }),
    });
    chat.fallback = providerLimit();
    const submitted = run.errands.submit({
      agent: 'scout',
      goal: 'find the changelog',
      requester: { accountId: 'u1', kind: 'member' },
      origin: { placeId: 'c1', messageId: origin.id },
      scope: 'group',
    });
    const id = present(submitted.errand).id;
    await withCapturedLogs(async () => {
      await run.errands.idle();
      for (let i = 0; i < RESULT_ATTEMPTS + 5 && run.timers.length > 0; i += 1) {
        run.timers.shift().fn();
        await faultFlush();
      }
    });
    const calls = chat.llm.calls;
    assert.equal(calls.length, RESULT_ATTEMPTS, 'the turn was tried every time it could be');
    const task = present(run.errands.store()).get(id);
    assert.equal(present(task).state, 'done');
    assert.equal(present(task).resultTurnFailed, true, 'the task says its result turn never ran');
    assert.ok(!present(task).readAt, 'and it is unread');
    assert.deepEqual(
      run.errands.view({}).map((t) => t.id),
      [id]
    );

    // A later turn of the persona's in that channel sees the task with its note.
    chat.fallback = '<skip/>';
    await run.ask('c1', 'anything new?');
    const line = tasksBlockOf(requestText(chat, chat.requests.length - 1));
    assert.ok(
      line.includes(id) && line.includes(labels.errands.unread) && line.includes(labels.errands.resultTurnFailed),
      line
    );
    const env = createOpsEnv({
      discord: DISCORD,
      hot: run.hot,
      store: run.store,
      client: run.client,
      reads: run.reads,
      spontaneous: {},
      calibrator: { ratio: 1 },
      isServedRoot: (id: unknown) => id === GUILD,
      errands: run.errands,
    });
    const read = await runOp(
      'errand.read',
      { id },
      { env, placeId: GUILD, chatId: 'c1', accountId: 'u1', roleIds: [] }
    );
    assert.equal(read.status, 'ok');
    assert.ok(read.summary.includes(text), 'errand.read returns the result');
    assertNoSilentFailure(run);
  });
});
