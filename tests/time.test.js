// Tests for src/time.js: the UTC day key and the per-day counter shared by
// the state.json rails. Pure, no I/O, no real clock. The time units are
// exercised by every module that computes with them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utcDay, dailyCounter, bumpDaily, countToday, zonedEpoch, zonedDay } from '../src/time.js';

const KEYS = { dayKey: 'fooDay', countKey: 'fooCount' };
const NOON = Date.UTC(2026, 8, 21, 12, 0, 0); // 2026-09-21T12:00:00Z

test('utcDay: the UTC date key of an epoch ms', () => {
  assert.equal(utcDay(NOON), '2026-09-21');
  assert.equal(utcDay(0), '1970-01-01');
});

test('utcDay: the day turns at UTC midnight, not local midnight', () => {
  const midnight = Date.UTC(2026, 8, 22, 0, 0, 0);
  assert.equal(utcDay(midnight - 1), '2026-09-21');
  assert.equal(utcDay(midnight), '2026-09-22');
});

test('dailyCounter: a fresh state starts the day at zero', () => {
  const state = {};
  assert.deepEqual(dailyCounter(state, KEYS, NOON), { day: '2026-09-21', count: 0, rolled: true });
  assert.deepEqual(state, { fooDay: '2026-09-21', fooCount: 0 });
});

test('dailyCounter: the same day keeps the count and does not roll', () => {
  const state = { fooDay: '2026-09-21', fooCount: 7 };
  assert.deepEqual(dailyCounter(state, KEYS, NOON), { day: '2026-09-21', count: 7, rolled: false });
  assert.deepEqual(state, { fooDay: '2026-09-21', fooCount: 7 });
});

test('dailyCounter: a new day resets the count to zero', () => {
  const state = { fooDay: '2026-09-20', fooCount: 7, other: 1 };
  assert.deepEqual(dailyCounter(state, KEYS, NOON), { day: '2026-09-21', count: 0, rolled: true });
  assert.deepEqual(state, { fooDay: '2026-09-21', fooCount: 0, other: 1 });
});

test('dailyCounter: a missing or invalid count on the same day reads as zero', () => {
  for (const bad of [undefined, null, 'x', NaN, -3]) {
    const state = { fooDay: '2026-09-21', fooCount: bad };
    assert.equal(dailyCounter(state, KEYS, NOON).count, 0, `count ${String(bad)}`);
  }
});

test('bumpDaily: adds one by default and returns the new count', () => {
  const state = { fooDay: '2026-09-21', fooCount: 2 };
  assert.deepEqual(bumpDaily(state, KEYS, NOON), { day: '2026-09-21', count: 3 });
  assert.equal(state.fooCount, 3);
});

test('bumpDaily: adds `by` and rolls a stale day over first', () => {
  const state = { fooDay: '2026-09-20', fooCount: 50 };
  assert.deepEqual(bumpDaily(state, KEYS, NOON, 5), { day: '2026-09-21', count: 5 });
  assert.deepEqual(state, { fooDay: '2026-09-21', fooCount: 5 });
});

test('countToday: the count stored for today, read without writing', () => {
  const state = { fooDay: '2026-09-21', fooCount: 7, other: 1 };
  assert.equal(countToday(state, KEYS, NOON), 7);
  assert.deepEqual(state, { fooDay: '2026-09-21', fooCount: 7, other: 1 });
});

test("countToday: 0 for yesterday's stamp, and the stale pair is left as it was", () => {
  const state = { fooDay: '2026-09-20', fooCount: 7 };
  assert.equal(countToday(state, KEYS, NOON), 0);
  assert.deepEqual(state, { fooDay: '2026-09-20', fooCount: 7 }, 'only dailyCounter rolls the pair over');
  const fresh = {};
  assert.equal(countToday(fresh, KEYS, NOON), 0);
  assert.deepEqual(fresh, {}, 'a fresh state gets no stamp from a read');
});

test("countToday: a count that is not a finite number >= 0 reads as zero, by dailyCounter's rule", () => {
  for (const bad of [undefined, null, 'x', '7', NaN, Infinity, -3, {}]) {
    const state = { fooDay: '2026-09-21', fooCount: bad };
    assert.equal(countToday(state, KEYS, NOON), 0, `count ${String(bad)}`);
    assert.equal(
      countToday(state, KEYS, NOON),
      dailyCounter({ ...state }, KEYS, NOON).count,
      `same as dailyCounter for ${String(bad)}`
    );
  }
});

test('countToday: a caller that already holds the UTC day key passes it instead of the clock', () => {
  const state = { fooDay: '2026-09-21', fooCount: 7 };
  assert.equal(countToday(state, KEYS, '2026-09-21'), 7);
  assert.equal(countToday(state, KEYS, utcDay(NOON)), countToday(state, KEYS, NOON));
  assert.equal(countToday(state, KEYS, '2026-09-22'), 0);
});

test('zonedEpoch: a wall time in UTC and in a fixed-offset zone', () => {
  assert.equal(zonedEpoch('2026-09-21', 12, 0, 'UTC'), NOON);
  assert.equal(zonedEpoch('2026-09-21', 12, 0), NOON, 'no zone reads as UTC');
  assert.equal(zonedEpoch('2026-09-21', 15, 30, 'Asia/Kolkata'), Date.UTC(2026, 8, 21, 10, 0));
});

test('zonedEpoch: local midnight on both sides of a spring-forward change', () => {
  // Europe/Berlin moves from +01:00 to +02:00 at 01:00 UTC on 2026-03-29: that day lasts 23 hours.
  const start = zonedEpoch('2026-03-29', 0, 0, 'Europe/Berlin');
  const next = zonedEpoch('2026-03-30', 0, 0, 'Europe/Berlin');
  assert.equal(start, Date.UTC(2026, 2, 28, 23, 0));
  assert.equal(next, Date.UTC(2026, 2, 29, 22, 0));
  assert.equal(next - start, 23 * 3600_000);
  assert.equal(zonedEpoch('2026-03-29', 12, 0, 'Europe/Berlin'), Date.UTC(2026, 2, 29, 10, 0));
});

test('zonedEpoch: a fall-back day lasts 25 hours', () => {
  const start = zonedEpoch('2026-10-25', 0, 0, 'Europe/Berlin');
  const next = zonedEpoch('2026-10-26', 0, 0, 'Europe/Berlin');
  assert.equal(start, Date.UTC(2026, 9, 24, 22, 0));
  assert.equal(next - start, 25 * 3600_000);
});

test('zonedEpoch: a date, an hour or a zone that does not exist gives NaN', () => {
  for (const [day, hour, minute, zone] of [
    ['2026-02-30', 0, 0, 'UTC'],
    ['2026-9-21', 0, 0, 'UTC'],
    ['yesterday', 0, 0, 'UTC'],
    ['2026-09-21', 24, 0, 'UTC'],
    ['2026-09-21', 10, 60, 'UTC'],
    ['2026-09-21', 1.5, 0, 'UTC'],
    ['2026-09-21', 10, 0, 'Not/AZone'],
  ]) {
    assert.ok(Number.isNaN(zonedEpoch(day, hour, minute, zone)), `${day} ${hour}:${minute} ${zone}`);
  }
});

test('zonedDay: the local date key of an instant', () => {
  const late = Date.UTC(2026, 8, 21, 23, 30);
  assert.equal(zonedDay(late, 'UTC'), '2026-09-21');
  assert.equal(zonedDay(late, 'Europe/Berlin'), '2026-09-22');
  assert.equal(zonedDay(late, 'America/New_York'), '2026-09-21');
  assert.equal(zonedDay(late), '2026-09-21', 'no zone reads as UTC');
});
