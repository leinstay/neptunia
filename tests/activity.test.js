// Tests for src/behavior/activity.js: the per-author last-message tracker and the settle wait
// a turn answering a person sits through before it reads the channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActivity, settleWait } from '../src/behavior/activity.js';

const T = Date.UTC(2026, 8, 20, 12, 0, 0);

test('settleWait: settle off (0, negative, non-number) never waits', () => {
  for (const settleMs of [0, -100, '4000', null, undefined, Number.NaN]) {
    assert.equal(
      settleWait({ now: T + 500, triggerAt: T, lastAt: T + 400, settleMs, settleMaxMs: 15000 }),
      0,
      String(settleMs)
    );
  }
});

test('settleWait: an author silent for longer than settleMs is not waited for', () => {
  assert.equal(settleWait({ now: T + 10000, triggerAt: T, lastAt: T, settleMs: 4000, settleMaxMs: 15000 }), 0);
});

test('settleWait: an author who wrote 1 s ago waits the rest of settleMs', () => {
  assert.equal(settleWait({ now: T + 6000, triggerAt: T, lastAt: T + 5000, settleMs: 4000, settleMaxMs: 15000 }), 3000);
});

test('settleWait: the wait never runs past settleMaxMs counted from triggerAt', () => {
  assert.equal(
    settleWait({ now: T + 13000, triggerAt: T, lastAt: T + 12500, settleMs: 4000, settleMaxMs: 15000 }),
    2000
  );
  assert.equal(settleWait({ now: T + 16000, triggerAt: T, lastAt: T + 15500, settleMs: 4000, settleMaxMs: 15000 }), 0);
});

test('settleWait: with no known last message the settle counts from triggerAt', () => {
  assert.equal(settleWait({ now: T + 1000, triggerAt: T, lastAt: null, settleMs: 4000, settleMaxMs: 15000 }), 3000);
});

test('settleWait: a cap that is off (0 or a non-number) allows one settle from triggerAt', () => {
  assert.equal(settleWait({ now: T + 3000, triggerAt: T, lastAt: T + 2500, settleMs: 4000, settleMaxMs: 0 }), 1000);
  assert.equal(settleWait({ now: T + 3000, triggerAt: T, lastAt: T + 2500, settleMs: 4000, settleMaxMs: null }), 1000);
});

test('settleWait: nothing known at all (no trigger time, no last message) waits nothing', () => {
  assert.equal(settleWait({ now: T, triggerAt: null, lastAt: null, settleMs: 4000, settleMaxMs: 15000 }), 0);
});

test('createActivity: lastAt is the latest note of that author in that channel, null when none', () => {
  const activity = createActivity();
  assert.equal(activity.lastAt('c1', 'u1'), null);
  activity.note('c1', 'u1', T);
  activity.note('c1', 'u1', T + 2000);
  activity.note('c1', 'u1', T + 1000); // an older message arriving late does not move it back
  activity.note('c2', 'u1', T + 9000);
  activity.note('c1', 'u2', T + 9000);
  assert.equal(activity.lastAt('c1', 'u1'), T + 2000);
  assert.equal(activity.lastAt('c2', 'u1'), T + 9000);
  assert.equal(activity.lastAt('c1', 'u3'), null);
});

test('createActivity: a note without a usable time, channel or author is ignored', () => {
  const activity = createActivity();
  activity.note('c1', 'u1', Number.NaN);
  activity.note('c1', 'u1', undefined);
  activity.note('', 'u1', T);
  activity.note('c1', null, T);
  assert.equal(activity.lastAt('c1', 'u1'), null);
  assert.equal(activity.size(), 0);
});

test('createActivity: prune drops entries older than maxAgeMs', () => {
  const activity = createActivity();
  activity.note('c1', 'u1', T);
  activity.note('c1', 'u2', T + 50000);
  activity.prune(T + 60001, 60000);
  assert.equal(activity.lastAt('c1', 'u1'), null);
  assert.equal(activity.lastAt('c1', 'u2'), T + 50000);
  assert.equal(activity.size(), 1);
});

test('createActivity: every note evicts entries older than ten minutes, so the map stays bounded', () => {
  const activity = createActivity();
  for (let i = 0; i < 100; i += 1) activity.note('c1', `u${i}`, T);
  activity.note('c2', 'late', T + 10 * 60 * 1000 + 1);
  assert.equal(activity.size(), 1);
  assert.equal(activity.lastAt('c2', 'late'), T + 10 * 60 * 1000 + 1);
});
