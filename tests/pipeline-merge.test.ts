import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMerge } from '../src/pipeline/merge.ts';
import { createPendingQueue } from '../src/pipeline/pending-queue.ts';
import type { Line, PendingQueue, PipelineTurns } from '../src/pipeline/types.ts';
import { issueContext } from '../src/memory/db/scope.ts';
import { channelInfo } from './fixtures/core-over-fake.ts';
import { labels } from './fixtures/labels.ts';
import { chainsOf } from './fixtures/chains.ts';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const channel = channelInfo('cli:dm:owner', { iface: 'cli', kind: 'dm', rootId: null, partnerId: 'owner' });
const line = (id: string): Line => ({
  id,
  placeId: channel.id,
  authorId: 'owner',
  authorName: 'Owner',
  content: `question ${id}`,
  ts: NOW,
  replyToId: null,
  mentionedAccountIds: [],
});

function setup(parts: Array<{ index: number; text: string }> = []) {
  const pending: PendingQueue = { list: [] };
  const folds: Array<unknown> = [];
  const classifications: Array<unknown> = [];
  const turns: PipelineTurns = {
    isBusy: () => true,
    isAnyBusy: () => true,
    runTurn: () => Promise.resolve({ outcome: 'busy' }),
    notePost() {},
    waitingParts: () => parts,
    addToPart: (...args) => {
      folds.push(args);
      return true;
    },
  };
  const config = {
    bot: { timezone: 'UTC' },
    mention: { neverIgnore: [], repeatWindowMinutes: 0, maxPending: 10 },
    models: { routes: chainsOf({ analyzer: 'test/analyzer' }) },
    llm: { maxRequestTokens: 50000, maxRequestsPerDay: 100, timeoutMs: 1000 },
  };
  const hot = { config, prompts: { labels, merge: 'Choose an item or new. {{items}} {{message}}' } };
  const queue = createPendingQueue({ hot, now: () => NOW, turns, missed: null, pending, followUpMuted: () => null });
  const merge = createMerge({
    hot,
    now: () => NOW,
    turns,
    store: { state: { data: {} } },
    pending,
    llm: {
      complete: (messages) => {
        classifications.push(messages);
        // The lead: split, merge and missed answer in strict JSON (owner, 2026-11-06).
        return Promise.resolve({ text: '{"item":1}' });
      },
    },
    getSelfName: () => 'Nova',
    itemText: queue.itemText,
    enqueuePending: queue.enqueuePending,
    turnBlocked: () => true,
    drainPending: async () => {},
  });
  return { ...merge, queue, pending, folds, classifications };
}

for (const privileged of ['waiting', 'incoming'] as const) {
  test(`a ${privileged} authenticated query cannot merge with a plain pending CLI-shaped call`, async () => {
    const rig = setup();
    const memoryContext = issueContext({ kind: 'internal', newId: () => 'ctx:queued-owner', now: () => NOW });
    const readOptions = { memoryContext };
    rig.queue.enqueuePending(
      channel,
      line('waiting'),
      'private',
      NOW,
      privileged === 'waiting' ? readOptions : undefined
    );
    rig.holdCall(channel, line('incoming'), 'private', privileged === 'incoming' ? readOptions : undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      rig.pending.list.map((ping) => ping.trigger.id),
      ['waiting', 'incoming']
    );
    assert.deepEqual(
      rig.pending.list.map((ping) => ping.added ?? []),
      [[], []]
    );
    assert.deepEqual(
      rig.pending.list.map((ping) => ping.readOptions?.memoryContext?.id ?? null),
      privileged === 'waiting' ? ['ctx:queued-owner', null] : [null, 'ctx:queued-owner']
    );
    assert.deepEqual(rig.classifications, []);
  });
}

test('an authenticated query cannot merge into an ordinary active chain', async () => {
  const rig = setup([{ index: 2, text: 'an ordinary part still waiting' }]);
  const memoryContext = issueContext({ kind: 'internal', newId: () => 'ctx:incoming-owner', now: () => NOW });
  rig.holdCall(channel, line('incoming'), 'private', { memoryContext });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(rig.folds, []);
  assert.deepEqual(
    rig.pending.list.map((ping) => ping.trigger.id),
    ['incoming']
  );
  assert.equal(rig.pending.list[0]?.readOptions?.memoryContext, memoryContext);
  assert.deepEqual(rig.classifications, []);
});

test('two ordinary calls still merge when the classifier chooses the waiting call', async () => {
  const rig = setup();
  rig.queue.enqueuePending(channel, line('waiting'), 'private');
  rig.holdCall(channel, line('incoming'), 'private');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    rig.pending.list.map((ping) => ping.trigger.id),
    ['waiting']
  );
  assert.deepEqual(rig.pending.list[0]?.added, [{ id: 'incoming', text: 'question incoming', ts: NOW }]);
  assert.equal(rig.classifications.length, 1);
});
