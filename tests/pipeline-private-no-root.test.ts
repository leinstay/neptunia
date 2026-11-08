// The private gate and the pending queue with no root question in them (src/pipeline/private-gate.ts, drain.ts). A DM
// is checked by its author on its interface, and a queued DM runs in the chat it came from.
// Contract, plan 2026-11-04-cli-and-memory task 5:
//   createDrain's `checkPrivateGate(config, authorId, iface)`, `afterPrivateTurn(channel, trigger, result)`; no `getRootId`,
//   no `dmRootOf`
//   createPrivateGate returns `{ afterPrivateTurn, checkPrivateGate, dropPrivate, onPrivateMessage }`
// Appendix entries: src/pipeline/drain.ts, src/pipeline/private-gate.ts, src/pipeline/types.ts,
// src/behavior/core-pause.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeWhilePaused } from '../src/behavior/core-pause.ts';
import { createDrain } from '../src/pipeline/drain.ts';
import { createPrivateGate } from '../src/pipeline/private-gate.ts';
import type { PendingQueue, PipelineTurns } from '../src/pipeline/types.ts';
import { channelInfo } from './fixtures/core-over-fake.ts';
import { wrongly } from './fixtures/loose-types.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const CONFIG = {
  bot: { timezone: 'UTC' },
  mention: { neverIgnore: [], repeatWindowMinutes: 0, pendingMinutes: 10 },
  dm: { enabled: true },
};

type TurnAsked = Parameters<PipelineTurns['runTurn']>[0];

async function drainDm(): Promise<{ turns: Array<TurnAsked>; gates: Array<Array<unknown>>; after: number }> {
  const channel = channelInfo('d1', { iface: 'fake', kind: 'dm', rootId: null, partnerId: 'u1' });
  const pending: PendingQueue = {
    list: [
      {
        channel,
        placeId: channel.id,
        kind: 'private',
        arrivedAt: NOW,
        trigger: {
          id: 'm1',
          placeId: channel.id,
          authorId: 'u1',
          content: 'hello',
          ts: NOW,
          replyToId: null,
          mentionedAccountIds: [],
        },
      },
    ],
  };
  const seen = { turns: [] as Array<TurnAsked>, gates: [] as Array<Array<unknown>>, after: 0 };
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
    hot: { config: CONFIG },
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
  const { gates } = await drainDm();
  assert.deepEqual(gates, [[CONFIG, 'u1', 'fake']]);
});

test('a queued DM opens a turn with its chat and no root field', async () => {
  // Bug: a request that carries `rootId` makes the turn keep the DM under that root.
  const { turns, after } = await drainDm();
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0]?.chat, { iface: 'fake', chatId: 'd1' });
  assert.equal('rootId' in (turns[0] ?? {}), false);
  assert.equal('rootPlaceId' in (turns[0] ?? {}), false);
  assert.equal(after, 1);
});

test('the private gate offers no root question', () => {
  // Bug: `dmRootOf` survives beside the neutral path, so a caller reintroduces the owner's home-root fallback.
  const gate = createPrivateGate(
    wrongly<Parameters<typeof createPrivateGate>[0]>({
      hot: { config: { dm: { enabled: true } } },
      store: {},
    })
  );
  assert.equal('dmRootOf' in gate, false);
});

test('a paused line of a group is observed by its own chat with no home root reader', async () => {
  // Bug: the pause path needs `getRootId` to tell whether a line is served.
  const seen: Array<{ direct: boolean; where: object }> = [];
  const line = {
    kind: 'message.received',
    iface: 'other',
    chat: { id: 'c1', kind: 'channel', rootId: 'g3' },
    message: { id: 'm1', author: { id: 'u1', name: 'Eleni', self: false, bot: false } },
    addressing: { mentioned: false },
  };
  await observeWhilePaused(line, {
    hot: {},
    isServed: (id) => id === 'g3',
    selfIdOf: () => 'self',
    observeLine: (_event, direct, where) => {
      seen.push({ direct, where });
      return Promise.resolve();
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.direct, false);
  assert.equal('rootId' in (seen[0]?.where ?? {}), false);
});
