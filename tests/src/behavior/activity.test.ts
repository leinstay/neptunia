// Tests for src/behavior/activity.ts: the per-author last-message tracker and the settle wait a turn answering a person
// sits through before it reads the channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActivity, settleWait } from '../../../src/behavior/activity.ts';
import { EventEmitter } from 'node:events';
import { createTagHistory } from '../../../src/behavior/mention.ts';
import { createMessageHandler } from '../../../src/behavior/pipeline.ts';
import { createTurnRunner } from '../../../src/behavior/turn.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createReads } from '../../../src/interface/reads.ts';
import { createStore } from '../../../src/memory/store.ts';
import { createMemoryUpdater } from '../../../src/memory/update.ts';
import type { MessageReceived } from '../../../src/protocol/events.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import { channelInfo } from '../../fixtures/core-over-fake.ts';
import { memoryAt } from '../../fixtures/store-kit.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { contentText, hotWith, sequenceLlm } from '../../fixtures/turn-harness.ts';

const T = Date.UTC(2026, 8, 20, 12, 0, 0);

test('settleWait: settle off (0, negative, non-number) never waits', () => {
  for (const settleMs of [0, -100, '4000', null, undefined, Number.NaN]) {
    assert.equal(
      settleWait({ now: T + 500, triggerAt: T, lastAt: T + 400, settleMs, settleMaxMs: 15000 }),
      0,
      String(settleMs)
    );
  }
});

test('settleWait: an author silent for longer than settleMs is not waited for', () => {
  assert.equal(settleWait({ now: T + 10000, triggerAt: T, lastAt: T, settleMs: 4000, settleMaxMs: 15000 }), 0);
});

test('settleWait: an author who wrote 1 s ago waits the rest of settleMs', () => {
  assert.equal(settleWait({ now: T + 6000, triggerAt: T, lastAt: T + 5000, settleMs: 4000, settleMaxMs: 15000 }), 3000);
});

test('settleWait: the wait never runs past settleMaxMs counted from triggerAt', () => {
  assert.equal(
    settleWait({ now: T + 13000, triggerAt: T, lastAt: T + 12500, settleMs: 4000, settleMaxMs: 15000 }),
    2000
  );
  assert.equal(settleWait({ now: T + 16000, triggerAt: T, lastAt: T + 15500, settleMs: 4000, settleMaxMs: 15000 }), 0);
});

test('settleWait: with no known last message the settle counts from triggerAt', () => {
  assert.equal(settleWait({ now: T + 1000, triggerAt: T, lastAt: null, settleMs: 4000, settleMaxMs: 15000 }), 3000);
});

test('settleWait: a cap that is off (0 or a non-number) allows one settle from triggerAt', () => {
  assert.equal(settleWait({ now: T + 3000, triggerAt: T, lastAt: T + 2500, settleMs: 4000, settleMaxMs: 0 }), 1000);
  assert.equal(settleWait({ now: T + 3000, triggerAt: T, lastAt: T + 2500, settleMs: 4000, settleMaxMs: null }), 1000);
});

test('settleWait: nothing known at all (no trigger time, no last message) waits nothing', () => {
  assert.equal(settleWait({ now: T, triggerAt: null, lastAt: null, settleMs: 4000, settleMaxMs: 15000 }), 0);
});

test('createActivity: lastAt is the latest note of that author in that channel, null when none', () => {
  const activity = createActivity();
  assert.equal(activity.lastAt('c1', 'u1'), null);
  activity.note('c1', 'u1', T);
  activity.note('c1', 'u1', T + 2000);
  activity.note('c1', 'u1', T + 1000); // an older message arriving late does not move it back
  activity.note('c2', 'u1', T + 9000);
  activity.note('c1', 'u2', T + 9000);
  assert.equal(activity.lastAt('c1', 'u1'), T + 2000);
  assert.equal(activity.lastAt('c2', 'u1'), T + 9000);
  assert.equal(activity.lastAt('c1', 'u3'), null);
});

test('createActivity: a note without a usable time, channel or author is ignored', () => {
  const activity = createActivity();
  activity.note('c1', 'u1', Number.NaN);
  // @ts-expect-error: the test passes a missing time on purpose; the tracker must ignore it
  activity.note('c1', 'u1', undefined);
  activity.note('', 'u1', T);
  // @ts-expect-error: the test passes a missing author on purpose; the tracker must ignore it
  activity.note('c1', null, T);
  assert.equal(activity.lastAt('c1', 'u1'), null);
  assert.equal(activity.size(), 0);
});

test('createActivity: prune drops entries older than maxAgeMs', () => {
  const activity = createActivity();
  activity.note('c1', 'u1', T);
  activity.note('c1', 'u2', T + 50000);
  activity.prune(T + 60001, 60000);
  assert.equal(activity.lastAt('c1', 'u1'), null);
  assert.equal(activity.lastAt('c1', 'u2'), T + 50000);
  assert.equal(activity.size(), 1);
});

test('createActivity: every note evicts entries older than ten minutes, so the map stays bounded', () => {
  const activity = createActivity();
  for (let i = 0; i < 100; i += 1) activity.note('c1', `u${i}`, T);
  activity.note('c2', 'late', T + 10 * 60 * 1000 + 1);
  assert.equal(activity.size(), 1);
  assert.equal(activity.lastAt('c2', 'late'), T + 10 * 60 * 1000 + 1);
});

const T0 = Date.parse('2026-11-08T14:00:00Z');

const CHAT = 'cli:dm:owner';

const SELF = 'self-id';

// The shipped settle; the preparation deadlines off, since the scene moves its clock only by the settle's pauses.
const PACE = {
  settleMs: 3000,
  settleMaxMs: 8000,
  prepareMs: 0,
  prepareSearchMs: 0,
  prepareMediaMs: 0,
  dropAfterMs: 0,
  replyHedgeMs: 0,
};

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** A line of the owner in the owner's chat at `at`, as the command line delivers it. */
function line(id: string, content: string, at: number): MessageReceived {
  return {
    kind: 'message.received',
    iface: 'cli',
    at,
    id: `cli:message:${id}`,
    chat: { id: CHAT, kind: 'dm', rootId: null, name: 'owner', partnerId: 'owner' },
    message: {
      id,
      author: { id: 'owner', name: 'owner', self: false, bot: false },
      content,
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
  };
}

/**
 * The owner's chat with the handler and the runner wired as the core wires them. `during` are lines delivered once the
 * clock reaches their time while the first turn waits; `whileAnswering` are delivered while the first request is made.
 */
async function chatScene({
  first,
  during,
  whileAnswering = [],
}: {
  first: MessageReceived;
  during: Array<MessageReceived>;
  whileAnswering?: Array<MessageReceived>;
}) {
  const clock = { t: first.at };
  const adapter = createFakeAdapter({ iface: 'cli', selfId: SELF, now: () => clock.t });
  adapter.seedChat(
    channelInfo(CHAT, { iface: 'cli', kind: 'dm', rootId: null, name: 'owner', partnerId: 'owner', public: false })
  );
  const reads = createReads(adapter, quiet);
  const hot = Object.assign(
    new EventEmitter(),
    hotWith({ config: { pace: PACE, mention: { neverIgnore: [], pendingMinutes: 10, maxPending: 6 } } })
  );
  const store = createStore(memoryAt(tempDir('nep-settle-burst-')));
  const activity = createActivity();
  let handler: ReturnType<typeof createMessageHandler> | null = null;
  const deliver = async (event: MessageReceived): Promise<void> => {
    clock.t = Math.max(clock.t, event.at);
    adapter.seedEvent(event);
    await handler?.(event);
  };
  const waiting = [...during];
  // The settle's pauses move the clock; a line whose time has come is delivered before the pause ends.
  const schedule = (fn: () => void, ms: number) => {
    clock.t += ms;
    const due = waiting.filter((event) => event.at <= clock.t);
    waiting.splice(0, due.length);
    void due.reduce((done, event) => done.then(() => deliver(event)), Promise.resolve()).then(() => setImmediate(fn));
    return () => {};
  };
  const scripted = sequenceLlm(['<msg>ok</msg>']);
  // The lines written while the persona answers arrive once the first request is on its way, after the turn read the chat.
  const llm = {
    ...scripted,
    complete: async (...args: Parameters<typeof scripted.complete>) => {
      if (scripted.calls.length === 0) for (const event of whileAnswering.splice(0)) await deliver(event);
      return scripted.complete(...args);
    },
  };
  const turns = createTurnRunner({
    hot,
    store,
    llm,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    describer: undefined,
    lookup: undefined,
    emoji: undefined,
    now: () => clock.t,
    schedule,
    port: adapter,
    reads,
    selfId: () => SELF,
    getSelfName: () => 'Bot',
    skills: skillRegistry(),
    journal: null,
    activity,
  });
  handler = createMessageHandler({
    hot,
    store,
    reads,
    selfId: () => SELF,
    getSelfName: () => 'Bot',
    isServedRoot: () => false,
    turns,
    memory: createMemoryUpdater({ hot, store }),
    tagHistory: createTagHistory(),
    port: adapter,
    activity,
    rng: () => 0,
    now: () => clock.t,
    sleep: () => Promise.resolve(),
  });
  const drain = handler.drainPending;
  turns.setOnIdle(() => void drain());
  await deliver(first);

  return { requests: scripted.calls, turns, handler };
}

/** Waits until `check` holds, letting the scene's promises and immediates run. */
async function until(check: () => boolean, rounds = 4000): Promise<void> {
  for (let i = 0; i < rounds && !check(); i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** The text of every message of a model request: what the turn read. */
const requestText = (request: ReadonlyArray<{ content?: unknown }>): string =>
  request.map((message) => contentText(message.content)).join('\n');

test('three lines sent within the settle window are one turn that reads all three', async () => {
  // Bug: each quick line of the command line got its own turn, so the persona's answer to the first came after the third.
  const scene = await chatScene({
    first: line('m1', 'alpha-line', T0),
    during: [line('m2', 'beta-line', T0 + 1300), line('m3', 'gamma-line', T0 + 2900)],
  });
  await until(() => scene.requests.length >= 1 && !scene.turns.isAnyBusy() && scene.handler.pendingCount() === 0);
  // Room for a second turn to start, were one owed.
  await until(() => scene.requests.length >= 2, 400);
  await until(() => !scene.turns.isAnyBusy());

  assert.equal(scene.requests.length, 1);
  const read = requestText(scene.requests[0] ?? []);
  for (const text of ['alpha-line', 'beta-line', 'gamma-line']) assert.ok(read.includes(text), text);
});

test('a line sent after the turn read the chat gets its own turn', async () => {
  // Bug: a line written while the persona answers is taken as already answered and never gets a turn.
  const scene = await chatScene({
    first: line('m1', 'alpha-line', T0),
    during: [line('m2', 'beta-line', T0 + 1300)],
    whileAnswering: [line('m4', 'delta-line', T0 + 9000)],
  });
  await until(() => scene.requests.length >= 2 && !scene.turns.isAnyBusy());

  assert.equal(scene.requests.length, 2);
  assert.equal(requestText(scene.requests[0] ?? []).includes('delta-line'), false);
  assert.ok(requestText(scene.requests[1] ?? []).includes('delta-line'));
});
