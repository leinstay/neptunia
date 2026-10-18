// Tests for src/errands/costs.js: the agents' spend from the errand records, per agent and per
// window (today, the last 7 and the last 30 UTC days, today included). A run counts on the day
// its task was queued, its tokens and dollars on the day it ended; the transition lines of one
// task fold into its last one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COST_WINDOWS, KEEP_DAYS, agentCosts, costRecord, emptyTotals } from '../src/errands/costs.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-18T12:00:00Z');
const MIDNIGHT = Date.parse('2026-10-18T00:00:00Z');

/** A finished task record queued `queuedAgo` ms before NOW and ended `endedAgo` ms before it. */
function task(id, agent, queuedAgo, endedAgo, usage) {
  return { id, agent, createdAt: NOW - queuedAgo, endedAt: endedAgo === null ? null : NOW - endedAgo, state: endedAgo === null ? 'running' : 'done', usage: usage ?? null, goal: 'never kept' };
}

test('costRecord: keeps the id, agent, times and usage numbers only; null for a record with no id or agent', () => {
  const record = costRecord({ ...task('t1', 'web', 1000, 500, { input: 1200, output: 300, usd: 0.04, steps: 3, seconds: 9 }), requester: { userId: 'u1' } });
  assert.deepEqual(record, { id: 't1', agent: 'web', createdAt: NOW - 1000, endedAt: NOW - 500, usage: { input: 1200, output: 300, usd: 0.04 } });
  assert.deepEqual(costRecord(task('t2', 'web', 1000, null)), { id: 't2', agent: 'web', createdAt: NOW - 1000, endedAt: null, usage: null });
  assert.equal(costRecord({ agent: 'web' }), null);
  assert.equal(costRecord({ id: 't3' }), null);
  assert.equal(costRecord(null), null);
  const odd = costRecord({ id: 't4', agent: 'web', createdAt: 'x', endedAt: NOW, usage: { input: -1, output: 'a', usd: Infinity } });
  assert.deepEqual(odd, { id: 't4', agent: 'web', createdAt: null, endedAt: NOW, usage: { input: 0, output: 0, usd: 0 } });
});

test('agentCosts: runs by the day queued, tokens and dollars by the day ended, per window', () => {
  const records = [
    task('a', 'web', 1 * 60 * 60 * 1000, 1 * 60 * 60 * 1000 - 5000, { input: 1000, output: 100, usd: 0.1 }),
    // Queued yesterday, ended today: a run of the 7 days, its cost today's.
    task('b', 'web', 13 * 60 * 60 * 1000, 60 * 1000, { input: 2000, output: 200, usd: 0.2 }),
    task('c', 'web', 5 * DAY, 5 * DAY - 1000, { input: 4000, output: 400, usd: 0.4 }),
    task('d', 'server', 20 * DAY, 20 * DAY - 1000, { input: 8000, output: 800, usd: 0.8 }),
    // Older than 30 days: in no window.
    task('e', 'server', 40 * DAY, 40 * DAY - 1000, { input: 1, output: 1, usd: 9 }),
    // Still running: a run today, no cost yet.
    task('f', 'server', 1000, null),
  ].map(costRecord);
  const totals = agentCosts(records, { now: NOW });
  assert.deepEqual(Object.keys(totals).sort(), ['server', 'web']);
  const round = (row) => ({ ...row, usd: Math.round(row.usd * 1000) / 1000 });
  assert.deepEqual(round(totals.web.today), { runs: 1, input: 3000, output: 300, usd: 0.3 });
  assert.deepEqual(round(totals.web.last7), { runs: 3, input: 7000, output: 700, usd: 0.7 });
  assert.deepEqual(round(totals.web.last30), { runs: 3, input: 7000, output: 700, usd: 0.7 });
  assert.deepEqual(totals.server.today, { runs: 1, input: 0, output: 0, usd: 0 });
  assert.deepEqual(totals.server.last7, { runs: 1, input: 0, output: 0, usd: 0 });
  assert.deepEqual(round(totals.server.last30), { runs: 2, input: 8000, output: 800, usd: 0.8 });
});

test('agentCosts: a window is whole UTC days, today included; the future counts nowhere', () => {
  const records = [
    { id: 'x', agent: 'web', createdAt: MIDNIGHT, endedAt: MIDNIGHT, usage: { input: 1, output: 1, usd: 1 } },
    { id: 'y', agent: 'web', createdAt: MIDNIGHT - 1, endedAt: MIDNIGHT - 1, usage: { input: 1, output: 1, usd: 2 } },
    { id: 'z', agent: 'web', createdAt: MIDNIGHT - 6 * DAY, endedAt: MIDNIGHT - 6 * DAY, usage: { input: 1, output: 1, usd: 4 } },
    { id: 'w', agent: 'web', createdAt: MIDNIGHT - 6 * DAY - 1, endedAt: MIDNIGHT - 6 * DAY - 1, usage: { input: 1, output: 1, usd: 8 } },
    { id: 'v', agent: 'web', createdAt: NOW + DAY, endedAt: NOW + DAY, usage: { input: 1, output: 1, usd: 16 } },
  ];
  const { web } = agentCosts(records, { now: NOW });
  assert.equal(web.today.usd, 1);
  assert.equal(web.today.runs, 1);
  assert.equal(web.last7.usd, 1 + 2 + 4);
  assert.equal(web.last30.usd, 1 + 2 + 4 + 8);
  assert.equal(web.last30.runs, 4);
});

test('agentCosts: the transition lines of one task count once, as its last line says', () => {
  const queued = { id: 'a', agent: 'web', createdAt: NOW - 5000, endedAt: null, usage: null };
  const done = { ...queued, endedAt: NOW - 1000, usage: { input: 10, output: 5, usd: 0.05 } };
  const { web } = agentCosts([queued, done], { now: NOW });
  assert.deepEqual(web.today, { runs: 1, input: 10, output: 5, usd: 0.05 });
});

test('agentCosts: the agents asked for are always there, empty when they have no record; odd records are skipped', () => {
  const totals = agentCosts([null, { id: 'q' }, { id: 'r', agent: 'web', createdAt: NOW, endedAt: null, usage: null }], { now: NOW, agents: ['web', 'dev'] });
  assert.deepEqual(Object.keys(totals), ['web', 'dev']);
  assert.deepEqual(totals.dev, emptyTotals());
  assert.equal(totals.web.today.runs, 1);
  assert.deepEqual(agentCosts(null, { now: NOW }), {});
});

test('the windows are today, the last 7 and the last 30 days; the records kept cover the longest', () => {
  assert.deepEqual(COST_WINDOWS.map(([name, days]) => [name, days]), [['today', 1], ['last7', 7], ['last30', 30]]);
  assert.ok(KEEP_DAYS >= 30);
  assert.deepEqual(Object.keys(emptyTotals()), ['today', 'last7', 'last30']);
});
