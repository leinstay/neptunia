// Her attention mirrored as leases (src/behavior/attention.ts): the turn runner's set takes `attention:*` (one turn at
// a time) while a turn runs and lets it go when the turn ends; a write that fails leaves
// the decision in process. A real in-memory memory database, the clock injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLeasedAttention } from '../src/behavior/attention.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyWakeQueueWrite, leaseOf } from '../src/memory/db/wake-queue.ts';

const T = Date.parse('2026-10-31T12:00:00.000Z');
const TTL = 300_000;

/** An attention over a fresh database; `settle()` waits for its writes. PR 7d: one turn at a time is code. */
function attentionOver() {
  const handle = openMemoryDb(':memory:');
  const memoryDb = { memoryWrite: (update: unknown) => Promise.resolve(applyWakeQueueWrite(handle, update)) };
  const hot = { config: { context: { turnLeaseMs: TTL } } };
  const warnings: Array<string> = [];
  const log = { warn: (message: string) => warnings.push(message) };
  const attention = createLeasedAttention({ memoryDb, hot, holder: 'core-a', now: () => T, log });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { handle, attention, warnings, settle };
}

test('a turn takes the one attention lease while it runs and lets it go when it ends', async () => {
  const { handle, attention, settle } = attentionOver();
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

test('a lease write that fails is logged and the set still holds the turn', async () => {
  const { handle, attention, warnings, settle } = attentionOver();
  handle.close();
  attention.add('c1');
  await settle();
  assert.equal(attention.has('c1'), true);
  assert.deepEqual(warnings, ['attention: lease write failed']);
  attention.delete('c1');
});
