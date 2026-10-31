// The wake queue, its fenced leases and the delivery records in the memory database (spec 2026-10-27-stage-4-cut,
// PR B, and the lead's decisions after the specifier; src/memory/db/wake-queue.ts). A wake is claimed in one
// transaction (queued to running, the lease `wake:<id>` granted with a new token) and completed in another that checks
// the token and records the turn's deliveries `queued` under their effect keys. Only the completion writes deliveries.
// After the commit a sender sends each queued one and marks it `sent`. The recovery of a start puts a running wake whose
// lease expired back to `queued` (or `slept`, under the sleep rule) and never marks it handled. A lease token rises with
// every grant, and a writer holding an older one is refused. A crash is a closed connection that opens the same file
// again. Synthetic data, a temporary data directory, the clock injected as `now`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.js';
import {
  acquireLease,
  claimWake,
  completeWake,
  deliveryOf,
  leaseOf,
  markDelivered,
  queueWake,
  queuedDeliveries,
  recoverWakes,
  renewLease,
  wakeOf,
} from '../src/memory/db/wake-queue.ts';
import { tempDir } from './fixtures/tmp.js';

const T = Date.parse('2026-10-31T12:00:00.000Z');
const MINUTE = 60_000;
const LEASE_MS = MINUTE;
const WAKE = {
  id: `inner.wake:intention_due:i1:${T - MINUTE}`,
  kind: 'intention_due',
  reason: 'due',
  intentionIds: ['i1'],
  chainId: 'intention:i1',
  dueAt: T - MINUTE,
  channelId: 'c1',
  privateChat: false,
};
// The effect keys of her turn: `<turnId>:<effectIndex>:<target>`.
const FIRST = 't-1:0:c1';
const SECOND = 't-1:1:c1';
const TEXT = { text: 'Καλημέρα' };

type Handle = ReturnType<typeof openMemoryDb>;

/** A database file that a test opens, closes as a crash would, and opens again. */
function databaseFile(): () => Handle {
  const file = path.join(tempDir('nep-wake-queue-'), 'memory.db');
  return () => openMemoryDb(file);
}

/** The token of a grant; a refusal fails the test with its code. */
function tokenOf(grant: { ok: boolean; token?: number; code?: string }): number {
  if (!grant.ok || typeof grant.token !== 'number') throw new Error(`refused: ${String(grant.code)}`);
  return grant.token;
}

/** One start's sender: every `queued` delivery sent and marked `sent`, in the order the store lists them; the keys sent. */
function sendQueued(handle: Handle, now: number): Array<string> {
  const sent: Array<string> = [];
  for (const delivery of queuedDeliveries(handle)) {
    sent.push(delivery.key);
    markDelivered(handle, { key: delivery.key, now });
  }
  return sent;
}

/** A queued wake claimed by `holder` at `now`: its token. */
function queuedAndClaimed(handle: Handle, holder: string, now: number): number {
  assert.deepEqual(queueWake(handle, { wake: WAKE, now: now - MINUTE }), { status: 'queued' });
  return tokenOf(claimWake(handle, { id: WAKE.id, holder, now, leaseMs: LEASE_MS }));
}

test('a wake cut off between its claim and its completion is queued again, and its rerun records and sends each effect once', () => {
  const open = databaseFile();
  const before = open();
  let first: number;
  try {
    first = queuedAndClaimed(before, 'core-1', T);
    // The process dies inside the turn: no completion, so no delivery was recorded.
  } finally {
    before.close();
  }
  const after = open();
  try {
    const at = T + 10 * MINUTE;
    assert.deepEqual(
      recoverWakes(after, { now: at }),
      { requeued: 1, slept: 0 },
      'never handled for want of a delivery'
    );
    assert.equal(wakeOf(after, WAKE.id)?.state, 'queued');
    const second = tokenOf(claimWake(after, { id: WAKE.id, holder: 'core-2', now: at, leaseMs: LEASE_MS }));
    assert.ok(second > first, 'the rerun holds a newer token');
    const deliveries = [FIRST, SECOND].map((key) => ({ key, target: 'c1', payload: TEXT }));
    assert.deepEqual(completeWake(after, { id: WAKE.id, token: second, outcome: 'spoke', now: at, deliveries }), {
      ok: true,
    });
    assert.equal(wakeOf(after, WAKE.id)?.state, 'handled');
    assert.deepEqual(sendQueued(after, at), [FIRST, SECOND]);
    assert.deepEqual(sendQueued(after, at + MINUTE), [], 'a sent effect never leaves again');
  } finally {
    after.close();
  }
});

test('recovery leaves alone a running wake whose lease has not expired', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const token = queuedAndClaimed(handle, 'core-1', T);
    assert.deepEqual(recoverWakes(handle, { now: T + LEASE_MS - 1 }), { requeued: 0, slept: 0 });
    const wake = wakeOf(handle, WAKE.id);
    assert.equal(wake?.state, 'running');
    assert.equal(wake?.leaseToken, token);
  } finally {
    handle.close();
  }
});

test('recovery leaves a completed wake handled, and its queued delivery cut off before the send is sent once by its key', () => {
  const open = databaseFile();
  const before = open();
  try {
    const token = queuedAndClaimed(before, 'core-1', T);
    const deliveries = [{ key: FIRST, target: 'c1', payload: TEXT }];
    assert.deepEqual(completeWake(before, { id: WAKE.id, token, outcome: 'spoke', now: T, deliveries }), { ok: true });
    // The process dies after the commit, before the send.
  } finally {
    before.close();
  }
  const sent: Array<string> = [];
  // Two starts in a row: each recovers, then sends what is still queued.
  for (const start of [T + 10 * MINUTE, T + 11 * MINUTE]) {
    const handle = open();
    try {
      assert.deepEqual(recoverWakes(handle, { now: start }), { requeued: 0, slept: 0 });
      assert.equal(wakeOf(handle, WAKE.id)?.state, 'handled');
      sent.push(...sendQueued(handle, start));
    } finally {
      handle.close();
    }
  }
  assert.deepEqual(sent, [FIRST]);
  const handle = open();
  try {
    assert.equal(deliveryOf(handle, FIRST)?.state, 'sent');
    assert.equal(deliveryOf(handle, FIRST)?.target, 'c1');
  } finally {
    handle.close();
  }
});

test("a stale holder's claim and completion are refused, and it has nothing to send", () => {
  const handle = openMemoryDb(':memory:');
  try {
    const stale = queuedAndClaimed(handle, 'core-1', T);
    assert.deepEqual(claimWake(handle, { id: WAKE.id, holder: 'core-2', now: T + 1, leaseMs: LEASE_MS }), {
      ok: false,
      code: 'not-queued',
    });
    const at = T + 2 * MINUTE;
    recoverWakes(handle, { now: at });
    const fresh = tokenOf(claimWake(handle, { id: WAKE.id, holder: 'core-2', now: at, leaseMs: LEASE_MS }));
    assert.deepEqual(
      completeWake(handle, {
        id: WAKE.id,
        token: stale,
        outcome: 'spoke',
        now: at,
        deliveries: [{ key: FIRST, target: 'c1', payload: TEXT }],
      }),
      { ok: false, code: 'stale-lease' }
    );
    assert.deepEqual(sendQueued(handle, at), [], 'nothing of the stale turn leaves');
    const wake = wakeOf(handle, WAKE.id);
    assert.equal(wake?.state, 'running');
    assert.equal(wake?.leaseHolder, 'core-2');
    assert.equal(wake?.leaseToken, fresh);
  } finally {
    handle.close();
  }
});

test('the attention lease is held while it is renewed, then taken over once it expires, and the old holder is refused', () => {
  const handle = openMemoryDb(':memory:');
  const ttlMs = 300_000;
  const name = 'attention:c1';
  try {
    const first = tokenOf(acquireLease(handle, { name, holder: 'turn-a', now: T, ttlMs }));
    assert.deepEqual(renewLease(handle, { name, token: first, now: T + 200_000, ttlMs }), { ok: true });
    assert.deepEqual(acquireLease(handle, { name, holder: 'turn-b', now: T + 400_000, ttlMs }), {
      ok: false,
      code: 'held',
    });
    const second = tokenOf(acquireLease(handle, { name, holder: 'turn-b', now: T + 500_001, ttlMs }));
    assert.ok(second > first, 'every grant raises the token');
    assert.deepEqual(renewLease(handle, { name, token: first, now: T + 500_002, ttlMs }), {
      ok: false,
      code: 'stale-lease',
    });
    const lease = leaseOf(handle, name);
    assert.equal(lease?.holder, 'turn-b');
    assert.equal(lease?.token, second);
    assert.equal(lease?.expiresAt, T + 500_001 + ttlMs);
  } finally {
    handle.close();
  }
});
