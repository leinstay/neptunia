// Her attention mirrored as leases (src/behavior/attention.ts): the turn runner's set takes `attention:*` (one turn at
// a time) or `attention:<conversation>` while a turn runs and lets it go when the turn ends; a write that fails leaves
// the decision in process. A real in-memory memory database, the clock injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLeasedAttention } from '../src/behavior/attention.ts';
import { openMemoryDb } from '../src/memory/db/open.js';
import { applyWakeQueueWrite, leaseOf } from '../src/memory/db/wake-queue.ts';

const T = Date.parse('2026-10-31T12:00:00.000Z');
const TTL = 300_000;

/** An attention over a fresh database, with `oneAtATime` as given; `settle()` waits for its writes. */
function attentionOver(oneAtATime: boolean) {
  const handle = openMemoryDb(':memory:');
  const memoryDb = { memoryWrite: (update: unknown) => Promise.resolve(applyWakeQueueWrite(handle, update)) };
  const hot = { config: { mention: { oneAtATime }, context: { turnLeaseMs: TTL } } };
  const warnings: Array<string> = [];
  const log = { warn: (message: string) => warnings.push(message) };
  const attention = createLeasedAttention({ memoryDb, hot, holder: 'core-a', now: () => T, log });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { handle, attention, warnings, settle };
}

test('a turn takes the one attention lease while it runs and lets it go when it ends', async () => {
  const { handle, attention, settle } = attentionOver(true);
  try {
    attention.add('c1');
    await settle();
    assert.equal(leaseOf(handle, 'attention:*')?.holder, 'core-a');
    assert.equal(leaseOf(handle, 'attention:*')?.expiresAt, T + TTL);
    attention.delete('c1');
    await settle();
    assert.equal(leaseOf(handle, 'attention:*')?.expiresAt, T, 'released: it expires now');
  } finally {
    handle.close();
  }
});

test('without one turn at a time the lease names the conversation', async () => {
  const { handle, attention, settle } = attentionOver(false);
  try {
    attention.add('c2');
    await settle();
    assert.equal(leaseOf(handle, 'attention:*'), null);
    assert.equal(leaseOf(handle, 'attention:c2')?.holder, 'core-a');
  } finally {
    attention.delete('c2');
    handle.close();
  }
});

test('a lease write that fails is logged and the set still holds the turn', async () => {
  const { handle, attention, warnings, settle } = attentionOver(true);
  handle.close();
  attention.add('c1');
  await settle();
  assert.equal(attention.has('c1'), true);
  assert.deepEqual(warnings, ['attention: lease write failed']);
  attention.delete('c1');
});
