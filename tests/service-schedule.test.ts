// The schedule of a scheduled service (src/service/schedule.ts), pure, with `now` given: the text a setting holds
// (`at 00:00,12:00` or `every 6h`) and what is due at a moment. A slot is a moment of the UTC day. `last` is the moment
// the service last fired for, and null means it never did, so nothing is owed yet. At most one run is due however many
// slots passed, and that run is the newest slot, so a downtime never comes back as a burst.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSchedule, formatSchedule, parseSchedule } from '../src/service/schedule.ts';
import type { ServiceSchedule } from '../src/service/schedule.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = (iso: string): number => Date.parse(iso);

const TWICE: ServiceSchedule = { kind: 'at', at: ['00:00', '12:00'] };
const SIX_HOURS: ServiceSchedule = { kind: 'every', everyMinutes: 360 };

/** Every minute from `from` to `to`, firing what is due as the scheduler does; the moments it fired for. */
function ticks(schedule: ServiceSchedule, from: number, to: number, last: number | null): Array<number> {
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

test('parseSchedule reads several daily times, sorted', () => {
  // Catches: the slots keep the typed order, so the same schedule has two spellings and status shows either.
  assert.deepEqual(parseSchedule('at 12:00,00:00'), { kind: 'at', at: ['00:00', '12:00'] });
});

test('parseSchedule reads an interval in hours and in minutes', () => {
  // Catches: the unit is ignored, so `every 90m` runs every 90 hours.
  assert.deepEqual(parseSchedule('every 6h'), { kind: 'every', everyMinutes: 360 });
  assert.deepEqual(parseSchedule('every 90m'), { kind: 'every', everyMinutes: 90 });
});

for (const bad of [
  '',
  'at',
  'at 25:00',
  'at 7:00',
  'at 00:60',
  'at 00:00,00:00',
  'at 00:00,',
  'every',
  'every 0h',
  'every 0m',
  'every -1h',
  'every 6',
  'every 1.5h',
  'every 1h30m',
  'every 6d',
  'at 00:00 every 6h',
  'daily',
  7,
  null,
]) {
  test(`parseSchedule refuses ${JSON.stringify(bad)}`, () => {
    // Catches: a hand-edited setting that means nothing becomes a schedule of NaN moments that never falls due.
    assert.equal(parseSchedule(bad), null);
  });
}

test('formatSchedule gives the one spelling a setting holds, hours when the interval is whole hours', () => {
  // Catches: `every 360m` and `every 6h` are stored differently, so a /config read depends on how it was typed.
  assert.equal(formatSchedule({ kind: 'every', everyMinutes: 360 }), 'every 6h');
  assert.equal(formatSchedule({ kind: 'every', everyMinutes: 90 }), 'every 90m');
  assert.equal(formatSchedule(TWICE), 'at 00:00,12:00');
});

test('a slot is due at its moment exactly, for its own moment', () => {
  // Catches: the comparison is strict, so a tick landing on the minute misses the slot until the next one.
  const now = at('2026-11-04T12:00:00Z');
  assert.equal(evaluateSchedule({ schedule: TWICE, enabled: true, now, last: now - HOUR }).due, now);
});

test('between two daily slots nothing is due and the next one is the later slot of the day', () => {
  // Catches: only the first slot of the list is read, so the second time of `--at` never runs.
  const now = at('2026-11-04T06:00:00Z');
  const seen = evaluateSchedule({ schedule: TWICE, enabled: true, now, last: at('2026-11-04T00:00:00Z') });
  assert.deepEqual(seen, { due: null, next: at('2026-11-04T12:00:00Z') });
});

test('after the last slot of the day the next one is the first slot of tomorrow', () => {
  // Catches: the slots are laid on today only, so status has no next time in the evening.
  const now = at('2026-11-04T23:00:00Z');
  const seen = evaluateSchedule({ schedule: TWICE, enabled: true, now, last: at('2026-11-04T12:00:00Z') });
  assert.deepEqual(seen, { due: null, next: at('2026-11-05T00:00:00Z') });
});

test('a day of ticks fires each daily slot once', () => {
  // Catches: a slot fires on every tick after it, sixty times an hour.
  const from = at('2026-11-04T01:00:00Z');
  const fired = ticks(TWICE, from, from + DAY, from);
  assert.deepEqual(fired, [at('2026-11-04T12:00:00Z'), at('2026-11-05T00:00:00Z')]);
});

test('an interval falls due one interval after the last run, and the next after that', () => {
  // Catches: the interval counts from the tick that looked, so it drifts by a tick each round.
  const last = at('2026-11-04T01:30:00Z');
  const before = evaluateSchedule({ schedule: SIX_HOURS, enabled: true, now: last + 6 * HOUR - MINUTE, last });
  assert.deepEqual(before, { due: null, next: last + 6 * HOUR });
  const reached = evaluateSchedule({ schedule: SIX_HOURS, enabled: true, now: last + 6 * HOUR + MINUTE, last });
  assert.deepEqual(reached, { due: last + 6 * HOUR, next: last + 12 * HOUR });
});

for (const [what, schedule, last] of [
  ['several daily slots', TWICE, at('2026-11-01T00:00:00Z')],
  ['an interval', SIX_HOURS, at('2026-11-01T00:00:00Z')],
] as const) {
  test(`a disabled service owes nothing and has no next time: ${what}`, () => {
    // Catches: the flag is read after the due check, so a disabled service still fires its overdue slot.
    const seen = evaluateSchedule({ schedule, enabled: false, now: at('2026-11-04T13:00:00Z'), last });
    assert.deepEqual(seen, { due: null, next: null });
  });

  test(`a re-enable after days down gives one run and no burst: ${what}`, () => {
    // Catches: each missed slot is owed, so three days down come back as a dozen runs in a row.
    const now = at('2026-11-04T13:00:00Z');
    const fired = ticks(schedule, now, now + 10 * MINUTE, last);
    assert.equal(fired.length, 1);
  });
}

test('the one run after a downtime is the newest missed slot', () => {
  // Catches: the oldest missed slot is taken, so `last` stays days behind and every tick owes another run.
  const now = at('2026-11-04T13:00:00Z');
  const seen = evaluateSchedule({ schedule: TWICE, enabled: true, now, last: at('2026-11-01T00:00:00Z') });
  assert.deepEqual(seen, { due: at('2026-11-04T12:00:00Z'), next: at('2026-11-05T00:00:00Z') });
});

test('the one run after an interval downtime keeps the grid of the interval', () => {
  // Catches: the run is stamped with the tick, so the next interval starts from whenever the service woke.
  const last = at('2026-11-04T00:00:00Z');
  const now = last + 20 * HOUR;
  const seen = evaluateSchedule({ schedule: SIX_HOURS, enabled: true, now, last });
  assert.deepEqual(seen, { due: last + 18 * HOUR, next: last + 24 * HOUR });
});

test('a service that never fired owes nothing, so enabling it starts no run', () => {
  // Catches: a null `last` reads as long overdue, so `enable` at 13:00 runs the 12:00 slot at once.
  const now = at('2026-11-04T13:00:00Z');
  for (const schedule of [TWICE, SIX_HOURS])
    assert.equal(evaluateSchedule({ schedule, enabled: true, now, last: null }).due, null);
});

test('a service that never fired names the first time after now, and now itself is not that time', () => {
  // Catches: the next time equals now, so status promises a run that never comes.
  const now = at('2026-11-04T12:00:00Z');
  assert.equal(evaluateSchedule({ schedule: TWICE, enabled: true, now, last: null }).next, at('2026-11-05T00:00:00Z'));
  assert.equal(evaluateSchedule({ schedule: SIX_HOURS, enabled: true, now, last: null }).next, now + 6 * HOUR);
});

test('a clock set back fires no slot it already fired, walking forward again', () => {
  // Catches: `last` is compared to `now` and not to the slot, so the 12:00 slot runs a second time after an NTP step.
  const last = at('2026-11-04T12:00:00Z');
  const from = at('2026-11-04T10:00:00Z');
  assert.deepEqual(ticks(TWICE, from, last + HOUR, last), []);
});

test('a clock set back fires no interval twice, and the grid goes on from the last run', () => {
  // Catches: a `last` in the future yields a negative count of intervals and a due moment before `last`.
  const last = at('2026-11-04T12:00:00Z');
  const from = last - 3 * HOUR;
  assert.deepEqual(ticks(SIX_HOURS, from, last + 6 * HOUR, last), [last + 6 * HOUR]);
});

test('the next time after a clock set back lies after the last run', () => {
  // Catches: status names a slot already fired, which the evaluation then refuses to fire.
  const last = at('2026-11-04T12:00:00Z');
  const seen = evaluateSchedule({ schedule: TWICE, enabled: true, now: last - 3 * HOUR, last });
  assert.deepEqual(seen, { due: null, next: at('2026-11-05T00:00:00Z') });
});
