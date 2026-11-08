// pace.settleMs on the owner's command line: a turn answering him waits until he stops writing, and the lines he sent
// while it waited are read by that turn as part of his call, so three quick lines get one answer. A line he sends after
// the turn read the chat waits for its own turn. The real message handler, turn runner and activity tracker over the
// fake interface speaking as `cli`, with a scripted model and a clock the settle's pauses move. Synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createActivity } from '../src/behavior/activity.ts';
import { createTagHistory } from '../src/behavior/mention.ts';
import { createMessageHandler } from '../src/behavior/pipeline.ts';
import { createTurnRunner } from '../src/behavior/turn.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { createReads } from '../src/interface/reads.ts';
import { createStore } from '../src/memory/store.ts';
import { createMemoryUpdater } from '../src/memory/update.ts';
import type { MessageReceived } from '../src/protocol/events.ts';
import { skillRegistry } from '../src/tools/registry.ts';
import { channelInfo } from './fixtures/core-over-fake.ts';
import { memoryAt } from './fixtures/store-kit.ts';
import { tempDir } from './fixtures/tmp.ts';
import { contentText, hotWith, sequenceLlm } from './fixtures/turn-harness.ts';

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

/** A line of the owner in his chat at `at`, as the command line delivers it. */
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
  // The lines written while she answers arrive once the first request is on its way, after the turn read the chat.
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

  return { llm: scripted, turns, handler };
}

/** Waits until `check` holds, letting the scene's promises and immediates run. */
async function until(check: () => boolean, rounds = 4000): Promise<void> {
  for (let i = 0; i < rounds && !check(); i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** The text of every message of a model request: what the turn read. */
const requestText = (request: ReadonlyArray<{ content?: unknown }>): string =>
  request.map((message) => contentText(message.content)).join('\n');

test('three lines sent within the settle window are one turn that reads all three', async () => {
  // Bug: each quick line of the command line got its own turn, so her answer to the first came after the third.
  const scene = await chatScene({
    first: line('m1', 'alpha-line', T0),
    during: [line('m2', 'beta-line', T0 + 1300), line('m3', 'gamma-line', T0 + 2900)],
  });
  await until(() => scene.llm.calls.length >= 1 && !scene.turns.isAnyBusy() && scene.handler.pendingCount() === 0);
  // Room for a second turn to start, were one owed.
  await until(() => scene.llm.calls.length >= 2, 400);
  await until(() => !scene.turns.isAnyBusy());

  assert.equal(scene.llm.calls.length, 1);
  const read = requestText(scene.llm.calls[0] ?? []);
  for (const text of ['alpha-line', 'beta-line', 'gamma-line']) assert.ok(read.includes(text), text);
});

test('a line sent after the turn read the chat gets its own turn', async () => {
  // Bug: a line written while she answers is taken as already answered and never gets a turn.
  const scene = await chatScene({
    first: line('m1', 'alpha-line', T0),
    during: [line('m2', 'beta-line', T0 + 1300)],
    whileAnswering: [line('m4', 'delta-line', T0 + 9000)],
  });
  await until(() => scene.llm.calls.length >= 2 && !scene.turns.isAnyBusy());

  assert.equal(scene.llm.calls.length, 2);
  assert.equal(requestText(scene.llm.calls[0] ?? []).includes('delta-line'), false);
  assert.ok(requestText(scene.llm.calls[1] ?? []).includes('delta-line'));
});
