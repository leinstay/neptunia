// Tests for src/behavior/turn-budget.ts: the figures of the wake view's turns line. The week is the UTC week from Monday,
// the credit of the core's keys is spread over four weeks, and a turn costs the median of the last seven days.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnsBudget, medianCost, turnsBudget, utcWeekOf } from '../src/behavior/turn-budget.ts';

const WEDNESDAY = Date.parse('2026-11-04T15:30:00Z');

test('utcWeekOf: the week runs Monday to Sunday UTC, and a Sunday evening is still its own week', () => {
  assert.equal(new Date(utcWeekOf(WEDNESDAY).start).toISOString(), '2026-11-02T00:00:00.000Z');
  assert.equal(new Date(utcWeekOf(WEDNESDAY).sunday).toISOString(), '2026-11-08T00:00:00.000Z');
  // Bug caught: the Sunday evening counted in the next week, so the line named a Sunday a week away.
  const sundayNight = Date.parse('2026-11-08T23:59:00Z');
  assert.equal(new Date(utcWeekOf(sundayNight).sunday).toISOString(), '2026-11-08T00:00:00.000Z');
  assert.equal(new Date(utcWeekOf(Date.parse('2026-11-09T00:00:00Z')).start).toISOString(), '2026-11-09T00:00:00.000Z');
});

test('medianCost: the middle of an odd list, the mean of the two middle of an even one, null without a cost', () => {
  assert.equal(medianCost([0.3, 0.1, 0.2]), 0.2);
  assert.equal(medianCost([0.4, 0.1, 0.2, 0.3]), 0.25);
  assert.equal(medianCost([]), null);
  // Bug caught: free or broken turns (0, NaN) dragging the median to nothing and the possible count to infinity.
  assert.equal(medianCost([0, Number.NaN, 0.5]), 0.5);
});

test('turnsBudget: a quarter of the summed balances over the median cost, floored, with the turns of the week so far', () => {
  const got = turnsBudget({ now: WEDNESDAY, balances: [100, 60], costs: [0.1, 0.2, 0.4], spent: 37 });
  // (100 + 60) / 4 = 40 USD for the week, 40 / 0.2 = 200 turns.
  assert.deepEqual(got, { until: Date.parse('2026-11-08T00:00:00Z'), spent: 37, possible: 200 });
});

test('turnsBudget: a key with no limit reported counts 0 and the line still renders', () => {
  const got = turnsBudget({ now: WEDNESDAY, balances: [null, 8], costs: [0.25], spent: 0 });
  assert.equal(got.possible, 8);
  assert.equal(turnsBudget({ now: WEDNESDAY, balances: [null], costs: [0.25], spent: 2 }).possible, 0);
});

test('turnsBudget: no cost history leaves the possible count unknown', () => {
  assert.equal(turnsBudget({ now: WEDNESDAY, balances: [100], costs: [], spent: 5 }).possible, null);
});

test('createTurnsBudget: counts the turn records since Monday, takes the inner costs of seven days, reads the keys at every call', async () => {
  const records: Record<string, Array<unknown>> = {
    'turn:2026-11-01': [{ occurredAt: '2026-11-01T10:00:00Z' }], // Sunday of the week before: not spent
    'turn:2026-11-02': [{ occurredAt: '2026-11-02T00:00:01Z' }, { occurredAt: '2026-11-02T12:00:00Z' }],
    'turn:2026-11-04': [{ occurredAt: '2026-11-04T09:00:00Z' }],
    'inner:2026-10-29': [{ event: 'turn', occurredAt: '2026-10-29T18:00:00Z', cost: { usd: 0.3 } }],
    'inner:2026-10-28': [{ event: 'turn', occurredAt: '2026-10-28T08:00:00Z', cost: { usd: 9 } }], // older than seven days
    'inner:2026-11-03': [
      { event: 'turn', occurredAt: '2026-11-03T08:00:00Z', cost: { usd: 0.1 } },
      { event: 'other', occurredAt: '2026-11-03T08:30:00Z', cost: { usd: 5 } },
    ],
  };
  let balance = 40;
  const source = createTurnsBudget({
    journal: { read: (_guild, { day, kind }) => Promise.resolve(records[`${kind}:${day}`] ?? []) },
    guildId: () => 'g1',
    keyBudgets: () => Promise.resolve([{ left: balance }, { left: null }]),
    now: () => WEDNESDAY,
  });
  // Bug caught: last week's Sunday counted as spent, or a record of another event feeding the median.
  assert.deepEqual(await source(), { until: Date.parse('2026-11-08T00:00:00Z'), spent: 3, possible: 50 });
  balance = 80;
  assert.equal((await source())?.possible, 100, 'the balance is read again at each wake, the journal is cached');
});

test('createTurnsBudget: no guild gives no line; a journal that fails leaves the possible count unknown', async () => {
  const none = createTurnsBudget({
    journal: null,
    guildId: () => null,
    keyBudgets: () => Promise.resolve([]),
    now: () => WEDNESDAY,
  });
  assert.equal(await none(), null);
  const broken = createTurnsBudget({
    journal: { read: () => Promise.reject(new Error('disk')) },
    guildId: () => 'g1',
    keyBudgets: () => Promise.resolve([{ left: 10 }]),
    now: () => WEDNESDAY,
  });
  assert.deepEqual(await broken(), { until: Date.parse('2026-11-08T00:00:00Z'), spent: 0, possible: null });
});
