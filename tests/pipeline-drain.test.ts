import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrain } from '../src/pipeline/drain.ts';
import type { PendingQueue, PipelineTurns } from '../src/pipeline/types.ts';
import { issueContext } from '../src/memory/db/scope.ts';
import { channelInfo } from './fixtures/core-over-fake.ts';

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
  // The third test of this file asked for the root of `dmRootOf`, which the owner's decision removed: a
  // private chat is its own place, whichever servers its interface holds.
  const { turns, gates } = await drainDm('other', 'home-of-first');
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.placeId ?? null, null);
  assert.equal(gates[0]?.iface, 'other');
});
