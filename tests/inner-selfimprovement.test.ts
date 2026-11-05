// The `selfimprovement` wake (src/behavior/inner/selfimprovement.ts, the wake kind in src/behavior/inner/settings.ts):
// it falls due once a day at `selfimprovement.at` (tests/inner-selfimprovement-daily.test.ts), and with a cause when
// one chain shape fails three times in a day, once a day at most. Its turn carries the view's facts, and once its completion committed the outbox rows it showed
// are marked delivered. The pure rules first, then the inner life over a fake turn runner and a fake journal, with
// the clock injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInnerLife } from '../src/behavior/inner.ts';
import { INNER_DEFAULTS, WAKE_KINDS, innerSettings } from '../src/behavior/inner/settings.ts';
import { failureCause, selfimprovementWake } from '../src/behavior/inner/selfimprovement.ts';
import { shapesOf } from '../src/behavior/selfimprovement-view.ts';
import type { Chain } from '../src/behavior/selfimprovement-view.ts';
import { createEventDoor } from '../src/interface/door.ts';
import { createIntentionService } from '../src/intentions/service.ts';
import { createIntentionStores } from '../src/intentions/store.ts';
import { utcDay } from '../src/time.ts';
import { tempDir } from './fixtures/tmp.ts';
import { useIface, world } from './fixtures/turn-world.ts';

useIface('fake');
const GUILD = 'g1';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.parse('2026-11-01T12:00:00Z');
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const iso = (at: number): string => new Date(at).toISOString();

function chain(turnId: string, at: number, status: 'ok' | 'failed' = 'failed', tool = 'web.read'): Chain {
  return {
    turnId,
    at,
    costUsd: 0,
    calls: [{ tool, args: ['url'], status, code: status === 'failed' ? 'timeout' : null }],
  };
}

test('the wake kinds include selfimprovement and its settings default to 03:00 and three failures', () => {
  // Changed for spec 2026-11-02 "`selfimprovement` daily, after the watcher": the daily `at` replaces `everyDays`.
  // Changed: `selfimprovement.at` became the one setting `selfimprovement.schedule`, read in its parsed form.
  assert.ok((WAKE_KINDS as ReadonlyArray<string>).includes('selfimprovement'));
  assert.deepEqual(INNER_DEFAULTS.wakes.selfimprovement, {
    schedule: { kind: 'at', at: ['03:00'] },
    failuresPerShape: 3,
  });
  assert.deepEqual(innerSettings({}).wakes.selfimprovement, {
    schedule: { kind: 'at', at: ['03:00'] },
    failuresPerShape: 3,
  });
});

test('the settings take an HH:MM and a positive whole number from selfimprovement and the default for anything else', () => {
  // Changed for spec 2026-11-02 "`selfimprovement` daily, after the watcher": the daily `at` replaces `everyDays`.
  const set = innerSettings({ selfimprovement: { schedule: 'at 05:15', failuresPerShape: 5 } });
  assert.deepEqual(set.wakes.selfimprovement, { schedule: { kind: 'at', at: ['05:15'] }, failuresPerShape: 5 });
  const bad = innerSettings({ selfimprovement: { schedule: '5pm', failuresPerShape: 'x' } });
  assert.deepEqual(bad.wakes.selfimprovement, { schedule: { kind: 'at', at: ['03:00'] }, failuresPerShape: 3 });
});

test('a selfimprovement wake has its own chain, no place and an id by its time', () => {
  const wake = selfimprovementWake(START, 'weekly');
  assert.equal(wake.id, `inner.wake:selfimprovement:${START}`);
  assert.equal(wake.kind, 'selfimprovement');
  assert.equal(wake.reason, 'weekly');
  assert.equal(wake.chainId, `selfimprovement:${START}`);
  assert.equal(wake.placeId, null);
  assert.equal(wake.dueAt, START);
});

// Changed for spec 2026-11-02 "`selfimprovement` daily, after the watcher": the two tests of `weeklyWake` went with it; the daily
// wake's rule is tested in tests/inner-selfimprovement-daily.test.ts.

test('three failed chains of one shape in a day are a cause, naming the shape and the count', () => {
  const chains = [chain('f1', START - 3 * HOUR), chain('f2', START - 2 * HOUR), chain('f3', START - HOUR)];
  const cause = failureCause({ chains, now: START, threshold: 3, raisedAt: null });
  assert.equal(cause?.failures, 3);
  assert.equal(cause?.key, shapesOf(chains, { shown: 1 }).shapes[0]?.key);
});

test('two failures, failures spread over two shapes, failures that ended ok and no chain at all are no cause', () => {
  assert.equal(
    failureCause({
      chains: [chain('f1', START - HOUR), chain('f2', START - 2 * HOUR)],
      now: START,
      threshold: 3,
      raisedAt: null,
    }),
    null
  );
  const spread = [
    chain('a1', START - HOUR),
    chain('a2', START - 2 * HOUR),
    chain('b1', START - 3 * HOUR, 'failed', 'web.search'),
  ];
  assert.equal(failureCause({ chains: spread, now: START, threshold: 3, raisedAt: null }), null);
  const fine = [
    chain('o1', START - HOUR, 'ok'),
    chain('o2', START - 2 * HOUR, 'ok'),
    chain('o3', START - 3 * HOUR, 'ok'),
  ];
  assert.equal(failureCause({ chains: fine, now: START, threshold: 3, raisedAt: null }), null);
  assert.equal(failureCause({ chains: [], now: START, threshold: 3, raisedAt: null }), null);
});

test('failures of yesterday do not count today', () => {
  const day = utcDay(START);
  const yesterday = Date.parse(`${day}T00:00:00Z`) - HOUR;
  const chains = [chain('y1', yesterday), chain('y2', yesterday - HOUR), chain('t1', START - HOUR)];
  assert.equal(failureCause({ chains, now: START, threshold: 3, raisedAt: null }), null);
});

test('a cause already raised on the same day is not raised again, and one raised yesterday is', () => {
  const chains = [1, 2, 3, 4].map((n) => chain(`f${n}`, START - n * 600_000));
  assert.equal(failureCause({ chains, now: START, threshold: 3, raisedAt: START - 2 * HOUR }), null);
  assert.equal(failureCause({ chains, now: START, threshold: 3, raisedAt: START - DAY })?.failures, 4);
});

// ---- the inner life ----

type Record_ = Record<string, unknown>;
type Call = {
  inner: {
    wake: { kind: string; items: Array<{ reason: string }>; selfimprovement?: { shapes: Array<{ failures: number }> } };
  };
};

function failed(turnId: string, at: number): Array<Record_> {
  const base = { kind: 'action', name: 'skill', turnId, opId: `${turnId}-op`, scope: { channel: 'c1' } };
  return [
    { ...base, phase: 'started', occurredAt: iso(at), input: { skill: 'web.read', args: ['url'] } },
    { ...base, phase: 'failed', occurredAt: iso(at + 1000), result: { code: 'timeout' } },
  ];
}

function setup() {
  const clock = { t: START };
  world().channel({ id: 'c1', name: 'chan-c1', placeId: GUILD, permissions: { send: true } });
  const hot = {
    config: {
      bot: { timezone: 'UTC' },
      features: { wakes: true, intentions: true, journal: true },
      mention: { oneAtATime: true },
      wakes: {
        mode: 'shadow',
        tickSeconds: 60,
        queueMax: 20,
        chatMessages: 30,
        review: { enabled: false, historyDays: 14 },
        caps: { perChain: 3 },
      },
      heartbeat: { enabled: false },
      // Changed for spec 2026-11-02 "`selfimprovement` daily, after the watcher": the daily `at` replaces `everyDays`.
      selfimprovement: { schedule: { kind: 'at', at: ['03:00'] }, failuresPerShape: 3 },
    },
  };
  const service = createIntentionService({
    stores: createIntentionStores({ dataDir: tempDir('nep-selfimp-'), now: () => clock.t, log: SILENT }),
    hot,
    now: () => clock.t,
    log: SILENT,
  });
  const calls: Array<Call> = [];
  const turns = {
    isAnyBusy: () => false,
    runTurn: (params: Call) => {
      calls.push(params);
      return Promise.resolve({
        outcome: 'skip',
        reason: 'nothing-to-do',
        inner: { actions: [], turnId: `t-${calls.length}` },
      });
    },
  };
  const records: Array<Record_> = [];
  const journal = {
    inner: () => Promise.resolve(),
    read: (query: { day: string; kind: string }) =>
      records.filter((r) => r.kind === query.kind && utcDay(Date.parse(String(r.occurredAt))) === query.day),
  };
  const acked: Array<Array<number>> = [];
  let life: ReturnType<typeof createInnerLife> | null = null;
  const door = createEventDoor({ handlers: { 'inner.wake': (event: object) => life?.onWake(event) }, log: SILENT });
  life = createInnerLife({
    hot,
    dataDir: tempDir('nep-selfimp-inner-'),
    turns,
    intentions: service,
    journal,
    reads: world().reads,
    iface: () => 'fake',
    conversationName: (id: string) => `chan-${id}`,
    submit: (event: object) => door.submit(event),
    store: { state: { data: {} } },
    meter: { run: async (fn: () => unknown) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
    selfimprovement: {
      granted: () => ['web.read'],
      skills: () => [],
      proposals: () =>
        Promise.resolve({
          entries: [],
          outbox: [
            {
              seq: 5,
              task_id: 'T1',
              to_whom: 'persona:self',
              kind: 'done',
              payload: { status: 'done', close_reason: null },
              created_at: iso(START),
              delivered_at: null,
            },
          ],
        }),
      ackOutbox: (seqs: ReadonlyArray<number>) => {
        acked.push([...seqs]);
        return Promise.resolve();
      },
    },
    rng: () => 0.5,
    now: () => clock.t,
    log: SILENT,
  });
  return { clock, life, calls, records, acked };
}

// Changed for spec 2026-11-02 "`selfimprovement` daily, after the watcher": the first tick starts the daily clock.
test('the first tick starts the selfimprovement clock and raises nothing', async () => {
  const run = setup();
  const tick = await run.life.tick();
  assert.equal(tick.submitted, 0);
  assert.equal(run.life.state().selfimprovement?.lastAt, START);
  assert.equal(run.life.state().selfimprovement?.raisedAt, null);
});

test('three failures of one shape in a day raise one wake with its cause and the view, and a fourth raises no second that day', async () => {
  const run = setup();
  await run.life.tick();
  for (const n of [1, 2, 3]) run.records.push(...failed(`f${n}`, START - n * 600_000));
  run.clock.t = START + 60_000;
  const first = await run.life.tick();
  assert.equal(first.submitted, 1);
  assert.equal(run.calls.length, 1);
  const wake = run.calls[0]?.inner.wake;
  assert.equal(wake?.kind, 'selfimprovement');
  assert.match(String(wake?.items[0]?.reason), /^failures:/);
  assert.equal(wake?.selfimprovement?.shapes[0]?.failures, 3);

  run.records.push(...failed('f4', run.clock.t));
  run.clock.t += 10 * 60_000;
  assert.equal((await run.life.tick()).submitted, 0);
  assert.equal(run.calls.length, 1, 'one cause a day');
});

test('two failures of one shape raise nothing', async () => {
  const run = setup();
  await run.life.tick();
  for (const n of [1, 2]) run.records.push(...failed(`f${n}`, START - n * 600_000));
  run.clock.t = START + 60_000;
  assert.equal((await run.life.tick()).submitted, 0);
  assert.equal(run.calls.length, 0);
});

test('once the wake completed its time is the last one and the outbox rows it showed are marked delivered', async () => {
  const run = setup();
  await run.life.tick();
  for (const n of [1, 2, 3]) run.records.push(...failed(`f${n}`, START - n * 600_000));
  run.clock.t = START + 60_000;
  await run.life.tick();
  assert.deepEqual(run.acked, [[5]]);
  assert.equal(run.life.state().selfimprovement?.lastAt, START + 60_000);
  assert.equal(run.life.state().selfimprovement?.raisedAt, START + 60_000);
});
