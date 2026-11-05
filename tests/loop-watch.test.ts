// The event loop watch (src/loop-watch.ts): a timer that measures its own lateness and logs one line when a tick is later
// than the threshold, naming the operations open at that tick and the ones that ended since the last tick. A synchronous
// operation that blocks the loop has ended by the time the late tick runs, so the ended list is what attributes it. Clock
// and timer are injected; the last tests run real timers over a really blocked loop. Names and numbers only in the log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_SCHEMA } from '../src/config/schema.ts';
import { createLoopWatch, loopStallMs } from '../src/loop-watch.ts';
import { settle, withFakeCore } from './fixtures/core-over-fake.ts';

const LINE = 'core: event loop stalled';
const T0 = 1_000_000;

type Fields = {
  stalledMs: number;
  open: Array<string>;
  ended: Array<{ name: string; count: number; ms: number }>;
};

/** A watch over a clock and a timer moved by hand. `late(ms)` runs a tick `ms` after it was due. */
function rig({ thresholdMs = 1000, sampleMs = 100 }: { thresholdMs?: number; sampleMs?: number } = {}) {
  let time = T0;
  let threshold = thresholdMs;
  let tick: () => void = () => assert.fail('the watch started no timer');
  let askedMs: number | null = null;
  let unrefs = 0;
  const timer = {
    unref: () => {
      unrefs += 1;
    },
  };
  const cleared: Array<unknown> = [];
  const lines: Array<{ message: string; fields: Fields }> = [];
  const watch = createLoopWatch({
    log: { warn: (message: string, fields: Fields) => lines.push({ message, fields }) },
    now: () => time,
    thresholdMs: () => threshold,
    sampleMs,
    setInterval: (fn: () => void, ms: number) => {
      tick = fn;
      askedMs = ms;
      return timer;
    },
    clearInterval: (given: typeof timer) => cleared.push(given),
  });
  return {
    watch,
    timer,
    lines,
    cleared,
    askedMs: () => askedMs,
    unrefs: () => unrefs,
    setThreshold: (ms: number) => {
      threshold = ms;
    },
    advance: (ms: number) => {
      time += ms;
    },
    late: (ms: number) => {
      time += sampleMs + ms;
      tick();
    },
  };
}

test('starts one unref timer at the sample interval', () => {
  const env = rig({ sampleMs: 250 });
  assert.equal(env.askedMs(), 250);
  assert.equal(env.unrefs(), 1);
});

test('logs nothing when a tick is on time', () => {
  const env = rig();
  env.late(0);
  assert.deepEqual(env.lines, []);
});

test('logs nothing when a tick is late by exactly the threshold', () => {
  const env = rig({ thresholdMs: 1000 });
  env.late(1000);
  assert.deepEqual(env.lines, []);
});

test('logs one line with the lateness when a tick is later than the threshold', () => {
  const env = rig({ thresholdMs: 1000 });
  env.late(1001);
  assert.deepEqual(env.lines, [{ message: LINE, fields: { stalledMs: 1001, open: [], ended: [] } }]);
});

test('measures the next tick from the late one, so one stall logs one line', () => {
  const env = rig({ thresholdMs: 1000 });
  env.late(5000);
  env.late(0);
  assert.equal(env.lines.length, 1);
});

test('logs nothing when the clock steps backward', () => {
  const env = rig({ thresholdMs: 1000 });
  env.advance(-60_000);
  env.late(0);
  assert.deepEqual(env.lines, []);
});

test('names an operation open at the late tick', () => {
  const env = rig();
  env.watch.track('recall.search', () => env.late(2000));
  assert.deepEqual(env.lines[0].fields.open, ['recall.search']);
});

test('names a synchronous operation that blocked the loop and ended before the late tick', () => {
  const env = rig();
  env.watch.track('recall.search', () => env.advance(11_700));
  env.late(11_700 - 100);
  const { open, ended } = env.lines[0].fields;
  assert.deepEqual(open, []);
  assert.deepEqual(ended, [{ name: 'recall.search', count: 1, ms: 11_700 }]);
});

test('sums the operations of one name and lists the longest name first', () => {
  const env = rig();
  env.watch.track('memory.read', () => env.advance(10));
  env.watch.track('session.batch', () => env.advance(500));
  env.watch.track('memory.read', () => env.advance(20));
  env.late(5000);
  assert.deepEqual(env.lines[0].fields.ended, [
    { name: 'session.batch', count: 1, ms: 500 },
    { name: 'memory.read', count: 2, ms: 30 },
  ]);
});

test('forgets an ended operation at the first tick after it, on time or late', () => {
  const env = rig();
  env.watch.track('early', () => env.advance(1));
  env.late(0);
  env.watch.track('during', () => env.advance(1));
  env.late(5000);
  env.late(5000);
  assert.deepEqual(env.lines[0].fields.ended, [{ name: 'during', count: 1, ms: 1 }]);
  assert.deepEqual(env.lines[1].fields.ended, []);
});

test('keeps an async operation open until it settles', async () => {
  const env = rig();
  let finish: (value: string) => void = () => assert.fail('the operation never started');
  const running = env.watch.track(
    'turn.request',
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      })
  );
  env.late(5000);
  finish('done');
  assert.equal(await running, 'done');
  env.late(5000);
  assert.deepEqual(env.lines[0].fields.open, ['turn.request']);
  assert.deepEqual(env.lines[1].fields.open, []);
  assert.equal(env.lines[1].fields.ended[0].name, 'turn.request');
});

test('closes an async operation that rejects and passes its error on', async () => {
  const env = rig();
  const failure = new Error('boom');
  await assert.rejects(
    env.watch.track('sweep', () => Promise.reject(failure)),
    (error) => error === failure
  );
  env.late(5000);
  assert.deepEqual(env.lines[0].fields.open, []);
});

test('closes a synchronous operation that throws and passes its error on', () => {
  const env = rig();
  const failure = new Error('boom');
  assert.throws(
    () =>
      env.watch.track('sweep', () => {
        throw failure;
      }),
    (error) => error === failure
  );
  env.late(5000);
  assert.deepEqual(env.lines[0].fields.open, []);
  assert.equal(env.lines[0].fields.ended[0].name, 'sweep');
});

test('answers a synchronous operation with its plain value', () => {
  const env = rig();
  assert.equal(
    env.watch.track('flush', () => 42),
    42
  );
});

test('lists a name once while two operations of it run, and keeps it open until both end', async () => {
  const env = rig();
  const finishers: Array<() => void> = [];
  const start = () =>
    env.watch.track(
      'recall.search',
      () =>
        new Promise<void>((resolve) => {
          finishers.push(resolve);
        })
    );
  const first = start();
  const second = start();
  env.late(5000);
  finishers[0]();
  await first;
  env.late(5000);
  finishers[1]();
  await second;
  env.late(5000);
  assert.deepEqual(env.lines[0].fields.open, ['recall.search']);
  assert.deepEqual(env.lines[1].fields.open, ['recall.search']);
  assert.deepEqual(env.lines[2].fields.open, []);
});

test('lists nested operations together, outermost first', () => {
  const env = rig();
  env.watch.track('turn.request', () => env.watch.track('memory.read', () => env.late(5000)));
  assert.deepEqual(env.lines[0].fields.open, ['turn.request', 'memory.read']);
});

test('never logs while the threshold is 0', () => {
  const env = rig({ thresholdMs: 0 });
  env.late(60_000);
  assert.deepEqual(env.lines, []);
});

test('reads the threshold at each tick, so a changed setting holds without a restart', () => {
  const env = rig({ thresholdMs: 0 });
  env.late(5000);
  env.setThreshold(1000);
  env.late(5000);
  env.setThreshold(0);
  env.late(5000);
  assert.equal(env.lines.length, 1);
});

test('stop clears its timer once, and a tick already due logs nothing', () => {
  const env = rig();
  env.watch.stop();
  env.watch.stop();
  env.late(5000);
  assert.deepEqual(env.cleared, [env.timer]);
  assert.deepEqual(env.lines, []);
});

test('track still runs the operation after stop', () => {
  const env = rig();
  env.watch.stop();
  assert.equal(
    env.watch.track('flush', () => 'ran'),
    'ran'
  );
});

test('the line holds no value or error of an operation', async () => {
  const env = rig();
  env.watch.track('flush', () => 'SECRET-VALUE');
  await env.watch.track('sweep', () => Promise.resolve('SECRET-VALUE'));
  await env.watch.track('turn.request', () => Promise.reject(new Error('SECRET-ERROR'))).catch(() => {});
  env.late(5000);
  assert.equal(env.lines.length, 1);
  const line = JSON.stringify(env.lines[0]);
  assert.equal(line.includes('SECRET'), false);
});

test('reads diagnostics.loopStallMs from the config, 0 included', () => {
  assert.equal(loopStallMs({ diagnostics: { loopStallMs: 250 } }), 250);
  assert.equal(loopStallMs({ diagnostics: { loopStallMs: 0 } }), 0);
});

test('falls back to the default of the schema when the setting is missing or no usable number', () => {
  const entry = CONFIG_SCHEMA.find((one) => one.key === 'diagnostics.loopStallMs');
  assert.deepEqual(entry?.types, ['number']);
  assert.equal(entry?.reader, 'src/loop-watch.ts');
  for (const config of [
    {},
    null,
    { diagnostics: {} },
    { diagnostics: { loopStallMs: -1 } },
    { diagnostics: { loopStallMs: 'x' } },
  ]) {
    assert.equal(loopStallMs(config), entry?.default);
  }
});

// ---------- real timers ----------

/** Blocks this thread, the way a synchronous read blocks the event loop. */
const blockLoop = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test('attributes a real blocked loop to the synchronous operation that blocked it', async () => {
  const lines: Array<{ message: string; fields: Fields }> = [];
  const watch = createLoopWatch({
    log: { warn: (message: string, fields: Fields) => lines.push({ message, fields }) },
    now: Date.now,
    thresholdMs: () => 200,
    sampleMs: 20,
    setInterval,
    clearInterval,
  });
  try {
    await settle(60);
    watch.track('recall.search', () => blockLoop(600));
    await settle(60);
  } finally {
    watch.stop();
  }
  const stalls = lines.filter((line) => line.message === LINE && line.fields.stalledMs >= 200);
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].fields.ended[0].name, 'recall.search');
});

test('the core logs a stalled loop when diagnostics.loopStallMs is set', async () => {
  const { logs } = await withFakeCore({ config: { diagnostics: { loopStallMs: 100 } } }, async () => {
    blockLoop(1500);
    await settle(1000);
  });
  const stalls = logs.filter((entry) => entry.msg === LINE);
  assert.ok(stalls.some((entry) => (entry.stalledMs as number) >= 100));
});

test('the core logs no stall when diagnostics.loopStallMs is 0', async () => {
  const { logs } = await withFakeCore({ config: { diagnostics: { loopStallMs: 0 } } }, async () => {
    blockLoop(1500);
    await settle(1000);
  });
  assert.deepEqual(
    logs.filter((entry) => entry.msg === LINE),
    []
  );
});
