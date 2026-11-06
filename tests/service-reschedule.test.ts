// Rescheduling a scheduled service while one of its runs is in progress. The run that is running finishes under the schedule
// it started with and is committed, the next run follows the new schedule from the moment the old run left off, and no slot
// owes a second run. The pure half uses the minute-by-minute ticks of the schedule rules (src/service/schedule.ts), the
// running half a real inner life with a turn that waits until the test lets it go (the rig of tests/service-wake-clock.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInnerLife } from '../src/behavior/inner.ts';
import { createEventDoor } from '../src/interface/door.ts';
import { createIntentionService } from '../src/intentions/service.ts';
import { createIntentionStores } from '../src/intentions/store.ts';
import { evaluateSchedule } from '../src/service/schedule.ts';
import type { ServiceSchedule } from '../src/service/schedule.ts';
import { tempDir } from './fixtures/tmp.ts';
import { useIface, world } from './fixtures/turn-world.ts';

useIface('fake');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (iso: string): number => Date.parse(iso);

/** Every minute from `from` to `to`, firing what is due as the scheduler does; the moments it fired for. */
function ticks(schedule: ServiceSchedule, from: number, to: number, last: number): Array<number> {
  const fired: Array<number> = [];
  let held = last;
  for (let now = from; now <= to; now += MINUTE) {
    const { due } = evaluateSchedule({ schedule, enabled: true, now, last: held });
    if (due !== null) {
      fired.push(due);
      held = due;
    }
  }
  return fired;
}

test("a run that fired for its slot owes nothing again under the new schedule, and the next run is the new schedule's slot", () => {
  // Catches: the new schedule is counted from nothing, so the slot the running run already took fires a second time.
  const slot = at('2026-11-04T15:00:00Z');
  const fired = ticks({ kind: 'at', at: ['15:00', '18:00'] }, slot, slot + 6 * HOUR, slot);
  assert.deepEqual(fired, [at('2026-11-04T18:00:00Z')]);
});

test('an interval swapped for another counts from the run in progress, not from the tick that saw the change', () => {
  // Catches: the new interval restarts at the moment of the edit, so the next run drifts by however long the old run took.
  const started = at('2026-11-04T10:00:00Z');
  const fired = ticks({ kind: 'every', everyMinutes: 120 }, started + 40 * MINUTE, started + 5 * HOUR, started);
  assert.deepEqual(fired, [started + 2 * HOUR, started + 4 * HOUR]);
});

test('the old schedule would not have fired again the same day, so a run after the edit comes only from the new one', () => {
  // Catches: the old slot list is still read for the day, so nothing distinguishes the two schedules in the evening.
  const slot = at('2026-11-04T15:00:00Z');
  assert.deepEqual(ticks({ kind: 'at', at: ['15:00'] }, slot, slot + 8 * HOUR, slot), []);
  assert.deepEqual(ticks({ kind: 'at', at: ['15:00', '20:00'] }, slot, slot + 8 * HOUR, slot), [
    at('2026-11-04T20:00:00Z'),
  ]);
});

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

/** A real inner life whose turn waits for `release` while `held`; the settings object is the one the life reads. */
function lifeWith(selfimprovement: Record<string, unknown>, start: number) {
  const clock = { t: start };
  world().channel({ id: 'c1', name: 'chan-c1', placeId: 'g1', permissions: { send: true } });
  const hot = {
    config: {
      bot: { timezone: 'UTC' },
      features: { wakes: true, intentions: true, journal: true },
      mention: { oneAtATime: true },
      wakes: { mode: 'shadow', tickSeconds: 60, review: { enabled: false, historyDays: 14 }, caps: { perChain: 3 } },
      heartbeat: { enabled: false },
      selfimprovement,
    },
  };
  const service = createIntentionService({
    stores: createIntentionStores({ dataDir: tempDir('nep-resched-'), now: () => clock.t, log: SILENT }),
    hot,
    now: () => clock.t,
    log: SILENT,
  });
  const gate = { held: false, entered: 0, release: () => {} };
  const turns = {
    isAnyBusy: () => false,
    runTurn: async () => {
      gate.entered += 1;
      if (gate.held) await new Promise<void>((resolve) => (gate.release = resolve));
      return { outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: `t-${gate.entered}` } };
    },
  };
  let life: ReturnType<typeof createInnerLife> | null = null;
  const door = createEventDoor({ handlers: { 'inner.wake': (event: object) => life?.onWake(event) }, log: SILENT });
  life = createInnerLife({
    hot,
    dataDir: tempDir('nep-resched-inner-'),
    turns,
    intentions: service,
    journal: { inner: () => Promise.resolve(), read: () => [] },
    reads: world().reads,
    iface: () => 'fake',
    conversationName: (id: string) => `chan-${id}`,
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
  return { clock, life, gate, hot };
}

/** A tick, and the moments the turn has started by the time it settles. */
async function startedRun(run: ReturnType<typeof lifeWith>, now: number): Promise<{ ticking: Promise<unknown> }> {
  run.clock.t = now;
  run.gate.held = true;
  const ticking = run.life.tick();
  for (let i = 0; i < 200 && run.gate.entered === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(run.gate.entered, 1, 'the turn started');
  return { ticking };
}

test('a schedule edited during a run lets the run finish and commit once, and the same slot runs no second time', async () => {
  // Catches: the edit restarts the clock while the run is in flight, and the committed run is replayed on the next tick.
  const run = lifeWith({ enabled: true, schedule: 'at 15:00', failuresPerShape: 3 }, at('2026-11-04T14:00:00Z'));
  await run.life.tick();
  const { ticking } = await startedRun(run, at('2026-11-04T15:00:00Z'));
  // The lead: the live settings get a name (R.2).
  const { config } = run.hot;
  Object.assign(config.selfimprovement, { schedule: 'at 18:00' });
  run.gate.release();
  await ticking;
  run.gate.held = false;
  run.clock.t = at('2026-11-04T15:30:00Z');
  await run.life.tick();
  assert.equal(run.gate.entered, 1, 'the slot that ran does not run again');
});

test("the next run after an edit made during a run comes at the new schedule's slot, once", async () => {
  // Catches: the edit leaves the old slot list in the clock, so the new slot never fires, or the old one fires on top of it.
  const run = lifeWith({ enabled: true, schedule: 'at 15:00', failuresPerShape: 3 }, at('2026-11-04T14:00:00Z'));
  await run.life.tick();
  const { ticking } = await startedRun(run, at('2026-11-04T15:00:00Z'));
  // The lead: the live settings get a name (R.2).
  const { config } = run.hot;
  Object.assign(config.selfimprovement, { schedule: 'at 18:00' });
  run.gate.release();
  await ticking;
  run.gate.held = false;
  for (const moment of ['2026-11-04T15:30:00Z', '2026-11-04T17:59:00Z']) {
    run.clock.t = at(moment);
    await run.life.tick();
    assert.equal(run.gate.entered, 1, `nothing runs at ${moment}`);
  }
  run.clock.t = at('2026-11-04T18:00:00Z');
  await run.life.tick();
  assert.equal(run.gate.entered, 2, 'the new slot runs');
  run.clock.t = at('2026-11-04T18:05:00Z');
  await run.life.tick();
  assert.equal(run.gate.entered, 2, 'and only once');
});
