// Tests for src/interface/typing.js: the typing lease is sent at once, refreshed on the caller's
// timer, stopped by its owner, and lapses on its own after its lease.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TYPING_LEASE_MS, startTypingLease } from '../src/interface/typing.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A manual clock and timer: `advance(ms)` moves the time and fires the pending timer once. */
function manual() {
  let time = 0;
  let pending = null;
  return {
    now: () => time,
    schedule: (fn, ms) => {
      const entry = { fn, ms };
      pending = entry;
      return () => { if (pending === entry) pending = null; };
    },
    advance(ms) {
      time += ms;
      const entry = pending;
      pending = null;
      entry?.fn();
    },
    hasPending: () => pending !== null,
  };
}

test('typing lease: sent now, again on every refresh, never after stop', async () => {
  const clock = manual();
  let sends = 0;
  const stop = startTypingLease({ send: () => { sends += 1; }, schedule: clock.schedule, refreshMs: 8000, now: clock.now });
  await flush();
  assert.equal(sends, 1);
  clock.advance(8000);
  clock.advance(8000);
  await flush();
  assert.equal(sends, 3);
  stop();
  assert.equal(clock.hasPending(), false, 'the refresh timer is cancelled');
  clock.advance(8000);
  await flush();
  assert.equal(sends, 3);
  stop();
});

test('typing lease: it lapses at its expiry, tells onExpire once, and arms no more timers', async () => {
  const clock = manual();
  let sends = 0;
  let expired = 0;
  const stop = startTypingLease({ send: () => { sends += 1; }, schedule: clock.schedule, refreshMs: 8000, now: clock.now, leaseMs: 20_000, onExpire: () => { expired += 1; } });
  clock.advance(8000);
  clock.advance(8000);
  await flush();
  assert.equal(sends, 3, 'sent at 0, 8000 and 16000');
  clock.advance(8000);
  await flush();
  assert.equal(sends, 3, 'at 24000 the lease is over: nothing is sent');
  assert.equal(expired, 1);
  assert.equal(clock.hasPending(), false);
  stop();
  assert.equal(expired, 1, 'a stop after the expiry changes nothing');
});

test('typing lease: a send that fails or throws never stops the refresh or escapes', async () => {
  const clock = manual();
  let sends = 0;
  startTypingLease({ send: async () => { sends += 1; throw new Error('nope'); }, schedule: clock.schedule, refreshMs: 1000, now: clock.now });
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 2);
  assert.ok(TYPING_LEASE_MS > 120_000, 'the default lease is past a turn\'s own bar');
});
