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
import { ANSWER, ROOT, SELF, channelInfo, lineEvent, until, withFakeCore } from './fixtures/core-over-fake.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
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
import { chainsOf } from './fixtures/chains.ts';

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
  // The lead: split, merge and missed answer in strict JSON (owner, 2026-11-06).
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
        index === 1 && replacement === 'shorter' ? JSON.stringify({ parts: SPLIT_PARTS.slice(0, 2) }) : PARTS_ANSWER,
      talk: async (index) => {
        if (index === 0) merge.holdCall(mergeChannel, incoming, 'mention');
        if (index === 3) {
          decision.resolve({ text: replacement === 'shorter' ? '{"item":2}' : '{"item":1}' });
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
        models: { routes: chainsOf({ analyzer: 'test/analyzer' }) },
        llm: { maxRequestTokens: 50000, maxRequestsPerDay: 100, timeoutMs: 1000 },
      },
      prompts: { labels, 'classify/merge': 'Choose an item or new. {{items}} {{message}}' },
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
    hot.prompts['turn/inner'] = 'Respond to the private wake.';
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
    // Its place says it is private; the scope of a record is the chat it happened in.
    assert.deepEqual(privateTurn.scope, { channel: 'private-room' });
  } finally {
    await memory.close();
  }
});

test('automatic prefetch receives the turn chat identity', async () => {
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
    reads.map(() => ({ iface: 'discord', chatId: 'c1' }))
  );
});

// `context.memory.openPrivate` over the whole core and the fake interface: Marta (u2) talks to her in the direct chat
// d2, where she sets an intention, and the next turn runs in the group chat c1 or in Zoe's (u3) direct chat d3.
const OPEN_AT = Date.now() - 60_000;
const DM_LINE = 'ΜΟΝΟ-ΣΤΟ-ΙΔΙΩΤΙΚΟ';
const DM_INTENTION = 'ΠΡΟΘΕΣΗ-ΤΟΥ-ΙΔΙΩΤΙΚΟΥ';

const fakeMember = (id: string, name: string) => ({
  id,
  name,
  bot: false,
  groupIds: [],
  avatar: { hash: null, url: null, largeUrl: null },
});

/** A message of `authorId` in their direct chat `chatId`, as the fake interface delivers it. */
function dmLine(id: string, chatId: string, authorId: string, text: string, at: number) {
  const event = lineEvent({ id, chatId, text, at, authorId, authorName: authorId });
  return { ...event, chat: { id: chatId, kind: 'dm' as const, rootId: null, name: null, partnerId: authorId } };
}

/** The text of the request of the turn that answers `next` after Marta's direct chat, with the switch at `open`. */
async function requestAfterDm(open: boolean, next: 'group' | 'other-dm'): Promise<string> {
  const { result } = await withFakeCore(
    {
      config: {
        bot: { timezone: 'UTC', access: { 'intention.set': { users: [SELF.id] } } },
        dm: { enabled: true },
        private: { minAffinity: -1000 },
        features: { intentions: true },
        context: { memory: { openPrivate: open } },
      },
      answers: [toolAnswer('', [call('intention.set', { text: DM_INTENTION })]), `<msg>${ANSWER}</msg>`],
      seed: (fake) => {
        fake.seedChat(channelInfo('c1'));
        for (const [id, name] of [
          ['u1', 'Eleni'],
          ['u2', 'Marta'],
          ['u3', 'Zoe'],
        ] as const) {
          fake.seedMember(ROOT.id, fakeMember(id, name));
          fake.seedDmChat(id, `d${id.slice(1)}`);
          fake.seedChat({ ...channelInfo(`d${id.slice(1)}`), kind: 'dm', rootId: null, name: null, partnerId: id });
        }
      },
    },
    async (rig) => {
      const send = async (event: ReturnType<typeof lineEvent>) => {
        rig.fake.seedEvent(event);
        await rig.emit(event);
      };
      // Each partner says a line in the group first, so the private gate knows them.
      await send(lineEvent({ id: 'm0', text: 'καλημέρα', at: OPEN_AT, authorId: 'u2', authorName: 'Marta' }));
      await send(lineEvent({ id: 'm1', text: 'γεια', at: OPEN_AT + 100, authorId: 'u3', authorName: 'Zoe' }));
      await send(dmLine('m2', 'd2', 'u2', DM_LINE, OPEN_AT + 1000));
      await until(() => rig.posted('d2').length > 0);
      const seen = rig.requests.length;
      if (next === 'group') await send(lineEvent({ id: 'm3', text: 'εδώ;', at: OPEN_AT + 5000, mention: true }));
      else await send(dmLine('m3', 'd3', 'u3', 'εδώ;', OPEN_AT + 5000));
      await until(() => rig.requests.length > seen);
      return rig.requestText(rig.requests.length - 1);
    }
  );
  return result;
}

test('with context.memory.openPrivate on, a group turn holds a line and an intention of a direct chat; off, neither', async () => {
  // Bug: the switch opens her memory, but the group request is built from reads still split by place.
  const on = await requestAfterDm(true, 'group');
  assert.deepEqual([on.includes(DM_LINE), on.includes(DM_INTENTION)], [true, true]);
  const off = await requestAfterDm(false, 'group');
  assert.deepEqual([off.includes(DM_LINE), off.includes(DM_INTENTION)], [false, false]);
});

test("with context.memory.openPrivate on, a direct chat's turn holds a line of another person's direct chat; off, not", async () => {
  // Bug: the switch opens a group to her direct chats, but one direct chat stays closed to another.
  assert.equal((await requestAfterDm(true, 'other-dm')).includes(DM_LINE), true);
  assert.equal((await requestAfterDm(false, 'other-dm')).includes(DM_LINE), false);
});
