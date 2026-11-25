import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDrain } from '../../../src/pipeline/drain.ts';
import type { PendingQueue, PipelineTurns } from '../../../src/pipeline/types.ts';
import { issueContext } from '../../../src/memory/db/scope.ts';
import { channelInfo } from '../../fixtures/core-over-fake.ts';
import { createTagHistory } from '../../../src/behavior/mention.ts';
import { deepMerge } from '../../../src/config.ts';
import { labels } from '../../fixtures/labels.ts';
import {
  baseConfig,
  fakeChannelWithMessage,
  fakeGuild,
  fakeMemory,
  fakeMessage,
  fakeStore,
  fakeTurns,
  makeHandler,
  mutableNow,
  noticesOf,
  scripted,
} from '../../fixtures/events-rig.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { seedExisting, syncStub, useIface, useSelf, world } from '../../fixtures/turn-world.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import { OWNER_PERSON, ownedBy } from '../../fixtures/owner-accounts.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';

const NOW = Date.parse('2026-10-24T12:00:00Z');

for (const privileged of [true, false]) {
  test(`${privileged ? 'an authenticated' : 'an ordinary'} queued call ${privileged ? 'runs' : 'is skipped'} after an ordinary turn saw its line`, async () => {
    const channel = channelInfo('cli:dm:owner', { iface: 'cli', kind: 'dm', rootId: null, partnerId: 'owner' });
    const memoryContext = issueContext({ kind: 'internal', newId: () => 'ctx:queued-owner', now: () => NOW });
    const pending: PendingQueue = {
      list: [
        {
          channel,
          placeId: channel.id,
          kind: 'private',
          arrivedAt: NOW,
          trigger: {
            id: 'queued-query',
            placeId: channel.id,
            authorId: 'owner',
            content: 'read the private evidence',
            ts: NOW,
            replyToId: null,
            mentionedAccountIds: [],
          },
          ...(privileged ? { readOptions: { memoryContext } } : {}),
        },
      ],
    };
    const requests: Array<Parameters<PipelineTurns['runTurn']>[0]> = [];
    const turns: PipelineTurns = {
      isBusy: () => false,
      isAnyBusy: () => false,
      spokeAfterSeeing: () => true,
      notePost() {},
      runTurn: (request) => {
        requests.push(request);
        return Promise.resolve({ outcome: 'spoke' });
      },
    };
    const config = {
      bot: { timezone: 'UTC' },
      mention: { neverIgnore: [], repeatWindowMinutes: 0, pendingMinutes: 10 },
      dm: { enabled: true },
    };
    const { drainPending } = createDrain({
      hot: { config },
      store: { state: { data: {} } },
      now: () => NOW,
      rng: () => 0,
      sleep: () => Promise.resolve(),
      turns,
      pending,
      logPending() {},
      noteUnanswered() {},
      queuedCount: () => 0,
      queuedFor: () => () => [],
      requeueBusy: () => false,
      currentOf: (current) => Promise.resolve(current),
      refOf: (current) => ({ iface: 'cli', chatId: current.id }),
      heldCallState: () => Promise.resolve(true),
      afterCallTurn: () => Promise.resolve(),
      checkPrivateGate: () => Promise.resolve({ gate: { ok: true }, isOwner: true }),
      dropPrivate() {},
      afterPrivateTurn: () => Promise.resolve(),
      followUpStale: () => null,
      decideAndLog: () => ({ respond: true, reason: 'fixture', ignoreChance: 0 }),
    });
    await drainPending();
    assert.deepEqual(pending.list, []);
    assert.equal(requests.length, privileged ? 1 : 0);
    if (privileged) {
      assert.deepEqual(requests[0]?.chat, { iface: 'cli', chatId: 'cli:dm:owner' });
      assert.equal(requests[0]?.memoryContext, memoryContext);
    }
  });
}

// A queued DM (src/pipeline/drain.ts) carries the interface and the chat it came from: it needs no root and
// never takes the home root of another interface. `dmRootOf` is the private gate's own answer, the one the live
// path uses, so a DM reaches the same root whether it waited or not.

const NOW_DM = Date.parse('2026-11-05T12:00:00Z');
const CONFIG = {
  bot: { timezone: 'UTC' },
  mention: { neverIgnore: [], repeatWindowMinutes: 0, pendingMinutes: 10 },
  dm: { enabled: true },
};

type TurnAsked = Parameters<PipelineTurns['runTurn']>[0];
type Drained = {
  turns: Array<TurnAsked>;
  gates: Array<{ root: unknown; iface: unknown }>;
  afterTurns: Array<{ root: unknown; iface: unknown }>;
};

/** Drains one DM written on interface `iface`, with `home` as the core's home root. */
async function drainDm(iface: string, home: string | null): Promise<Drained> {
  const channel = channelInfo('d1', { iface, kind: 'dm', rootId: null, partnerId: 'u1' });
  const pending: PendingQueue = {
    list: [
      {
        channel,
        placeId: channel.id,
        kind: 'private',
        arrivedAt: NOW_DM,
        trigger: {
          id: 'm1',
          placeId: channel.id,
          authorId: 'u1',
          content: 'hello',
          ts: NOW_DM,
          replyToId: null,
          mentionedAccountIds: [],
        },
      },
    ],
  };
  const drained: Drained = { turns: [], gates: [], afterTurns: [] };
  const turns: PipelineTurns = {
    isBusy: () => false,
    isAnyBusy: () => false,
    spokeAfterSeeing: () => false,
    notePost() {},
    runTurn: (request) => {
      drained.turns.push(request);
      return Promise.resolve({ outcome: 'spoke' });
    },
  };
  // A variable, so the home reader stays beside the new field while the implementer moves from one to the other.
  const context = {
    hot: { config: CONFIG },
    store: { state: { data: {} } },
    now: () => NOW_DM,
    rng: () => 0,
    sleep: () => Promise.resolve(),
    turns,
    isServedRoot: (id: unknown) => id === home,
    pending,
    logPending() {},
    noteUnanswered() {},
    queuedCount: () => 0,
    queuedFor: () => () => [],
    requeueBusy: () => false,
    currentOf: (current: typeof channel) => Promise.resolve(current),
    refOf: (current: typeof channel) => ({ iface: current.iface, chatId: current.id }),
    heldCallState: () => Promise.resolve(true as const),
    afterCallTurn: () => Promise.resolve(),
    checkPrivateGate: (_config: unknown, _author: string, name?: string) => {
      drained.gates.push({ root: null, iface: name });
      return Promise.resolve({ gate: { ok: true }, isOwner: false });
    },
    dropPrivate() {},
    afterPrivateTurn: (current: typeof channel) => {
      drained.afterTurns.push({ root: null, iface: current.iface });
      return Promise.resolve();
    },
    followUpStale: () => null,
    decideAndLog: () => ({ respond: true, reason: 'fixture', ignoreChance: 0 }),
  };
  await createDrain(context).drainPending();
  return drained;
}

test('a queued DM with no root anywhere runs its turn on its own interface', async () => {
  // Bug: the drain requires a home root and drops the DM of a core that serves none.
  const { turns, gates, afterTurns } = await drainDm('other', null);
  assert.deepEqual(
    turns.map((turn) => turn.chat),
    [{ iface: 'other', chatId: 'd1' }]
  );
  assert.equal(turns[0]?.placeId ?? null, null);
  assert.deepEqual(gates, [{ root: null, iface: 'other' }]);
  assert.deepEqual(afterTurns, [{ root: null, iface: 'other' }]);
});

test('a queued DM is gated on its own interface whatever another one serves', async () => {
  // Bug: a DM on the second interface is gated and remembered under the first interface's root.
  // A private chat is its own place, whichever servers its interface holds.
  const { turns, gates } = await drainDm('other', 'home-of-first');
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.placeId ?? null, null);
  assert.equal(gates[0]?.iface, 'other');
});

// ---------------------------------------------------------------------------
// One attention (mention.oneAtATime) -- a direct ping (mention/reply)
// that arrives while a turn is running elsewhere is remembered as pending
// instead of dropped; drainPending() (called in production once a turn
// frees its channel, see src/behavior/turn.ts's setOnIdle) answers the
// oldest one through the normal reply path after a human switch pause.

function directPingMessage(overrides: Record<string, Untyped> = {}) {
  return fakeMessage({
    id: 'm1',
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
    ...overrides,
  });
}

/** tagHistory that counts its hits, to prove a deferred ping is not counted on arrival. */
function countingTagHistory() {
  const inner = createTagHistory();
  const tags = {
    hits: 0,
    count: (...args: Parameters<typeof inner.count>) => inner.count(...args),
    hit: (...args: Parameters<typeof inner.hit>) => ((tags.hits += 1), inner.hit(...args)),
  };
  return tags;
}

// A turn that starts during the drain's switch pause makes the drain's
// runTurn answer 'busy': the picked-up ping goes back into the queue (its
// original arrivedAt kept, its `respond` decision carried) and the pass stops
// until the running turn ends and calls drainPending again.

/**
 * Turns where another channel ('other') is running a turn while `busy` is set: runTurn answers
 * 'busy' then (one attention), records every call. `startDuringPause()` is meant for the
 * injected sleep: the first switch pause starts that other turn.
 */
function pauseRaceTurns() {
  const state = { busy: true };
  const calls: Array<Untyped> = [];
  const turns: Record<string, Untyped> = fakeTurns({
    isBusy: (id: string) => state.busy && id === 'other',
    isAnyBusy: () => state.busy,
    runTurn: async (args: Record<string, Untyped>) => {
      calls.push(args);
      return { outcome: state.busy ? 'busy' : 'spoke' };
    },
  });
  turns.calls = calls;
  turns.state = state;
  return turns;
}

function fakeStateStore(data: Record<string, Untyped> = {}) {
  const base = fakeStore();
  const store = Object.assign(base, {
    dirtyCount: 0,
    state: {
      data,
      markDirty() {
        store.dirtyCount += 1;
      },
    },
  });
  return store;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// Private chat (features.privateMessages): a DM from a member of the served
// guild runs through privateGate (src/behavior/private.ts) and, when it
// passes, a reply turn with the pinned placeId. Limit notices: a triggered
// turn refused by a rail gets one plain line naming the limit.

const TODAY = '2026-09-29';
const TODAY_MS = Date.parse(`${TODAY}T12:00:00Z`);

function privateConfig(overrides: Record<string, Untyped> = {}) {
  return baseConfig(
    deepMerge(
      // PR 7d: features.privateMessages is the key dm.enabled, and the daily reply caps are gone.
      { bot: { ownerPerson: OWNER_PERSON }, dm: { enabled: true } },
      overrides
    )
  );
}

function fakeDmChannel(id = 'dm1', recipientId = 'u1', overrides: Record<string, Untyped> = {}) {
  const sent: Array<Untyped> = [];
  world().channel({ id, dm: true, partnerId: recipientId ?? null }, { keep: true });
  seedExisting(id, 'dm-m1');
  return {
    id,
    type: 'DM',
    guild: null,
    recipientId,
    sent,
    send: async (payload: Record<string, Untyped>) => {
      sent.push(payload);
      return { id: `sent${sent.length}` };
    },
    messages: { cache: new Map([['dm-m1', {}]]), fetch: async () => ({}) },
    ...overrides,
  };
}

function fakeDmMessage(overrides: Record<string, Untyped> = {}) {
  const channel = overrides.channel ?? fakeDmChannel();
  return fakeMessage({
    id: 'dm-m1',
    guild: null,
    member: null,
    channel,
    placeId: channel.id,
    cleanContent: 'γεια σου',
    ...overrides,
  });
}

/** A client of a served root the interface knows `members` and `fetchable` ones of; `fetchCalls` lists each member read. */
function fakeDmClient({
  members = ['u1', 'owner1'],
  fetchable = [],
}: { members?: Untyped; fetchable?: Array<Untyped> } = {}) {
  const fetchCalls: Array<Untyped> = [];
  return { user: { id: 'self1', username: 'Neptunia' }, fetchCalls, knows: [...members, ...fetchable] };
}

/** A store with public profiles and private files; records the private bookkeeping calls. */
function fakePrivateStore({
  profiles = { u1: { affinity: { score: 10 } }, owner1: { affinity: { score: -50 } } },
  privates = {},
}: { profiles?: Untyped; privates?: Record<string, Untyped> } = {}) {
  return {
    state: { data: {} },
    getUser: (accountId: string) => profiles[accountId] ?? null,
    getPrivate: (accountId: string) => privates[accountId] ?? null,
    // PR 7d: memory is code, so the real turn reads these of the store.
    getPlace: () => ({}),
    listChannels: () => [],
    listUserProfiles: () => [],
    countUsers: () => Object.keys(profiles).length,
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
  };
}

function recordingTurns(result = { outcome: 'spoke' }, extra = {}) {
  const calls: Array<Untyped> = [];
  const turns: Record<string, Untyped> = fakeTurns({
    runTurn: async (args: Record<string, Untyped>) => {
      calls.push(args);
      return result;
    },
    ...extra,
  });
  turns.calls = calls;
  return turns;
}

function makeDmHandler({
  config,
  store,
  client,
  turns,
  memory,
  ...rest
}: { config?: Untyped; store?: Untyped; client?: Untyped; turns?: Untyped; memory?: Untyped; rest?: Untyped } = {}) {
  return makeHandler({
    config: config ?? privateConfig(),
    store: store ?? fakePrivateStore(),
    client: client ?? fakeDmClient(),
    turns: turns ?? recordingTurns(),
    memory: memory ?? fakeMemory(),
    prompts: { labels },
    now: () => TODAY_MS,
    ...rest,
  });
}

/** A src/behavior/missed.ts stand-in recording the facts and the activity it is told of. */
function recordingMissed() {
  const facts: Array<Untyped> = [];
  const activity: Array<Untyped> = [];
  return {
    facts,
    activity,
    noteFact: (fact: string) => facts.push(fact),
    noteActivity: (placeId: string, at: Array<Record<string, Untyped>>) => activity.push([placeId, at]),
  };
}
describe('events of the pipeline', () => {
  let stopOwners: Array<() => void> = [];
  before(() => {
    useIface('fake');
    useSelf('self1');
    stopOwners = [ownedBy(['owner1'])];
  });
  after(() => {
    useIface('discord');
    useSelf('self-id');
    for (const stop of stopOwners) stop();
  });

  test('events: a call that waited past mention.pendingMinutes is a pending-expired missed fact', async () => {
    const missed = recordingMissed();
    const config = baseConfig();
    const turns = fakeTurns({
      isBusy: () => false,
      isAnyBusy: () => true,
      runTurn: async () => ({ outcome: 'spoke' }),
    });
    const clock = mutableNow(0);
    const handler = makeHandler({ config, turns, sleep: async () => {}, now: clock, rng: scripted([]), missed });
    const guild = fakeGuild();
    const channel = fakeChannelWithMessage('c1', guild, 'm1');
    await handler(directPingMessage({ guild, channel, placeId: 'c1' }));
    clock.set(config.mention.pendingMinutes * 60_000 + 1);
    await handler.drainPending();
    assert.deepEqual(
      missed.facts.map((fact) => [fact.reason, fact.message.id]),
      [['pending-expired', 'm1']]
    );
  });

  test('events: a pending ping whose channel lost send permission is dropped with a cannot-send log line', async () => {
    let called = false;
    let canSendNow = true;
    const turns = fakeTurns({
      isBusy: () => false,
      isAnyBusy: () => true,
      runTurn: async () => {
        called = true;
        return { outcome: 'spoke' };
      },
    });
    const handler = makeHandler({ turns, sleep: async () => {}, rng: scripted([0.5]) });

    const guild = fakeGuild();
    const channel = fakeChannelWithMessage('c1', guild, 'm1', { permissionsFor: () => ({ has: () => canSendNow }) });
    await handler(directPingMessage({ guild, channel, placeId: 'c1' }));

    canSendNow = false; // permission lost while the ping was pending
    syncStub(channel);
    const { logs } = await withCapturedLogs(() => handler.drainPending());

    assert.equal(called, false);
    const dropped = logs.filter((entry) => entry.msg === 'mention: dropped');
    assert.equal(dropped.length, 1, 'logged exactly once');
    assert.equal(dropped[0].channel, 'c1');
    assert.equal(dropped[0].kind, 'mention');
    assert.equal(dropped[0].reason, 'cannot-send');
    assert.equal(
      logs.some((entry) => entry.msg === 'mention: decided'),
      false,
      'no ignore roll'
    );
  });

  test('events: several pending pings drain oldest first, one at a time (never concurrently)', async () => {
    const order: Array<Untyped> = [];
    let concurrent = 0;
    let sawConcurrency = false;
    const turns = fakeTurns({
      isBusy: () => false,
      isAnyBusy: () => true,
      runTurn: async (args: Record<string, Untyped>) => {
        concurrent += 1;
        if (concurrent > 1) sawConcurrency = true;
        order.push(args.chat.chatId);
        await Promise.resolve();
        concurrent -= 1;
        return { outcome: 'spoke' };
      },
    });
    let t = 1_000_000;
    const now = () => (t += 1);
    const handler = makeHandler({
      turns,
      sleep: async () => {},
      now,
      rng: scripted([0.5, 0.99, 0.5, 0.99, 0.5, 0.99]),
    });

    const guild = fakeGuild();
    for (const id of ['c1', 'c2', 'c3']) {
      const channel = fakeChannelWithMessage(id, guild, `m-${id}`);
      await handler(directPingMessage({ id: `m-${id}`, guild, channel, placeId: id, cleanContent: id }));
    }

    await handler.drainPending();

    assert.deepEqual(order, ['c1', 'c2', 'c3'], 'oldest arrival first');
    assert.equal(sawConcurrency, false, 'never more than one deferred turn in flight at once');
  });

  test('events: a hot change to mention.pendingMinutes is picked up (a shorter window expires sooner)', async () => {
    let called = false;
    const config = baseConfig();
    const turns = fakeTurns({
      isBusy: () => false,
      isAnyBusy: () => true,
      runTurn: async () => {
        called = true;
        return { outcome: 'spoke' };
      },
    });
    const clock = mutableNow(0);
    const handler = makeHandler({ config, turns, sleep: async () => {}, now: clock, rng: scripted([]) });

    const guild = fakeGuild();
    const channel = fakeChannelWithMessage('c1', guild, 'm1');
    await handler(directPingMessage({ guild, channel, placeId: 'c1' }));

    config.mention.pendingMinutes = 1; // was 10
    clock.set(90_000); // 1.5 minutes later -- expired only under the new, shorter window
    await handler.drainPending();

    assert.equal(called, false);
  });

  test('events: a drained ping whose turn finds another one running is re-queued and answered on the next drain, decided once', async () => {
    const turns = pauseRaceTurns();
    const tagHistory = countingTagHistory();
    let pauses = 0;
    const sleep = async () => {
      pauses += 1;
      if (pauses === 1) turns.state.busy = true; // a fresh turn starts during the first switch pause
    };
    // Exactly three values: switch pause, decideMention, switch pause on the retry -- a second roll would run out.
    const handler = makeHandler({ turns, tagHistory, sleep, rng: scripted([0.5, 0.99, 0.5]) });

    const guild = fakeGuild();
    const channel = fakeChannelWithMessage('c1', guild, 'm1');
    await handler(directPingMessage({ guild, channel, placeId: 'c1' }));
    assert.equal(turns.calls.length, 0, 'deferred');

    turns.state.busy = false;
    const first = await withCapturedLogs(() => handler.drainPending());
    assert.equal(turns.calls.length, 1, 'one attempt, answered busy');
    const again = first.logs.find((entry) => entry.msg === 'mention: deferred again' && entry.reason === 'busy');
    assert.ok(again, 'the re-queue is logged');
    assert.equal(again.channel, 'c1');
    assert.equal(again.kind, 'mention');
    assert.equal(again.pending, 1);

    turns.state.busy = false; // the other turn ends; its onIdle drains again
    const second = await withCapturedLogs(() => handler.drainPending());
    assert.equal(turns.calls.length, 2);
    const secondCall = turns.calls[1];
    assert.equal(secondCall.trigger.id, 'm1');
    assert.equal(secondCall.triggerKind, 'mention');
    assert.equal(tagHistory.hits, 1, 'counted toward spamThreshold once');
    const decided = [...first.logs, ...second.logs].filter((entry) => entry.msg === 'mention: decided');
    assert.equal(decided.length, 1, 'one decision for the ping');
    assert.equal(pauses, 2, 'the switch pause stays on the retry');
  });
});

describe('events of the pipeline', () => {
  let stopOwners: Array<() => void> = [];
  before(() => {
    useIface('fake');
    useSelf('self1');
    stopOwners = [ownedBy(['owner1'])];
  });
  after(() => {
    useIface('discord');
    useSelf('self-id');
    for (const stop of stopOwners) stop();
  });

  test('events: a re-queued ping keeps its original arrivedAt and expires mention.pendingMinutes after it', async () => {
    const turns = pauseRaceTurns();
    const clock = mutableNow(0);
    const sleep = async () => {
      turns.state.busy = true;
    };
    const handler = makeHandler({ turns, sleep, now: clock, rng: scripted([0.5, 0.99]) });

    const guild = fakeGuild();
    const channel = fakeChannelWithMessage('c1', guild, 'm1');
    await handler(directPingMessage({ guild, channel, placeId: 'c1' }));

    turns.state.busy = false;
    clock.set(5 * 60_000);
    await handler.drainPending();
    assert.equal(turns.calls.length, 1, 'busy, re-queued');

    turns.state.busy = false;
    clock.set(10 * 60_000); // 10 minutes after the ORIGINAL arrival, 5 after the re-queue
    const { logs } = await withCapturedLogs(() => handler.drainPending());
    assert.equal(turns.calls.length, 1, 'not answered');
    assert.ok(logs.some((entry) => entry.msg === 'mention: expired' && entry.channel === 'c1'));
  });

  test('events: a newer ping queued in the same channel during the switch pause waits behind the re-queued one', async () => {
    const turns = pauseRaceTurns();
    const guild = fakeGuild();
    const channel = fakeChannelWithMessage('c1', guild, 'm1');
    seedExisting(channel.id, 'm2');
    let handler: Untyped = null;
    let pauses = 0;
    const sleep = async () => {
      pauses += 1;
      if (pauses !== 1) return;
      turns.state.busy = true;
      await handler(directPingMessage({ id: 'm2', guild, channel, placeId: 'c1', cleanContent: 'second' }));
    };
    const tagHistory = countingTagHistory();
    // m1: pause, roll; m1 again: pause (already decided); m2: pause, roll.
    handler = makeHandler({ turns, tagHistory, sleep, rng: scripted([0.5, 0.99, 0.5, 0.5, 0.99]) });

    await handler(directPingMessage({ guild, channel, placeId: 'c1', cleanContent: 'first' }));
    turns.state.busy = false;
    const first = await withCapturedLogs(() => handler.drainPending());
    assert.equal(turns.calls.length, 1);
    assert.equal(
      first.logs.some((entry) => entry.msg === 'mention: dropped'),
      false,
      'nothing leaves the queue'
    );
    const again = first.logs.find((entry) => entry.msg === 'mention: deferred again');
    assert.ok(again, 'the busy ping goes back');
    assert.equal(again.queued, 2, 'beside the newer call of its author');

    turns.state.busy = false;
    await handler.drainPending();
    assert.deepEqual(
      turns.calls.map((c: Record<string, Untyped>) => c.trigger.id),
      ['m1', 'm1', 'm2'],
      'm1 tried, then answered, then the newer m2'
    );
    assert.equal(tagHistory.hits, 2, 'm2 is a separate call, decided on its own');
  });

  test('events: one busy result is one runTurn attempt per drain pass (no tight loop)', async () => {
    const turns = pauseRaceTurns();
    const sleep = async () => {
      turns.state.busy = true; // another turn starts during every pause and never ends here
    };
    const handler = makeHandler({ turns, sleep, rng: () => 0.99 });

    const guild = fakeGuild();
    const channel = fakeChannelWithMessage('c1', guild, 'm1');
    await handler(directPingMessage({ guild, channel, placeId: 'c1' }));

    turns.state.busy = false;
    await handler.drainPending();
    assert.equal(turns.calls.length, 1);
    turns.state.busy = false;
    await handler.drainPending();
    assert.equal(turns.calls.length, 2, 'still queued, one attempt per pass');
  });

  test('events: a busy result when nothing is busy any more continues the same pass', async () => {
    let attempts = 0;
    const turns = fakeTurns({
      isBusy: () => false,
      isAnyBusy: () => false, // the blocking turn already ended by the time the drain looks
      runTurn: async () => {
        attempts += 1;
        return { outcome: attempts === 1 ? 'busy' : 'spoke' };
      },
    });
    const handler = makeHandler({ turns, sleep: async () => {}, rng: scripted([0.5, 0.99, 0.5]) });

    const guild = fakeGuild();
    const channel = fakeChannelWithMessage('c1', guild, 'm1');
    // Queue it: busy elsewhere on arrival.
    turns.isAnyBusy = () => true;
    await handler(directPingMessage({ guild, channel, placeId: 'c1' }));
    turns.isAnyBusy = () => false;

    await handler.drainPending();
    assert.equal(attempts, 2, 'retried in the same pass, answered');
  });

  test('events: an onIdle drain arriving while the busy drain is still finishing does not strand the re-queued ping', async () => {
    const state = { busy: false };
    const calls = [];
    let handler: Untyped = null;
    let idleDrain = null;
    const turns = fakeTurns({
      isBusy: () => false,
      isAnyBusy: () => state.busy,
      runTurn: async (args: Record<string, Untyped>) => {
        calls.push(args);
        if (calls.length === 1) {
          // The blocking turn ends right away and fires onIdle before the drain sees the result.
          Promise.resolve().then(() => {
            state.busy = false;
            idleDrain = handler.drainPending();
          });
          return { outcome: 'busy' };
        }
        return { outcome: 'spoke' };
      },
    });
    handler = makeHandler({ turns, sleep: async () => {}, rng: scripted([0.5, 0.99, 0.5]) });

    const guild = fakeGuild();
    const channel = fakeChannelWithMessage('c1', guild, 'm1');
    state.busy = true;
    await handler(directPingMessage({ guild, channel, placeId: 'c1' }));
    state.busy = true; // still busy while the drain's turn is refused

    await handler.drainPending();
    await idleDrain;
    assert.equal(calls.length, 2, 'the re-queued ping was answered');
  });
});

describe('events of the pipeline', () => {
  let stopOwners: Array<() => void> = [];
  before(() => {
    useIface('fake');
    useSelf('self1');
    stopOwners = [ownedBy(['owner1'])];
  });
  after(() => {
    useIface('discord');
    useSelf('self-id');
    for (const stop of stopOwners) stop();
  });

  test('private: a drained DM whose turn finds another one running is re-queued and answered on the next drain', async () => {
    const state = { busy: true };
    const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => state.busy });
    const runOriginal = turns.runTurn;
    turns.runTurn = async (args: Record<string, Untyped>) =>
      state.busy ? (turns.calls.push(args), { outcome: 'busy' }) : runOriginal(args);
    const store = fakePrivateStore();
    const channel = fakeDmChannel();
    let pauses = 0;
    const sleep = async () => {
      pauses += 1;
      if (pauses === 1) state.busy = true;
    };
    const handler = makeDmHandler(wrongly({ turns, store, sleep, rng: () => 0 }));

    await handler(fakeDmMessage({ channel }));
    await settle();
    state.busy = false;
    const { logs } = await withCapturedLogs(() => handler.drainPending());
    assert.equal(turns.calls.length, 1);
    const again = logs.find((l) => l.msg === 'mention: deferred again' && l.reason === 'busy');
    assert.ok(again);
    assert.equal(again.kind, 'private');
    assert.equal(again.channel, 'dm1');

    state.busy = false;
    await handler.drainPending();
    assert.equal(turns.calls.length, 2);
    const secondCall = turns.calls[1];
    assert.equal(secondCall.trigger.id, 'dm-m1');
    assert.equal('placeId' in turns.calls[1], false);
  });

  test('events: drainPending does nothing while paused; the queued ping waits for the pause to end', async () => {
    let busy = true;
    const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
    const store = fakeStateStore();
    const handler = makeHandler({ turns, store, sleep: async () => {}, rng: scripted([0.5, 0.99]) });
    const guild = fakeGuild();
    const channel = fakeChannelWithMessage('c1', guild, 'm1');
    await handler(directPingMessage({ guild, channel, placeId: 'c1' }));

    const { data } = store.state;
    data.paused = true;
    busy = false;
    await handler.drainPending();
    assert.equal(turns.calls.length, 0, 'paused: nothing is picked up');

    const { data: dataValue } = store.state;
    dataValue.paused = false;
    await handler.drainPending();
    assert.equal(turns.calls.length, 1, 'the ping was never popped');
  });

  test('events: a pause landing during the switch pause stops the drain before the turn', async () => {
    let busy = true;
    const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
    const store = fakeStateStore();
    const sleep = async () => {
      const { data } = store.state;
      data.paused = true;
    };
    const handler = makeHandler({ turns, store, sleep, rng: scripted([0.5, 0.99]) });
    const guild = fakeGuild();
    const channel = fakeChannelWithMessage('c1', guild, 'm1');
    await handler(directPingMessage({ guild, channel, placeId: 'c1' }));

    busy = false;
    await handler.drainPending();
    assert.equal(turns.calls.length, 0);
  });

  test('private: a pause landing during the switch pause drops the drained DM: no turn, no notice', async () => {
    let busy = true;
    const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
    const privates = {};
    const store: Record<string, Untyped> = fakePrivateStore({ privates });
    const channel = fakeDmChannel();
    const sleep = async () => {
      const { data } = store.state;
      data.paused = true;
    };
    const handler = makeDmHandler(wrongly({ turns, store, sleep }));
    await handler(fakeDmMessage({ channel }));
    await settle();

    busy = false;
    await handler.drainPending();

    assert.equal(turns.calls.length, 0);
    assert.deepEqual(noticesOf(handler, channel.id), []);
  });
});

// The private gate and the pending queue with no root question in them (src/pipeline/private-gate.ts, drain.ts). A DM
// is checked by its author on its interface, and a queued DM runs in the chat it came from.
// Contract, plan 2026-11-04-cli-and-memory task 5:
//   createDrain's `checkPrivateGate(config, authorId, iface)`, `afterPrivateTurn(channel, trigger, result)`; no `getRootId`,
//   no `dmRootOf`
//   createPrivateGate returns `{ afterPrivateTurn, checkPrivateGate, dropPrivate, onPrivateMessage }`
// Appendix entries: src/pipeline/drain.ts, src/pipeline/private-gate.ts, src/pipeline/types.ts.

const PIPELINE_PRIVATE_NO_ROOT_NOW = Date.parse('2026-11-05T12:00:00Z');
const PIPELINE_PRIVATE_NO_ROOT_CONFIG = {
  bot: { timezone: 'UTC' },
  mention: { neverIgnore: [], repeatWindowMinutes: 0, pendingMinutes: 10 },
  dm: { enabled: true },
};

type PipelinePrivateNoRootTurnAsked = Parameters<PipelineTurns['runTurn']>[0];

async function pipelinePrivateNoRootDrainDm(): Promise<{
  turns: Array<PipelinePrivateNoRootTurnAsked>;
  gates: Array<Array<unknown>>;
  after: number;
}> {
  const channel = channelInfo('d1', { iface: 'fake', kind: 'dm', rootId: null, partnerId: 'u1' });
  const pending: PendingQueue = {
    list: [
      {
        channel,
        placeId: channel.id,
        kind: 'private',
        arrivedAt: PIPELINE_PRIVATE_NO_ROOT_NOW,
        trigger: {
          id: 'm1',
          placeId: channel.id,
          authorId: 'u1',
          content: 'hello',
          ts: PIPELINE_PRIVATE_NO_ROOT_NOW,
          replyToId: null,
          mentionedAccountIds: [],
        },
      },
    ],
  };
  const seen = { turns: [] as Array<PipelinePrivateNoRootTurnAsked>, gates: [] as Array<Array<unknown>>, after: 0 };
  const turns: PipelineTurns = {
    isBusy: () => false,
    isAnyBusy: () => false,
    spokeAfterSeeing: () => false,
    notePost() {},
    runTurn: (request) => {
      seen.turns.push(request);
      return Promise.resolve({ outcome: 'spoke' });
    },
  };
  const context = {
    hot: { config: PIPELINE_PRIVATE_NO_ROOT_CONFIG },
    store: { state: { data: {} } },
    now: () => PIPELINE_PRIVATE_NO_ROOT_NOW,
    rng: () => 0,
    sleep: () => Promise.resolve(),
    turns,
    pending,
    logPending() {},
    noteUnanswered() {},
    queuedCount: () => 0,
    queuedFor: () => () => [],
    requeueBusy: () => false,
    currentOf: (current: typeof channel) => Promise.resolve(current),
    refOf: (current: typeof channel) => ({ iface: current.iface, chatId: current.id }),
    routeOf: () => Promise.resolve({ destination: null }),
    heldCallState: () => Promise.resolve(true as const),
    skipSeenCalls() {},
    afterCallTurn: () => Promise.resolve(),
    passRoutedCall() {},
    checkPrivateGate: (...args: Array<unknown>) => {
      seen.gates.push(args);
      return Promise.resolve({ gate: { ok: true }, isOwner: false });
    },
    dropPrivate() {},
    afterPrivateTurn: () => {
      seen.after += 1;
      return Promise.resolve();
    },
    followUpStale: () => null,
    decideAndLog: () => ({ respond: true, reason: 'fixture', ignoreChance: 0 }),
  };
  await createDrain(wrongly<Parameters<typeof createDrain>[0]>(context)).drainPending();
  return seen;
}

test('a queued DM asks the gate about its author on its interface and asks no root', async () => {
  // Bug: `dmRootOf` is called at drain time, and a queued DM borrows the root the gate answers then.
  const { gates } = await pipelinePrivateNoRootDrainDm();
  assert.deepEqual(gates, [[PIPELINE_PRIVATE_NO_ROOT_CONFIG, 'u1', 'fake']]);
});

test('a queued DM opens a turn with its chat and no root field', async () => {
  // Bug: a request that carries `rootId` makes the turn keep the DM under that root.
  const { turns, after } = await pipelinePrivateNoRootDrainDm();
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0]?.chat, { iface: 'fake', chatId: 'd1' });
  assert.equal('rootId' in (turns[0] ?? {}), false);
  assert.equal('rootPlaceId' in (turns[0] ?? {}), false);
  assert.equal(after, 1);
});
