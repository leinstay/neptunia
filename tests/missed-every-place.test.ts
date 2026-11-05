// The missed-answer check runs for every group place and every DM on every interface, each with a registry of its own.
// Contract, plan 2026-11-04-cli-and-memory B2:
//   `createMissed` takes no `iface`; `noteFact({ reason, message, iface })` names the line's interface and the candidate
//   keeps it, so its sweep reads its conversation there and its recovery turn runs there
//   `start(placeId)` adds the stored registry of that place to the ones already started; `save()` writes each candidate
//   under the unit `missed` of its own place
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMissed } from '../src/behavior/missed.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { createReads } from '../src/interface/reads.ts';
import type { ConversationInfo } from '../src/protocol/adapter.ts';
import { labels } from './fixtures/labels.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { channel as channelOf } from './fixtures/reads-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const T0 = Date.parse('2026-11-05T12:00:00Z');
const MINUTE = 60_000;

type Spot = { iface: string; place: Partial<ConversationInfo> & { id: string } };

const GROUP_A: Spot = { iface: 'alpha', place: { id: 'c1', kind: 'channel', rootId: 'g1' } };
const GROUP_B: Spot = { iface: 'beta', place: { id: 'r1', kind: 'channel', rootId: 'r1' } };
const DM_B: Spot = { iface: 'beta', place: { id: 'd1', kind: 'dm', chatType: 'dm', rootId: null, partnerId: 'u1' } };
/** A place on another interface under the native id of GROUP_A. */
const TWIN: Spot = { iface: 'beta', place: { id: 'c1', kind: 'channel', rootId: 'r9' } };

type LlmCall = { user: string; options: { purpose?: string } };
type TurnCall = { conversation: { iface: string; conversationId: string }; triggerKind: string };

function memberLine(spot: Spot, id: string, at: number) {
  return {
    id,
    placeId: spot.place.id,
    authorId: 'u1',
    authorName: 'Eleni',
    self: false,
    bot: false,
    content: 'έχεις νέα;',
    ts: at,
    replyToId: null,
  };
}

function eventOf(spot: Spot, line: ReturnType<typeof memberLine>) {
  return {
    kind: 'message.received',
    iface: spot.iface,
    at: line.ts,
    id: `${spot.iface}:message:${line.id}`,
    // Type fix (plan B1 amendment, approved): the place carries its own `id`, so it is not written twice.
    conversation: { kind: 'channel', name: spot.place.id, ...spot.place },
    message: {
      id: line.id,
      author: { id: line.authorId, name: line.authorName, self: false, bot: false },
      content: line.content,
      sourceText: line.content,
      system: false,
      at: line.ts,
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
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedConversationIds: [] },
  };
}

/** One registry over a fake adapter per interface, with hand timers and a fake model. */
function scene({
  spots,
  answer = '1: uncertain',
  memoryDb,
  partners = {},
}: {
  spots: Array<Spot>;
  answer?: string;
  memoryDb?: unknown;
  partners?: Record<string, string>;
}) {
  const quiet = { info() {}, warn() {}, error() {} };
  const fakes = new Map<string, ReturnType<typeof createFakeAdapter>>();
  const readsOf = new Map<string, ReturnType<typeof createReads>>();
  const adapterOf = (iface: string) => {
    let fake = fakes.get(iface);
    if (!fake) {
      fake = createFakeAdapter({ iface, selfId: 'self-id' });
      fakes.set(iface, fake);
      readsOf.set(iface, createReads(fake, quiet));
    }
    return fake;
  };
  for (const spot of spots)
    adapterOf(spot.iface).seedConversation(channelOf(spot.place.id, { iface: spot.iface, ...spot.place }));
  const reads = new Proxy(
    {},
    {
      get:
        (_target, name: string) =>
        (first: { iface?: string }, ...rest: Array<unknown>) => {
          const target = readsOf.get(String(first?.iface)) as unknown as
            Record<string, (...args: Array<unknown>) => unknown> | undefined;
          return target ? target[name]?.(first, ...rest) : Promise.resolve(null);
        },
    }
  );
  const pending: Array<() => unknown> = [];
  const llmCalls: Array<LlmCall> = [];
  const turnCalls: Array<TurnCall> = [];
  let at = T0;
  const missed = createMissed(
    wrongly<Parameters<typeof createMissed>[0]>({
      hot: {
        config: { bot: { timezone: 'UTC' }, missed: {}, models: {}, llm: {} },
        prompts: { missed: 'Check {{name}}.', labels },
      },
      store: { state: { data: { paused: false } } },
      journal: null,
      llm: {
        complete: (messages: Array<{ content: unknown }>, options: LlmCall['options']) => {
          llmCalls.push({ user: JSON.stringify(messages[1]?.content), options });
          return Promise.resolve({ text: answer });
        },
      },
      turns: {
        triggerOf: () => null,
        lastPostAt: () => 0,
        isBusy: () => false,
        isAnyBusy: () => false,
        runTurn: (params: TurnCall) => {
          turnCalls.push(params);
          return Promise.resolve({ outcome: 'spoke' });
        },
      },
      reads,
      partnerOf: (id: string) => partners[id] ?? null,
      getSelfName: () => 'Nova',
      dataDir: tempDir('nep-missed-places-'),
      ...(memoryDb ? { memoryDb } : {}),
      now: () => at,
      timers: {
        set: (fn: () => unknown) => {
          pending.push(fn);
          return pending.length;
        },
        clear() {},
      },
      log: quiet,
    })
  );
  /** Seeds a line of `spot` into that interface's history. */
  function seedLine(spot: Spot, id: string) {
    const line = memberLine(spot, id, at);
    const event = eventOf(spot, line);
    adapterOf(spot.iface).seedEvent(wrongly<Parameters<ReturnType<typeof createFakeAdapter>['seedEvent']>[0]>(event));
    return line;
  }
  /** Notes a failed gate on a line of `spot`. */
  function failGate(spot: Spot, id: string) {
    missed.noteFact(wrongly({ reason: 'gate-failed', message: seedLine(spot, id), iface: spot.iface }));
  }
  /** Moves past the sweep delay and fires every armed sweep. */
  async function sweep() {
    at += 2 * MINUTE;
    for (const fn of pending.splice(0)) await fn();
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }
  return { missed, failGate, seedLine, sweep, llmCalls, turnCalls };
}

test('a candidate on a second interface is checked in its own place', async () => {
  // Bug: `iface()` answers one interface, so the sweep finds no conversation and the owed line is lost.
  const run = scene({ spots: [GROUP_A, GROUP_B] });
  await run.missed.start('r1');
  run.failGate(GROUP_B, 'm1');
  await run.sweep();
  assert.deepEqual(
    run.llmCalls.map((call) => call.options.purpose),
    ['missed']
  );
});

test('a candidate in a DM on a second interface is checked in that DM', async () => {
  // Bug: the private path assumes the home interface.
  const run = scene({ spots: [GROUP_A, DM_B], partners: { d1: 'u1' } });
  await run.missed.start('d1');
  run.failGate(DM_B, 'm1');
  await run.sweep();
  assert.equal(run.llmCalls.length, 1);
});

test('two candidates under one native id on two interfaces are checked apart', async () => {
  // Bug: the sweep is keyed by the native id, so one interface's place swallows the other's line.
  const run = scene({ spots: [GROUP_A, TWIN] });
  await run.missed.start('c1');
  run.failGate(GROUP_A, 'm1');
  run.failGate(TWIN, 'm2');
  await run.sweep();
  assert.equal(run.llmCalls.length, 2);
});

test('an owed line on a second interface gets its recovery turn there', async () => {
  // Bug: the recovery turn opens on the home interface, or none opens at all.
  const run = scene({ spots: [GROUP_A, GROUP_B], answer: '1: owed' });
  await run.missed.start('r1');
  run.failGate(GROUP_B, 'm1');
  await run.sweep();
  assert.equal(run.turnCalls.length, 1);
  assert.deepEqual(run.turnCalls[0]?.conversation, { iface: 'beta', conversationId: 'r1' });
  assert.equal(run.turnCalls[0]?.triggerKind, 'missed');
});

test('starting a second place keeps the candidates of the first', async () => {
  // Bug: `start` replaces the one registry, so the second place wipes the first from memory.
  const { memoryDb } = await openTestMemory();
  const run = scene({ spots: [GROUP_A, GROUP_B], memoryDb });
  await run.missed.start('c1');
  run.failGate(GROUP_A, 'm1');
  await run.missed.start('r1');
  assert.deepEqual(
    run.missed.candidates().map((candidate) => candidate.messageId),
    ['m1']
  );
});

test('each candidate is stored under its own place and comes back with that place alone', async () => {
  // Bug: every candidate lands in the unit of the one loaded place, so a place's registry holds another's lines.
  const { memoryDb } = await openTestMemory();
  const first = scene({ spots: [GROUP_A, GROUP_B, DM_B], memoryDb, partners: { d1: 'u1' } });
  await first.missed.start('c1');
  await first.missed.start('r1');
  await first.missed.start('d1');
  first.failGate(GROUP_A, 'm1');
  first.failGate(GROUP_B, 'm2');
  first.failGate(DM_B, 'm3');
  await first.missed.save();

  for (const [place, expected] of [
    ['c1', 'm1'],
    ['r1', 'm2'],
    ['d1', 'm3'],
  ] as const) {
    const after = scene({ spots: [GROUP_A, GROUP_B, DM_B], memoryDb, partners: { d1: 'u1' } });
    await after.missed.start(place);
    assert.deepEqual(
      after.missed.candidates().map((candidate) => candidate.messageId),
      [expected],
      place
    );
  }
});

test('a candidate comes back after a restart with its interface, and its sweep runs there', async () => {
  // Bug: the stored candidate loses `iface`, so a recovery after a restart reads the wrong interface.
  const { memoryDb } = await openTestMemory();
  const first = scene({ spots: [GROUP_A, GROUP_B], memoryDb });
  await first.missed.start('r1');
  first.failGate(GROUP_B, 'm1');
  await first.missed.save();

  const after = scene({ spots: [GROUP_A, GROUP_B], memoryDb });
  after.seedLine(GROUP_B, 'm1');
  await after.missed.start('r1');
  await after.sweep();
  assert.equal(after.llmCalls.length, 1);
});

test('a place with nothing stored starts with an empty registry', async () => {
  // Bug: a place never seen before throws at start and stops the core from coming up.
  const { memoryDb } = await openTestMemory();
  const run = scene({ spots: [GROUP_B], memoryDb });
  await run.missed.start('r1');
  assert.deepEqual(run.missed.candidates(), []);
});
