// The daily review wake leaves with the forced turn (plan 2026-11-06-turn-frame, slice 5, and the owner's answer 18 of
// 2026-11-07): no `review` wake is drawn, queued or run, and the door refuses one as a kind it does not know. The heartbeat
// is where she finds out what she wants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, MINUTE_MS } from '../src/time.ts';
import { NOW, clock, setup } from './fixtures/inner-rig.ts';
import { useIface } from './fixtures/turn-world.ts';

useIface('fake');

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('the door refuses a wake of kind review', () => {
  // Bug: a stored or replayed review wake still enters the queue and runs a turn nothing builds any more.
  clock.t = NOW;
  // Slice 5 (corrections): the rig no longer writes a finished review into the state, so its `review` option went.
  const run = setup();
  const wake = {
    id: 'inner.wake:review:2026-10-19',
    kind: 'review',
    reason: 'review',
    intentionIds: [],
    chainId: 'review:2026-10-19',
    dueAt: NOW - MINUTE_MS,
    placeId: null,
    dmChat: false,
  };
  assert.deepEqual(run.inner.onWake({ kind: 'inner.wake', at: NOW, id: wake.id, wake }), { status: 'invalid' });
});

test('a whole day of ticks over her record draws no review and runs no review turn', async () => {
  // Bug: the scheduler still draws the day's review from the hours she speaks in and wakes her for it.
  const lines = Array.from({ length: 5 }, (_, d) => ({
    kind: 'said',
    occurredAt: new Date(Date.parse('2026-10-19T15:20:00Z') - (d + 1) * DAY_MS).toISOString(),
    scope: { channel: 'c3' },
  }));
  const record = {
    async *iterate() {
      for (const line of lines) yield await Promise.resolve(line);
    },
  };
  const run = setup({ record });
  for (let t = Date.parse('2026-10-19T08:00:00Z'); t <= Date.parse('2026-10-20T08:00:00Z'); t += 30 * MINUTE_MS) {
    clock.t = t;
    await run.inner.tick();
  }
  await settle();
  const { calls } = run.turns;
  assert.deepEqual(
    calls.filter(({ inner }) => inner.wake.kind === 'review'),
    []
  );
  assert.deepEqual(
    run.journal.filter((entry) => String(entry.event).startsWith('review')),
    []
  );
});
