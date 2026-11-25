// The persona's attention mirrored as leases (src/behavior/attention.ts): the turn runner's set takes `attention:*` (one turn at
// a time) while a turn runs and lets it go when the turn ends; a write that fails leaves
// the decision in process. A real in-memory memory database, the clock injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLeasedAttention } from '../../../src/behavior/attention.ts';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { applyWakeQueueWrite, leaseOf } from '../../../src/memory/db/wake-queue.ts';

const T = Date.parse('2026-10-31T12:00:00.000Z');
const TTL = 300_000;

/** An attention over a fresh database; `settle()` waits for its writes. One turn at a time is code. */
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

// --- The service lane --------------------------------------------------------------------------

test('a service turn holds a lease of its own name beside the chat lane, so another process sees both', async () => {
  const T = Date.parse('2026-10-31T12:00:00.000Z');
  const handle = openMemoryDb(':memory:');
  try {
    const memoryDb = { memoryWrite: (update: unknown) => Promise.resolve(applyWakeQueueWrite(handle, update)) };
    const hot = { config: { context: { turnLeaseMs: 300_000 } } };
    const options = { memoryDb, hot, holder: 'core-a', now: () => T, log: { warn() {} } };
    const attention = {
      chat: createLeasedAttention({ ...options, lane: 'chat' }),
      service: createLeasedAttention({ ...options, lane: 'service' }),
    };
    attention.chat.add('c1');
    attention.service.add('persona');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(leaseOf(handle, 'attention:*')?.expiresAt, T + 300_000);
    assert.equal(leaseOf(handle, 'attention:service')?.expiresAt, T + 300_000);
    attention.service.delete('persona');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(leaseOf(handle, 'attention:service')?.expiresAt, T, 'the service lease is released');
    assert.equal(leaseOf(handle, 'attention:*')?.expiresAt, T + 300_000, 'the chat lease stays');
    attention.chat.delete('c1');
  } finally {
    handle.close();
  }
});
