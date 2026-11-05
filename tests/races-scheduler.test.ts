// New reproduction, written from the timer-race risk the plan describes; the original scenario was not found. A wait
// ends in a `scheduler.tick` event through the door, and the door's handler calls `dispatch` later. A stop that lands
// between the two must win. The clock and the timer are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../src/behavior/scheduler.ts';

const T0 = Date.UTC(2026, 10, 5, 9, 0, 0);
const SECOND = 1000;
const QUIET = { info() {}, warn() {}, error() {} };

test('new reproduction: a tick already at the door starts no beat once the scheduler stopped', async () => {
  // Bug: the core stops, its memory closes, and the tick that was queued at the door runs every due beat against it.
  let now = T0;
  let fire: (() => void) | null = null;
  let finishTick: (() => void) | null = null;
  const ticks: Array<number> = [];
  const scheduler = createScheduler({
    submit: (event) => {
      ticks.push(event.at);
      return new Promise<void>((resolve) => {
        finishTick = resolve;
      });
    },
    now: () => now,
    setTimer: (fn) => {
      fire = fn;
      return () => {
        fire = null;
      };
    },
    log: QUIET,
  });
  const ran: Array<number> = [];
  scheduler.add({ name: 'beat', everyMs: () => 30 * SECOND, run: (at) => ran.push(at) });
  scheduler.start();
  now += 30 * SECOND;
  (fire as (() => void) | null)?.();
  assert.deepEqual(ticks, [now], 'the tick is at the door');
  scheduler.stop();
  assert.deepEqual(scheduler.dispatch(now).started, []);
  assert.deepEqual(ran, []);
  (finishTick as (() => void) | null)?.();
  await new Promise((resolve) => setImmediate(resolve));
});
