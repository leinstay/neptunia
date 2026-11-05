import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrain } from '../src/pipeline/drain.ts';
import type { PendingQueue, PipelineTurns } from '../src/pipeline/types.ts';
import { issueContext } from '../src/memory/db/scope.ts';
import { channelInfo } from './fixtures/core-over-fake.ts';

const NOW = Date.parse('2026-10-24T12:00:00Z');

for (const privileged of [true, false]) {
  test(`${privileged ? 'an authenticated' : 'an ordinary'} queued call ${privileged ? 'runs' : 'is skipped'} after an ordinary turn saw its line`, async () => {
    const channel = channelInfo('cli:dm:owner', { iface: 'cli', kind: 'dm', communityId: null, partnerId: 'owner' });
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
            mentionedUserIds: [],
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
      private: { enabled: true },
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
      refOf: (current) => ({ iface: 'cli', conversationId: current.id }),
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
      assert.deepEqual(requests[0]?.conversation, { iface: 'cli', conversationId: 'cli:dm:owner' });
      assert.equal(requests[0]?.memoryContext, memoryContext);
    }
  });
}
