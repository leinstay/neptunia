// The daily selfimprovement wake (src/behavior/inner/selfimprovement.ts, spec 2026-11-02 "`selfimprovement` daily,
// after the watcher"): once a day at `selfimprovement.at` of the server clock (UTC), never twice a day, never before
// the hour. The pure rule first, then the
// inner life over a fake turn runner with the clock injected. Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInnerLife } from '../src/behavior/inner.ts';
import { innerSettings } from '../src/behavior/inner/settings.ts';
import { scheduledWake } from '../src/behavior/inner/selfimprovement.ts';
import { createEventDoor } from '../src/interface/door.ts';
import { createIntentionService } from '../src/intentions/service.ts';
import { createIntentionStores } from '../src/intentions/store.ts';
import { tempDir } from './fixtures/tmp.ts';
import { useIface, world } from './fixtures/turn-world.ts';

useIface('fake');
const ROOT = 'g1';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const at = (iso: string): number => Date.parse(iso);
const SLOT = at('2026-11-02T03:00:00Z');

// ---- the rule ----

test('the wake falls due at the hour of the day, its moment being that hour', () => {
  // Catches: the wake is timed by the tick that saw it, so two ticks of one day give two ids and two wakes.
  const wake = scheduledWake({ now: SLOT, schedule: { kind: 'at', at: ['03:00'] }, lastAt: SLOT - DAY });
  assert.equal(wake?.kind, 'selfimprovement');
  assert.equal(wake?.reason, 'daily');
  assert.equal(wake?.dueAt, SLOT);
});

test('before the hour no wake is due', () => {
  // Catches: the day is compared and not the hour, so the wake runs at midnight before the watcher wrote its report.
  assert.equal(
    scheduledWake({ now: SLOT - MINUTE, schedule: { kind: 'at', at: ['03:00'] }, lastAt: SLOT - DAY }),
    null
  );
});

test('once the day has had its wake no second one is due that day', () => {
  // Catches: the wake fires on every tick after the hour, sixty times an hour.
  assert.equal(scheduledWake({ now: SLOT + 5 * HOUR, schedule: { kind: 'at', at: ['03:00'] }, lastAt: SLOT }), null);
});

test('a wake missed at the hour is due later that day with the same moment', () => {
  // Catches: a core that was down at 03:00 skips the day, or the late wake gets an id of its own and the day has two.
  const late = scheduledWake({ now: SLOT + 12 * HOUR, schedule: { kind: 'at', at: ['03:00'] }, lastAt: SLOT - DAY });
  assert.equal(late?.dueAt, SLOT);
  assert.equal(late?.id, scheduledWake({ now: SLOT, schedule: { kind: 'at', at: ['03:00'] }, lastAt: SLOT - DAY })?.id);
});

test('the next day the wake is due again at the hour', () => {
  // Catches: lastAt is compared by the day it was set and not by the hour, so a wake at 23:00 blocks the next morning.
  assert.equal(
    scheduledWake({ now: SLOT + DAY, schedule: { kind: 'at', at: ['03:00'] }, lastAt: SLOT })?.dueAt,
    SLOT + DAY
  );
});

test('the hour of the setting is the one used, not a fixed one', () => {
  // Catches: the hour is read once or hard-coded, so selfimprovement.at changes nothing.
  // A slot of yesterday missed before `lastAt` moved is no longer owed: downtime is sleep.
  const lastAt = SLOT - DAY;
  assert.equal(
    scheduledWake({ now: at('2026-11-02T05:44:00Z'), schedule: { kind: 'at', at: ['05:45'] }, lastAt }),
    null
  );
  assert.equal(
    scheduledWake({ now: at('2026-11-02T05:45:00Z'), schedule: { kind: 'at', at: ['05:45'] }, lastAt })?.dueAt,
    at('2026-11-02T05:45:00Z')
  );
});

test('with no wake moment known yet no wake is due', () => {
  // Catches: a fresh install without a stored clock throws or wakes at once.
  assert.equal(scheduledWake({ now: SLOT, schedule: { kind: 'at', at: ['03:00'] }, lastAt: null }), null);
});

test('the settings read the hour of selfimprovement.schedule, and anything that is no HH:MM as no setting', () => {
  // Catches: "25:00" or "3" is passed on, and the wake's moment is NaN so it never falls due.
  // Changed: `selfimprovement.at` became the one setting `selfimprovement.schedule`, read in its parsed form.
  assert.deepEqual(innerSettings({ selfimprovement: { schedule: 'at 05:45' } }).wakes.selfimprovement.schedule, {
    kind: 'at',
    at: ['05:45'],
  });
  const fallback = innerSettings({}).wakes.selfimprovement.schedule;
  for (const bad of ['at 25:00', '3', 'at 03:60', 3])
    assert.deepEqual(
      innerSettings({ selfimprovement: { schedule: bad } }).wakes.selfimprovement.schedule,
      fallback,
      String(bad)
    );
});

// ---- the inner life ----

type Call = {
  inner: {
    wake: {
      kind: string;
      items: Array<{ reason: string }>;
      selfimprovement?: { shapes: Array<unknown> } | null;
    };
  };
};

function setup(start: number) {
  const clock = { t: start };
  world().channel({ id: 'c1', name: 'chan-c1', placeId: ROOT, permissions: { send: true } });
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
      selfimprovement: { enabled: true, schedule: 'at 03:00', failuresPerShape: 3 },
    },
  };
  const service = createIntentionService({
    stores: createIntentionStores({ dataDir: tempDir('nep-daily-'), now: () => clock.t, log: SILENT }),
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
  const journal = { inner: () => Promise.resolve(), read: () => [] };
  let life: ReturnType<typeof createInnerLife> | null = null;
  const door = createEventDoor({ handlers: { 'inner.wake': (event: object) => life?.onWake(event) }, log: SILENT });
  life = createInnerLife({
    hot,
    dataDir: tempDir('nep-daily-inner-'),
    turns,
    intentions: service,
    journal,
    reads: world().reads,
    iface: () => 'fake',
    chatName: (id: string) => `chan-${id}`,
    submit: (event: object) => door.submit(event),
    store: { state: { data: {} } },
    meter: { run: async (fn: () => unknown) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
    selfimprovement: {
      granted: () => [],
      skills: () => [],
      proposals: () => Promise.resolve({ entries: [], outbox: [] }),
      ackOutbox: () => Promise.resolve(),
    },
    rng: () => 0.5,
    now: () => clock.t,
    log: SILENT,
  });
  return { clock, life, calls };
}

const selfimprovementCalls = (calls: ReadonlyArray<Call>): Array<Call> =>
  calls.filter((call) => call.inner.wake.kind === 'selfimprovement');

test('the tick at the hour raises one daily wake, and the ticks after it that day raise none', async () => {
  // Catches: selfimprovementDue still waits seven days on the heartbeat clock, or wakes her again on the next tick.
  const run = setup(SLOT - HOUR);
  await run.life.tick();
  run.clock.t = SLOT;
  await run.life.tick();
  run.clock.t = SLOT + 30 * MINUTE;
  await run.life.tick();
  run.clock.t = SLOT + 10 * HOUR;
  await run.life.tick();
  const woken = selfimprovementCalls(run.calls);
  assert.equal(woken.length, 1);
  assert.equal(woken[0]?.inner.wake.items[0]?.reason, 'daily');
});

test('no daily wake is raised before the hour', async () => {
  // Catches: the first tick of the day raises the wake at once, before the watcher's report exists.
  const run = setup(SLOT - 3 * HOUR);
  await run.life.tick();
  run.clock.t = SLOT - MINUTE;
  await run.life.tick();
  assert.equal(selfimprovementCalls(run.calls).length, 0);
});

test('the next day the wake comes again at the hour', async () => {
  // Catches: the wake's moment is stored as a day and the next day's comparison never passes, so she wakes once ever.
  const run = setup(SLOT - HOUR);
  await run.life.tick();
  run.clock.t = SLOT;
  await run.life.tick();
  run.clock.t = SLOT + DAY;
  await run.life.tick();
  assert.equal(selfimprovementCalls(run.calls).length, 2);
});
