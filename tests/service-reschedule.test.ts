// Rescheduling a scheduled service while one of its runs is in progress. The next run follows the new schedule from the
// moment the old run left off, and no slot owes a second run. The tests use the minute-by-minute ticks of the schedule
// rules (src/service/schedule.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSchedule } from '../src/service/schedule.ts';
import type { ServiceSchedule } from '../src/service/schedule.ts';

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
