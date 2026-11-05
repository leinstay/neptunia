// Public turn context, split-chain merging and private journal boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordAdapter, createDiscordInterface } from '../interfaces/discord/index.ts';
import { createTurnRunner } from './fixtures/turn-runner.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import {
  NOW,
  fakeClient,
  fakeLookup,
  fakeStore,
  fakeTurnChannel,
  identityCalibrator,
  normalizedTrigger,
  rawMessage,
} from './fixtures/turn-kit.ts';
import { createMerge } from '../src/pipeline/merge.ts';
import { createPendingQueue } from '../src/pipeline/pending-queue.ts';
import type { PendingQueue, PipelineTurns, Line } from '../src/pipeline/types.ts';
import { channelInfo } from './fixtures/core-over-fake.ts';
import { labels } from './fixtures/labels.ts';
import { createJournal } from '../src/memory/journal.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import {
  SPLIT_TEXT,
  SPLIT_PARTS,
  PARTS_ANSWER,
  taskOf,
  splitLlm,
  splitHot,
  manualSchedule,
  runSplitTurn,
} from './fixtures/turn-split.ts';

const DISCORD = createDiscordInterface().capabilities;

test('split attempts preserve the supplied memory context in every automatic prefetch', async () => {
  const { issueContext } = await import('../src/memory/db/scope.ts');
  const context = issueContext({ kind: 'internal', newId: () => 'ctx:split-owner', now: () => NOW });
  const reads: Array<unknown> = [];
  const recall = {
    available: () => true,
    prefetch: (args: Record<string, unknown>) => {
      reads.push(args.memoryContext);
      return Promise.resolve({ status: 'ok', basis: ['message'], excerpts: [], ms: 0 });
    },
  };
  const result = await runSplitTurn({
    extra: { recall, memoryContext: issueContext },
    turnExtra: { memoryContext: context },
  });
  assert.ok(result.llm.calls.talk.length >= 2, 'the scripted splitter must produce multiple attempts');
  assert.ok(reads.length > 0, 'the turn must perform prefetch');
  assert.deepEqual(
    reads,
    reads.map(() => context)
  );
});

test('an internal split chain exposes no waiting part for an ordinary follow-up to merge into', async () => {
  const { issueContext } = await import('../src/memory/db/scope.ts');
  const context = issueContext({ kind: 'internal', newId: () => 'ctx:protected-chain', now: () => NOW });
  const waiting: Array<unknown> = [];
  const folded: Array<unknown> = [];
  const llm = splitLlm({
    talk: (index: number) => {
      if (index === 0) {
        waiting.push(turns.waitingParts('c1', 'u1'));
        folded.push(
          turns.addToPart('c1', 'u1', 2, { id: 'stale-followup', text: 'untrusted-followup-marker', ts: NOW })
        );
      }
      return '<msg>protected part answer</msg>';
    },
  });
  const raw = rawMessage({ id: 'protected-chain', content: SPLIT_TEXT, ts: NOW - 1000 });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: splitHot(),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    lookup: fakeLookup(),
    now: () => NOW,
    schedule: manualSchedule(),
    memoryContext: issueContext,
  });
  await withCapturedLogs(() =>
    turns.runTurn({
      channel,
      mode: 'reply',
      trigger: normalizedTrigger(raw),
      triggerKind: 'mention',
      memoryContext: context,
    })
  );
  assert.equal(llm.calls.talk.length, 3);
  assert.deepEqual(waiting, [[]]);
  assert.deepEqual(folded, [false]);
  assert.ok(llm.calls.talk.every((request) => !JSON.stringify(request.messages).includes('untrusted-followup-marker')));
});

for (const replacement of ['author', 'shorter'] as const) {
  test(`a delayed merge queues its message when a replacement chain has ${replacement === 'author' ? 'a different author' : 'fewer parts'}`, async () => {
    const decision = Promise.withResolvers<{ text: string }>();
    const pending: PendingQueue = { list: [] };
    const incomingText = 'delayed-followup-evidence';
    const incoming: Line = {
      id: 'late-followup',
      placeId: 'c1',
      authorId: 'u1',
      authorName: 'Member',
      content: incomingText,
      ts: NOW,
      replyToId: null,
      mentionedAccountIds: [],
    };
    const mergeChannel = channelInfo('c1');
    const llm = splitLlm({
      split: (index) =>
        index === 1 && replacement === 'shorter'
          ? SPLIT_PARTS.slice(0, 2)
              .map((part) => `- ${part}`)
              .join('\n')
          : PARTS_ANSWER,
      talk: async (index) => {
        if (index === 0) merge.holdCall(mergeChannel, incoming, 'mention');
        if (index === 3) {
          decision.resolve({ text: replacement === 'shorter' ? '2' : '1' });
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        return '<msg>part complete</msg>';
      },
    });
    const turns = createTurnRunner({
      discord: DISCORD,
      createPort: createDiscordAdapter,
      hot: splitHot(),
      store: fakeStore(),
      llm,
      calibrator: identityCalibrator(),
      client: fakeClient(),
      lookup: fakeLookup(),
      now: () => NOW,
      schedule: manualSchedule(),
    });
    const pipelineTurns: PipelineTurns = {
      isBusy: () => true,
      isAnyBusy: () => true,
      runTurn: () => Promise.resolve({ outcome: 'busy' }),
      notePost() {},
      waitingParts: turns.waitingParts,
      addToPart: turns.addToPart,
    };
    const hot = {
      config: {
        bot: { timezone: 'UTC' },
        mention: { neverIgnore: [], repeatWindowMinutes: 0, maxPending: 10 },
        models: { base: { analyzer: 'test/analyzer' } },
        llm: { maxRequestTokens: 50000, maxRequestsPerDay: 100, timeoutMs: 1000 },
      },
      prompts: { labels, merge: 'Choose an item or new. {{items}} {{message}}' },
    };
    const queue = createPendingQueue({
      hot,
      now: () => NOW,
      turns: pipelineTurns,
      missed: null,
      pending,
      followUpMuted: () => null,
    });
    const merge = createMerge({
      hot,
      now: () => NOW,
      turns: pipelineTurns,
      store: { state: { data: {} } },
      pending,
      llm: { complete: () => decision.promise },
      getSelfName: () => 'Persona',
      itemText: queue.itemText,
      enqueuePending: queue.enqueuePending,
      turnBlocked: () => true,
      drainPending: async () => {},
    });
    const first = rawMessage({ id: 'first-chain', content: SPLIT_TEXT, ts: NOW - 1000 });
    const second = rawMessage({
      id: 'replacement-chain',
      content: SPLIT_TEXT,
      ts: NOW,
      authorId: replacement === 'author' ? 'u2' : 'u1',
    });
    const channel = fakeTurnChannel({ historyMessages: [first, second] });
    await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(first), triggerKind: 'mention' });
    await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(second), triggerKind: 'mention' });
    assert.equal(llm.calls.talk.length, replacement === 'shorter' ? 5 : 6);
    assert.deepEqual(
      pending.list.map((ping) => ping.trigger.id),
      ['late-followup']
    );
    assert.equal(
      llm.calls.talk.some((request) => taskOf(request).includes(incomingText)),
      false
    );
  });
}

test('a follow-up folded into the last waiting part appears only in that part', async () => {
  const accepted: Array<boolean> = [];
  const llm = splitLlm({
    talk: (index) => {
      if (index === 0)
        accepted.push(turns.addToPart('c1', 'u1', 3, { id: 'last-followup', text: 'last-part-evidence', ts: NOW }));
      return '<msg>part complete</msg>';
    },
  });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot: splitHot(),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    lookup: fakeLookup(),
    now: () => NOW,
    schedule: manualSchedule(),
  });
  const raw = rawMessage({ id: 'last-part-chain', content: SPLIT_TEXT, ts: NOW - 1000 });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
  assert.deepEqual(accepted, [true]);
  assert.deepEqual(
    llm.calls.talk.map((request) => taskOf(request).includes('last-part-evidence')),
    [false, false, true]
  );
});

test('a triggerless private inner turn writes its completed turn only to its partner journal', async () => {
  const memory = await openTestMemory({ now: () => NOW });
  try {
    let id = 0;
    const journal = createJournal({
      memoryDb: memory.memoryDb,
      dataDir: memory.dataDir,
      config: () => ({ thinkChars: 4000 }),
      now: () => NOW,
      uuid: () => `private-turn-${++id}`,
    });
    const hot = splitHot();
    hot.prompts.inner = 'Respond to the private wake.';
    const llm = splitLlm({ talk: '<msg>private inner answer</msg>' });
    const turns = createTurnRunner({
      discord: DISCORD,
      createPort: createDiscordAdapter,
      hot,
      store: fakeStore(),
      llm,
      journal,
      calibrator: identityCalibrator(),
      client: fakeClient(),
      lookup: fakeLookup(),
      now: () => NOW,
      schedule: manualSchedule(),
    });
    const channel = fakeTurnChannel({ id: 'private-room', dm: true, partnerId: 'u1' });
    const result = await turns.runTurn({
      channel,
      placeId: 'g1',
      mode: 'inner',
      triggerKind: 'inner',
      inner: {
        wake: {
          kind: 'intention_due',
          items: [],
          intentions: [],
          now: NOW,
          timezone: 'UTC',
          channels: [],
          budgets: { chain: { used: 0, cap: 3, left: 3 } },
        },
        shadow: false,
        mayAct: () => true,
      },
    });
    assert.equal(result.outcome, 'spoke');
    const day = new Date(NOW).toISOString().slice(0, 10);
    // A private chat is its own place since places: its turn is journalled there and in no server's journal.
    const privateTurns = await journal.read('private-room', { day, kind: 'turn' });
    const groupTurns = await journal.read('g1', { day, kind: 'turn' });
    assert.equal(groupTurns.length, 0);
    assert.equal(privateTurns.length, 1);
    const privateTurn = privateTurns[0];
    assert.ok('mode' in privateTurn && 'scope' in privateTurn);
    assert.equal(privateTurn.mode, 'inner');
    // Its place says it is private; the scope of a record is the conversation it happened in.
    assert.deepEqual(privateTurn.scope, { channel: 'private-room' });
  } finally {
    await memory.close();
  }
});

test('automatic prefetch receives the turn conversation identity', async () => {
  const reads: Array<unknown> = [];
  const recall = {
    available: () => true,
    prefetch: (args: Record<string, unknown>) => {
      reads.push(args.historyRef);
      return Promise.resolve({ status: 'ok', basis: ['message'], excerpts: [], ms: 0 });
    },
  };
  await runSplitTurn({ extra: { recall } });
  assert.ok(reads.length > 0, 'the turn must perform prefetch');
  assert.deepEqual(
    reads,
    reads.map(() => ({ iface: 'discord', conversationId: 'c1' }))
  );
});
