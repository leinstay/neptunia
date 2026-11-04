// The one setting `<name>.schedule` (`at 06:00,18:00` or `every 6h`) reaching each mechanic's own scheduler: the
// heartbeat's timer and the selfimprovement wake in the inner life, the diary's day plan, the watcher's settings and
// timer, and the moves that bring a deployment's old keys to it. Each mechanic keeps its missed-wake policy, so overdue
// wakes never stack. The inner life runs over a fake turn runner with the clock injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInnerLife } from '../src/behavior/inner.ts';
import { innerSettings } from '../src/behavior/inner/settings.ts';
import { dueSlot, planDay } from '../src/behavior/diary.ts';
import { readConfig } from '../src/config.ts';
import { moveConfigKeys } from '../src/config-moves.ts';
import { localConfigPath } from '../src/config/files.ts';
import { createEventDoor } from '../src/interface/door.ts';
import { createIntentionService } from '../src/intentions/service.ts';
import { createIntentionStores } from '../src/intentions/store.ts';
import { renderUnit } from '../src/setup/units.ts';
import type { UnitVars } from '../src/setup/units.ts';
import { watcherSettings } from '../src/watcher/settings.ts';
import { tempDir } from './fixtures/tmp.ts';
import { useIface, world } from './fixtures/turn-world.ts';

useIface('fake');

const REPO = fileURLToPath(new URL('..', import.meta.url));
const GUILD = 'g1';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const at = (iso: string): number => Date.parse(iso);

type Call = { inner: { wake: { kind: string; chainId: string } } };

/** An inner life over the settings given, a clock of its own and a turn runner that records and answers skip. */
function lifeWith(sections: Record<string, unknown>, start: number, rng: () => number = () => 0.5) {
  const clock = { t: start };
  world().channel({ id: 'c1', name: 'chan-c1', guildId: GUILD, permissions: { send: true } });
  const hot = {
    config: {
      bot: { timezone: 'UTC' },
      features: { wakes: true, intentions: true, journal: true },
      mention: { oneAtATime: true },
      wakes: { mode: 'shadow', tickSeconds: 60, review: { enabled: false, historyDays: 14 }, caps: { perChain: 3 } },
      heartbeat: { enabled: false },
      selfimprovement: { enabled: false },
      ...sections,
    },
  };
  const service = createIntentionService({
    stores: createIntentionStores({ dataDir: tempDir('nep-svc-'), now: () => clock.t, log: SILENT }),
    hot,
    getGuildId: () => GUILD,
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
  let life: ReturnType<typeof createInnerLife> | null = null;
  const door = createEventDoor({ handlers: { 'inner.wake': (event: object) => life?.onWake(event) }, log: SILENT });
  life = createInnerLife({
    hot,
    dataDir: tempDir('nep-svc-inner-'),
    turns,
    intentions: service,
    journal: { inner: () => Promise.resolve(), read: () => [] },
    reads: world().reads,
    iface: () => 'fake',
    conversationName: (id: string) => `chan-${id}`,
    submit: (event: object) => door.submit(event),
    store: { state: { data: {} } },
    getGuildId: () => GUILD,
    meter: { run: async (fn: () => unknown) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
    selfimprovement: {
      granted: () => [],
      skills: () => [],
      proposals: () => Promise.resolve({ entries: [], outbox: [] }),
      ackOutbox: () => Promise.resolve(),
    },
    rng,
    now: () => clock.t,
    log: SILENT,
  });
  return { clock, life, calls };
}

const wakesOf = (calls: ReadonlyArray<Call>, kind: string): Array<Call> =>
  calls.filter((call) => call.inner.wake.kind === kind);

// ---- the heartbeat -----------------------------------------------------------------------------------------------------

test('heartbeat every 4h draws its moment on that interval, with the jitter of the setting', async () => {
  // Catches: the schedule is saved and the timer goes on reading the old interval.
  const start = at('2026-11-04T05:00:00Z');
  const low = lifeWith({ heartbeat: { schedule: 'every 4h', jitterMinutes: 45 } }, start, () => 0);
  await low.life.tick();
  assert.equal(low.life.state(GUILD).heartbeat?.nextAt, start + 4 * HOUR - 45 * MINUTE);
  const middle = lifeWith({ heartbeat: { schedule: 'every 4h', jitterMinutes: 45 } }, start, () => 0.5);
  await middle.life.tick();
  assert.equal(middle.life.state(GUILD).heartbeat?.nextAt, start + 4 * HOUR);
});

test('heartbeat at daily times takes the next slot exactly, with no jitter on it', async () => {
  // Catches: a jitter moves a time the owner named, or only the first slot of the day is read.
  const start = at('2026-11-04T07:00:00Z');
  const run = lifeWith({ heartbeat: { schedule: 'at 06:00,18:00', jitterMinutes: 60 } }, start, () => 0);
  await run.life.tick();
  assert.equal(run.life.state(GUILD).heartbeat?.nextAt, at('2026-11-04T18:00:00Z'));
});

for (const schedule of ['every 4h', 'at 06:00,18:00']) {
  test(`heartbeat ${schedule}: days overdue give at most one wake, and the next moment lies ahead`, async () => {
    // Catches: the timer walks its slots one by one from the old moment, so a downtime comes back as a row of wakes.
    const start = at('2026-11-04T05:00:00Z');
    const run = lifeWith({ heartbeat: { schedule, jitterMinutes: 0 } }, start);
    await run.life.tick();
    run.clock.t = start + 3 * DAY;
    for (let i = 0; i < 5; i += 1) {
      await run.life.tick();
      run.clock.t += MINUTE;
    }
    assert.ok(wakesOf(run.calls, 'heartbeat').length <= 1, String(run.calls.length));
    const next = run.life.state(GUILD).heartbeat?.nextAt ?? 0;
    assert.ok(next > run.clock.t - 5 * MINUTE, 'the next moment is drawn from now, never from a missed slot');
    if (schedule === 'every 4h') {
      const last = run.life.state(GUILD).heartbeat?.lastAt ?? 0;
      assert.ok(next - last >= 4 * HOUR && next - last <= 4 * HOUR + 10 * MINUTE, String(next - last));
    } else assert.ok(['06:00', '18:00'].includes(new Date(next).toISOString().slice(11, 16)));
  });
}

test('the heartbeat settings read the schedule and keep the jitter, and a schedule that means nothing is no setting', () => {
  // Catches: a hand-edited value gives the timer NaN minutes, and the heartbeat never falls due.
  const set = innerSettings({ heartbeat: { schedule: 'every 4h', jitterMinutes: 45 } }).heartbeat;
  assert.deepEqual(set.schedule, { kind: 'every', everyMinutes: 240 });
  assert.equal(set.jitterMinutes, 45);
  assert.deepEqual(
    innerSettings({ heartbeat: { schedule: 'sometimes' } }).heartbeat.schedule,
    innerSettings({}).heartbeat.schedule
  );
});

// ---- the selfimprovement wake ------------------------------------------------------------------------------------------

test('selfimprovement at two daily times wakes at each, once', async () => {
  // Catches: the wake reads one time of the day, so the second slot of `--at` never comes.
  const start = at('2026-11-04T02:00:00Z');
  const run = lifeWith({ selfimprovement: { enabled: true, schedule: 'at 03:00,15:00', failuresPerShape: 3 } }, start);
  await run.life.tick();
  for (const iso of ['2026-11-04T03:00:00Z', '2026-11-04T03:30:00Z', '2026-11-04T15:00:00Z', '2026-11-04T16:00:00Z']) {
    run.clock.t = at(iso);
    await run.life.tick();
  }
  assert.deepEqual(
    wakesOf(run.calls, 'selfimprovement').map((call) => call.inner.wake.chainId),
    [`selfimprovement:${at('2026-11-04T03:00:00Z')}`, `selfimprovement:${at('2026-11-04T15:00:00Z')}`]
  );
});

test('selfimprovement every 6h wakes one interval after the last wake', async () => {
  // Catches: only daily times are understood, so an interval schedule silently falls back to the default hour.
  const start = at('2026-11-04T01:30:00Z');
  const run = lifeWith({ selfimprovement: { enabled: true, schedule: 'every 6h', failuresPerShape: 3 } }, start);
  await run.life.tick();
  run.clock.t = start + 5 * HOUR;
  await run.life.tick();
  assert.equal(wakesOf(run.calls, 'selfimprovement').length, 0);
  run.clock.t = start + 6 * HOUR;
  await run.life.tick();
  run.clock.t = start + 7 * HOUR;
  await run.life.tick();
  assert.equal(wakesOf(run.calls, 'selfimprovement').length, 1);
});

test('selfimprovement overdue by days gives one wake, for the newest slot', async () => {
  // Catches: each missed slot raises a wake of its own id, so she files a row of development decisions on return.
  const start = at('2026-11-04T02:00:00Z');
  const run = lifeWith({ selfimprovement: { enabled: true, schedule: 'at 03:00,15:00', failuresPerShape: 3 } }, start);
  await run.life.tick();
  run.clock.t = at('2026-11-07T16:00:00Z');
  await run.life.tick();
  run.clock.t += MINUTE;
  await run.life.tick();
  assert.deepEqual(
    wakesOf(run.calls, 'selfimprovement').map((call) => call.inner.wake.chainId),
    [`selfimprovement:${at('2026-11-07T15:00:00Z')}`]
  );
});

test('selfimprovement fires no slot twice when the clock steps back', async () => {
  // Catches: the slot is compared with the clock alone, so a step back runs the 15:00 wake again.
  const start = at('2026-11-04T14:00:00Z');
  const run = lifeWith({ selfimprovement: { enabled: true, schedule: 'at 15:00', failuresPerShape: 3 } }, start);
  await run.life.tick();
  run.clock.t = at('2026-11-04T15:00:00Z');
  await run.life.tick();
  run.clock.t = at('2026-11-04T14:00:00Z');
  await run.life.tick();
  run.clock.t = at('2026-11-04T15:10:00Z');
  await run.life.tick();
  assert.equal(wakesOf(run.calls, 'selfimprovement').length, 1);
});

// ---- the diary ---------------------------------------------------------------------------------------------------------

const WINDOWS = [{ from: 7, to: 11, posts: [2, 2] }];

test('a diary schedule of daily times replaces the windows with exactly those slots, in UTC', () => {
  // Catches: the setting is saved and the day plan goes on drawing from the windows.
  const now = at('2026-11-04T05:00:00Z');
  for (const zone of ['UTC', 'Europe/Athens']) {
    const plan = planDay({ schedule: 'at 09:00,21:00', windows: WINDOWS, quietDayChance: 0 }, now, zone, () => 0.5);
    assert.deepEqual(plan.slots, [at('2026-11-04T09:00:00Z'), at('2026-11-04T21:00:00Z')], zone);
  }
});

test('a diary schedule of an interval lays its slots from the start of the UTC day', () => {
  // Catches: the interval counts from whenever the plan was made, so a restart moves every post of the day.
  const plan = planDay(
    { schedule: 'every 6h', windows: WINDOWS, quietDayChance: 0 },
    at('2026-11-04T05:00:00Z'),
    'UTC',
    () => 0.5
  );
  assert.deepEqual(
    plan.slots,
    ['00', '06', '12', '18'].map((hour) => at(`2026-11-04T${hour}:00:00Z`))
  );
});

test('a diary interval shorter than the gap of the windows keeps all its slots', () => {
  // Catches: the 90-minute gap between drawn posts silently thins `every 1h` to one post in two.
  const plan = planDay(
    { schedule: 'every 1h', windows: WINDOWS, quietDayChance: 0 },
    at('2026-11-04T05:00:00Z'),
    'UTC',
    () => 0.5
  );
  assert.equal(plan.slots.length, 24);
});

test('a named diary schedule has no quiet day: status never promises a time the dice then drop', () => {
  // Catches: the quiet-day chance suppresses slots the owner named, which the plan's "no random suppression" forbids.
  const plan = planDay(
    { schedule: 'at 09:00', windows: WINDOWS, quietDayChance: 1 },
    at('2026-11-04T05:00:00Z'),
    'UTC',
    () => 0
  );
  assert.equal(plan.quiet, false);
  assert.deepEqual(plan.slots, [at('2026-11-04T09:00:00Z')]);
});

test('diary slots of a schedule missed past the grace are dropped together, not stacked', () => {
  // Catches: slots of the fixed schedule bypass the grace, so a morning down comes back as a row of posts.
  const plan = planDay(
    { schedule: 'at 09:00,10:00,11:00', quietDayChance: 0 },
    at('2026-11-04T05:00:00Z'),
    'UTC',
    () => 0.5
  );
  assert.deepEqual(dueSlot(plan, at('2026-11-04T15:00:00Z'), 30), {
    slot: null,
    dropped: [at('2026-11-04T09:00:00Z'), at('2026-11-04T10:00:00Z'), at('2026-11-04T11:00:00Z')],
  });
});

// ---- the watcher ------------------------------------------------------------------------------------------------------

test('the watcher settings read the schedule, and a schedule that means nothing is no setting', () => {
  // Catches: `watcher.at` stays the setting the renderer reads, so the new key changes nothing.
  assert.deepEqual(watcherSettings({ watcher: { schedule: 'at 01:00,13:00' } }).schedule, {
    kind: 'at',
    at: ['01:00', '13:00'],
  });
  assert.deepEqual(watcherSettings({ watcher: { schedule: 'often' } }).schedule, watcherSettings({}).schedule);
});

const TEMPLATE = readFileSync(join(REPO, 'deploy', 'neptunia-watcher.timer'), 'utf8');
const VARS: UnitVars = {
  user: 'someone',
  group: 'someone',
  home: '/home/someone',
  rootDir: '/srv/app',
  privateDir: '/srv/data',
  dataDir: '/srv/data',
  node: '/usr/bin/node',
};

/** The values of the lines of `key` in a unit. */
const valuesOf = (text: string, key: string): Array<string> =>
  text
    .split('\n')
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));

test('the watcher timer renders one calendar line per slot', () => {
  // Catches: only the first slot reaches systemd, or the lines land on one key that systemd reads differently.
  const text = renderUnit(TEMPLATE, 'user', { ...VARS, watcherSchedule: { kind: 'at', at: ['00:00', '12:00'] } });
  assert.deepEqual(valuesOf(text, 'OnCalendar'), ['*-*-* 00:00:00 UTC', '*-*-* 12:00:00 UTC']);
  // systemd's catch-up after a downtime is one run however many slots passed, and the rewrite must not lose it.
  assert.deepEqual(valuesOf(text, 'Persistent'), ['true']);
});

test('the watcher timer with an interval has no calendar line and starts counting at its own activation', () => {
  // Catches: OnUnitActiveSec alone never fires when the worker has not run yet, so an enabled watcher stays silent.
  const text = renderUnit(TEMPLATE, 'user', { ...VARS, watcherSchedule: { kind: 'every', everyMinutes: 90 } });
  assert.deepEqual(valuesOf(text, 'OnCalendar'), []);
  assert.deepEqual(valuesOf(text, 'OnUnitActiveSec'), ['90min']);
  assert.deepEqual(valuesOf(text, 'OnActiveSec'), ['90min']);
  assert.deepEqual(valuesOf(text, 'Unit'), ['neptunia-watcher.service']);
});

test('no rendered service unit starts a retired command', () => {
  // Catches: the unit keeps `watcher run`, which now answers exit 2, and the timer fails every day in silence.
  const retired = [/\bwatcher run\b/, /\bselfimprovement run\b/];
  const services = readdirSync(join(REPO, 'deploy')).filter((file) => file.endsWith('.service'));
  assert.ok(services.includes('neptunia-watcher.service'));
  for (const file of services) {
    const text = renderUnit(readFileSync(join(REPO, 'deploy', file), 'utf8'), 'user', VARS);
    for (const exec of valuesOf(text, 'ExecStart'))
      for (const form of retired) assert.equal(form.test(exec), false, `${file}: ${exec}`);
  }
});

// ---- the old keys ------------------------------------------------------------------------------------------------------

for (const [what, old, section, schedule] of [
  ['watcher.at', { watcher: { at: '06:30' } }, 'watcher', 'at 06:30'],
  ['selfimprovement.at', { selfimprovement: { at: '05:45' } }, 'selfimprovement', 'at 05:45'],
  ['heartbeat.everyMinutes', { heartbeat: { everyMinutes: 240 } }, 'heartbeat', 'every 4h'],
  ['heartbeat.everyMinutes of minutes', { heartbeat: { everyMinutes: 90 } }, 'heartbeat', 'every 90m'],
  ['innerLife.heartbeat.everyMinutes', { innerLife: { heartbeat: { everyMinutes: 120 } } }, 'heartbeat', 'every 2h'],
] as const) {
  test(`the old ${what} becomes ${section}.schedule`, () => {
    // Catches: the schedule of a running deployment returns to its default on upgrade.
    const { config } = moveConfigKeys(structuredClone(old));
    assert.deepEqual(config[section], { schedule });
  });
}

test('the jitter stays under its key when the interval moves', () => {
  // Catches: the move of the section takes the jitter with it, or resets it.
  const { config } = moveConfigKeys({ heartbeat: { everyMinutes: 240, jitterMinutes: 45 } });
  assert.deepEqual(config.heartbeat, { schedule: 'every 4h', jitterMinutes: 45 });
});

test('a new schedule wins over an old key still in the file, and the old key goes', () => {
  // Catches: an old key left in the file overrides what `setup` saved on the next read.
  const moved = moveConfigKeys({ watcher: { at: '06:30', schedule: 'every 6h' } });
  assert.deepEqual(moved.config.watcher, { schedule: 'every 6h' });
  assert.deepEqual(moved.shadowed, [{ from: 'watcher.at', to: 'watcher.schedule' }]);
});

test('an old key that is no time moves nowhere, and is dropped and told', () => {
  // Catches: a junk value becomes a schedule the parser refuses, hiding the default behind a broken setting.
  const moved = moveConfigKeys({ watcher: { at: 'noon' } });
  assert.equal(moved.dropped.includes('watcher.at'), true);
  assert.equal(JSON.stringify(moved.config).includes('noon'), false);
});

test('a deployment with the old keys reads its schedule through the settings loader', () => {
  // Catches: the shipped default of the new key wins over the local file's old one, because the move runs too late.
  const dir = tempDir('nep-svc-config-');
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(localConfigPath(dir), JSON.stringify({ watcher: { at: '06:30' }, heartbeat: { everyMinutes: 240 } }));
  const config = readConfig(REPO, { privateDir: dir });
  assert.deepEqual(watcherSettings(config).schedule, { kind: 'at', at: ['06:30'] });
  assert.deepEqual(innerSettings(config).heartbeat.schedule, { kind: 'every', everyMinutes: 240 });
  assert.equal((config.watcher as Record<string, unknown>).at, undefined);
});

test('a schedule in the local file replaces the shipped one whole', () => {
  // Catches: a schedule stored as an object deep-merges with the shipped default into an `at` and an `every` at once.
  const dir = tempDir('nep-svc-config-');
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(localConfigPath(dir), JSON.stringify({ heartbeat: { schedule: 'at 06:00' } }));
  assert.deepEqual(innerSettings(readConfig(REPO, { privateDir: dir })).heartbeat.schedule, {
    kind: 'at',
    at: ['06:00'],
  });
});
