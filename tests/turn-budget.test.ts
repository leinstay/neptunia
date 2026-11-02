// Tests for src/behavior/turn-budget.ts: the figures of the wake view's turns line. The week is the UTC week from Monday,
// the credit of the core's keys is spread over four weeks, and a turn costs the median of the last seven days.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTurnsBudget, meanCost, turnsBudget, utcWeekOf } from '../src/behavior/turn-budget.ts';
import { createUsage } from '../src/tools/impl/usage.ts';

const WEDNESDAY = Date.parse('2026-11-04T15:30:00Z');

test('utcWeekOf: the week runs Monday to Sunday UTC, and a Sunday evening is still its own week', () => {
  assert.equal(new Date(utcWeekOf(WEDNESDAY).start).toISOString(), '2026-11-02T00:00:00.000Z');
  assert.equal(new Date(utcWeekOf(WEDNESDAY).sunday).toISOString(), '2026-11-08T00:00:00.000Z');
  // Bug caught: the Sunday evening counted in the next week, so the line named a Sunday a week away.
  const sundayNight = Date.parse('2026-11-08T23:59:00Z');
  assert.equal(new Date(utcWeekOf(sundayNight).sunday).toISOString(), '2026-11-08T00:00:00.000Z');
  assert.equal(new Date(utcWeekOf(Date.parse('2026-11-09T00:00:00Z')).start).toISOString(), '2026-11-09T00:00:00.000Z');
});

test('meanCost: the total over the requests, null without a request or without a cost', () => {
  assert.equal(meanCost(3, 12), 0.25);
  assert.equal(meanCost(3, 0), null);
  // Bug caught: a free day (cost 0) reading as a zero-cost turn, which makes the possible count infinite.
  assert.equal(meanCost(0, 5), null);
  assert.equal(meanCost(Number.NaN, 5), null);
});

test('turnsBudget: a quarter of the summed balances over the mean request cost, floored, with the turns of the week so far', () => {
  const got = turnsBudget({ now: WEDNESDAY, balances: [100, 60], cost: 0.2, spent: 37 });
  // (100 + 60) / 4 = 40 USD for the week, 40 / 0.2 = 200 turns.
  assert.deepEqual(got, { until: Date.parse('2026-11-08T00:00:00Z'), spent: 37, possible: 200 });
});

test('turnsBudget: a key with no limit reported counts 0 and the line still renders', () => {
  assert.equal(turnsBudget({ now: WEDNESDAY, balances: [null, 8], cost: 0.25, spent: 0 }).possible, 8);
  assert.equal(turnsBudget({ now: WEDNESDAY, balances: [null], cost: 0.25, spent: 2 }).possible, 0);
});

test('turnsBudget: no cost leaves the possible count unknown', () => {
  assert.equal(turnsBudget({ now: WEDNESDAY, balances: [100], cost: null, spent: 5 }).possible, null);
});

test('createTurnsBudget: the week counts the core requests since Monday, the cost is the mean of seven days, other roles do not count', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'turns-'));
  const clock = { at: Date.parse('2026-10-29T12:00:00Z') }; // Thursday of the week before
  const usage = createUsage({ dataDir: dir, now: () => clock.at });
  for (let i = 0; i < 10; i += 1) usage.record({ role: 'core', cost: 0.5 });
  clock.at = Date.parse('2026-11-03T12:00:00Z'); // Tuesday
  for (let i = 0; i < 10; i += 1) usage.record({ role: 'core', cost: 0.1 });
  usage.record({ role: 'analyzer', cost: 50 });
  clock.at = WEDNESDAY;
  usage.record({ role: 'core', cost: 0.1 });
  let balance = 40;
  const source = createTurnsBudget({
    usage,
    keyBalances: () => [{ left: balance }, { left: null }],
    now: () => clock.at,
  });
  // Bug caught: last week's requests counted as spent, or the analyzer's spend inflating the cost of a turn.
  // Seven days back from Wednesday reach Thursday: 10 * 0.5 + 11 * 0.1 = 6.1 over 21 requests.
  const got = await source();
  assert.equal(got.spent, 11);
  assert.equal(got.possible, Math.floor(40 / 4 / (6.1 / 21)));
  balance = 80;
  assert.equal((await source()).possible, Math.floor(80 / 4 / (6.1 / 21)), 'the balance is read at each call');
});

test('createTurnsBudget: no core request in seven days leaves the possible count unknown', async () => {
  const usage = createUsage({
    dataDir: fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'turns-')),
    now: () => WEDNESDAY,
  });
  const source = createTurnsBudget({ usage, keyBalances: () => [{ left: 10 }], now: () => WEDNESDAY });
  assert.deepEqual(await source(), { until: Date.parse('2026-11-08T00:00:00Z'), spent: 0, possible: null });
});
