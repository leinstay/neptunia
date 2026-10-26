// Tests for the scheduler of the core's behaviours (src/behavior/scheduler.ts): one timer waits for the earliest
// beat, each wait ends in a `scheduler.tick` event submitted through the door, and the door's handler starts the
// beats that are due. The clock and the timer are injected: a test advances time by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../src/behavior/scheduler.ts';
import type { Beat } from '../src/behavior/scheduler.ts';
import { createEventDoor } from '../src/interface/door.js';

type Entry = { at: number; fn: () => void; live: boolean; ms: number };
type Logged = { msg: string; meta: unknown };

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const SECOND = 1000;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

// A clock and a timer that fire in order of their due time when the test advances the clock.
function fakeTime() {
  let time = NOW;
  const entries: Array<Entry> = [];
  return {
    now: (): number => time,
    setTimer: (fn: () => void, ms: number): (() => void) => {
      const entry: Entry = { at: time + ms, fn, live: true, ms };
      entries.push(entry);
      return () => {
        entry.live = false;
      };
    },
    live: (): Array<Entry> => entries.filter((entry) => entry.live),
    async advance(ms: number): Promise<void> {
      const target = time + ms;
      // A scheduler that re-arms at once without moving time would spin here forever: stop it with an error.
      for (let fired = 0; ; fired += 1) {
        if (fired > 500) throw new Error('the timer fires without time passing');
        const next = entries.filter((entry) => entry.live && entry.at <= target).sort((a, b) => a.at - b.at)[0];
        if (next === undefined) break;
        next.live = false;
        time = Math.max(time, next.at);
        next.fn();
        await settle();
      }
      time = target;
    },
  };
}

function recorder() {
  const warns: Array<Logged> = [];
  return {
    warns,
    log: {
      info(): void {},
      warn(msg: string, meta?: unknown): void {
        warns.push({ msg, meta });
      },
      error(msg: string, meta?: unknown): void {
        warns.push({ msg, meta });
      },
    },
  };
}

// A beat that records the `at` of each run.
function beat(name: string, everyMs: () => number, runs: Array<number>): Beat {
  return {
    name,
    everyMs,
    run: (at) => {
      runs.push(at);
    },
  };
}

type Submit = Parameters<typeof createScheduler>[0]['submit'];

// A scheduler whose ticks go straight to its own dispatch, as the door's handler sends them.
function wired(options: { submit?: Submit } = {}) {
  const time = fakeTime();
  const { log, warns } = recorder();
  const submitted: Array<number> = [];
  const holder: { dispatch: (at: number) => unknown } = { dispatch: () => undefined };
  const scheduler = createScheduler({
    submit:
      options.submit ??
      ((event) => {
        submitted.push(event.at);
        return Promise.resolve(holder.dispatch(event.at));
      }),
    now: time.now,
    setTimer: time.setTimer,
    log,
  });
  holder.dispatch = (at) => scheduler.dispatch(at);
  return { scheduler, time, warns, submitted };
}

test('runs a 30 s beat twice and a 60 s beat once after 60 s', async () => {
  const { scheduler, time } = wired();
  const fast: Array<number> = [];
  const slow: Array<number> = [];
  scheduler.add(beat('fast', () => 30 * SECOND, fast));
  scheduler.add(beat('slow', () => 60 * SECOND, slow));
  scheduler.start();
  await time.advance(60 * SECOND);
  assert.deepEqual(fast, [NOW + 30 * SECOND, NOW + 60 * SECOND]);
  assert.deepEqual(slow, [NOW + 60 * SECOND]);
  scheduler.stop();
});

test('keeps one timer armed for the earliest beat', () => {
  const { scheduler, time } = wired();
  scheduler.add(beat('slow', () => 60 * SECOND, []));
  scheduler.add(beat('fast', () => 30 * SECOND, []));
  scheduler.start();
  assert.equal(time.live().length, 1);
  assert.equal(time.live()[0]?.ms, 30 * SECOND);
  scheduler.stop();
});

test('submits each wait as a scheduler.tick event carrying the time it fired', async () => {
  const { scheduler, time, submitted } = wired();
  scheduler.add(beat('fast', () => 30 * SECOND, []));
  scheduler.start();
  await time.advance(30 * SECOND);
  assert.deepEqual(submitted, [NOW + 30 * SECOND]);
  scheduler.stop();
});

test('applies a changed interval from the next wait', async () => {
  const { scheduler, time } = wired();
  let interval = 30 * SECOND;
  const runs: Array<number> = [];
  scheduler.add(beat('moving', () => interval, runs));
  scheduler.start();
  await time.advance(30 * SECOND);
  // The wait after the first run is already armed at 30 s; the new interval starts with the one after it.
  interval = 10 * SECOND;
  await time.advance(50 * SECOND);
  assert.deepEqual(runs, [NOW + 30 * SECOND, NOW + 60 * SECOND, NOW + 70 * SECOND, NOW + 80 * SECOND]);
  scheduler.stop();
});

test('dispatch starts the beats due at that time and names them', () => {
  const { scheduler } = wired();
  scheduler.add(beat('fast', () => 30 * SECOND, []));
  scheduler.add(beat('slow', () => 60 * SECOND, []));
  scheduler.start();
  assert.deepEqual(scheduler.dispatch(NOW + 30 * SECOND).started, ['fast']);
  assert.deepEqual(scheduler.dispatch(NOW + 60 * SECOND).started, ['fast', 'slow']);
  scheduler.stop();
});

test('dispatch returns at once while a beat is still running', () => {
  const { scheduler } = wired();
  const never = new Promise<never>(() => {});
  const runs: Array<number> = [];
  scheduler.add({ name: 'slow', everyMs: () => 30 * SECOND, run: () => never });
  scheduler.add(beat('after', () => 30 * SECOND, runs));
  scheduler.start();
  assert.deepEqual(scheduler.dispatch(NOW + 30 * SECOND).started, ['slow', 'after']);
  assert.deepEqual(runs, [NOW + 30 * SECOND]);
  scheduler.stop();
});

test('logs a beat that throws and still runs the other beat of the tick', async () => {
  const { scheduler, time, warns } = wired();
  const runs: Array<number> = [];
  scheduler.add({
    name: 'broken',
    everyMs: () => 30 * SECOND,
    run: () => {
      throw new Error('boom');
    },
  });
  scheduler.add(beat('steady', () => 30 * SECOND, runs));
  scheduler.start();
  await time.advance(30 * SECOND);
  assert.deepEqual(runs, [NOW + 30 * SECOND]);
  assert.equal(warns.length, 1);
  assert.match(JSON.stringify(warns[0]), /broken/);
  scheduler.stop();
});

test('logs a beat whose promise rejects and keeps ticking', async () => {
  const { scheduler, time, warns } = wired();
  const runs: Array<number> = [];
  let failing = true;
  scheduler.add({
    name: 'async-broken',
    everyMs: () => 30 * SECOND,
    run: () => (failing ? Promise.reject(new Error('later')) : undefined),
  });
  scheduler.add(beat('steady', () => 30 * SECOND, runs));
  scheduler.start();
  await time.advance(30 * SECOND);
  assert.match(JSON.stringify(warns), /async-broken/);
  failing = false;
  await time.advance(30 * SECOND);
  assert.equal(runs.length, 2);
  scheduler.stop();
});

test('arms the next wait when a submitted tick is rejected', async () => {
  const runs: Array<number> = [];
  let attempts = 0;
  const { scheduler, time, warns } = wired({
    submit: () => {
      attempts += 1;
      return Promise.reject(new Error('door down'));
    },
  });
  scheduler.add(beat('fast', () => 30 * SECOND, runs));
  scheduler.start();
  await time.advance(90 * SECOND);
  assert.ok(attempts >= 2, `ticked ${attempts} times`);
  assert.ok(warns.length > 0);
  scheduler.stop();
});

test('runs the beats of a tick once when the door sees the same tick twice', async () => {
  const time = fakeTime();
  const { log } = recorder();
  const runs: Array<number> = [];
  const holder: { dispatch: (at: number) => unknown } = { dispatch: () => undefined };
  const door = createEventDoor({
    handlers: { 'scheduler.tick': (event: { at: number }) => holder.dispatch(event.at) },
    log,
  });
  const scheduler = createScheduler({
    submit: (event) => door.submit(event),
    now: time.now,
    setTimer: time.setTimer,
    log,
  });
  holder.dispatch = (at) => scheduler.dispatch(at);
  scheduler.add(beat('fast', () => 30 * SECOND, runs));
  scheduler.start();
  const tick = { kind: 'scheduler.tick' as const, at: NOW + 30 * SECOND };
  const first = await door.submit(tick);
  const second = await door.submit(tick);
  assert.equal(first.status, 'ok');
  assert.equal(second.status, 'duplicate');
  assert.deepEqual(runs, [NOW + 30 * SECOND]);
  scheduler.stop();
});

test('clears its timer on stop so no later tick runs a beat', async () => {
  const { scheduler, time } = wired();
  const runs: Array<number> = [];
  scheduler.add(beat('fast', () => 30 * SECOND, runs));
  scheduler.start();
  scheduler.stop();
  assert.equal(time.live().length, 0);
  await time.advance(120 * SECOND);
  assert.deepEqual(runs, []);
});
