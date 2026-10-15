// The costs field of the owner's /nep status card: today's per-role accumulator fed by the
// `llm: usage` log lines (src/ops/usage.js), the OpenRouter key and credits reads, and the pure
// renderer over every key shape the owner may set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createUsage, usageTap, costsLines, readAccount, compactTokens, USAGE_FILE } from '../src/ops/usage.js';
import { createLlm } from '../src/llm/openrouter.js';

const HOUR = 3_600_000;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nep-usage-'));
}

/** A clock the test moves by hand. */
function clock(start = Date.parse('2026-10-15T12:00:00.000Z')) {
  const state = { at: start };
  const now = () => state.at;
  now.advance = (ms) => {
    state.at += ms;
  };
  return now;
}

/** Terse fixture wording for the renderer: not shipped text. */
const LABELS = {
  status: {
    costs: {
      keyLimit: 'key {spent}/{limit} ({notes})',
      keyLimitPlain: 'key {spent}/{limit}',
      keyNone: 'key none, used {used}',
      keyNonePlain: 'key none',
      keyUnavailable: 'key unavailable: {reason}',
      resets: 'resets {interval}',
      resetsAt: 'resets {interval} at {at}',
      neverResets: 'never resets',
      intervals: { daily: 'day', weekly: 'week', monthly: 'month' },
      byokCounted: 'byok in',
      byokNotCounted: 'byok out',
      noteSeparator: '; ',
      usage: 'usage {parts}',
      usageToday: 'D {usd}',
      usageWeek: 'W {usd}',
      usageMonth: 'M {usd}',
      partSeparator: ' | ',
      credits: 'credits {left} left of {bought}, {used} used',
      creditsUnavailable: 'credits unavailable: {reason}',
      reasons: { timeout: 'slow', network: 'net', http: 'http {status}', noClient: 'none', badAnswer: 'odd' },
      byRoleHeader: 'by role',
      byRoleEmpty: 'by role: nothing',
      role: '{role} {requests} in {in} c {cached} out {out} = {cost}',
      total: 'total {requests} in {in} c {cached} out {out} = {cost}',
    },
  },
};

const ok = (data) => ({ ok: true, data });
const KEY_DAILY = {
  label: 'sk-or-v1-secret',
  limit: 30,
  limit_reset: 'daily',
  limit_remaining: 21.54,
  include_byok_in_limit: true,
  budgets: [{ scope: 'key_limit', limit_usd: 30, spend_usd: 8.45, remaining_usd: 21.55, reset_interval: 'daily', resets_at: '2026-10-16T00:00:00.000Z', include_byok: true }],
  usage: 52.3,
  usage_daily: 0.1,
  usage_weekly: 3.41,
  usage_monthly: 12,
};
const CREDITS = ok({ total_credits: 132, total_usage: 121.64 });

/** The key and usage lines only (the credits line and the empty day dropped). */
function keyLines(key) {
  return costsLines({ key, credits: CREDITS, rows: [], labels: LABELS }).slice(0, -2);
}

// ---- the renderer ------------------------------------------------------------------

test('costsLines: a daily budget shows spend over limit, the reset time and BYOK, then usage, credits and the empty day', () => {
  assert.deepEqual(costsLines({ key: ok(KEY_DAILY), credits: CREDITS, rows: [], labels: LABELS }), [
    'key 8.45/30.00 (resets day at 2026-10-16 00:00 UTC; byok in)',
    'usage D 0.10 | W 3.41 | M 12.00',
    'credits 10.36 left of 132.00, 121.64 used',
    'by role: nothing',
  ]);
});

test('costsLines: never prints the key label', () => {
  const text = costsLines({ key: ok(KEY_DAILY), credits: CREDITS, rows: [], labels: LABELS }).join('\n');
  assert.ok(!text.includes('sk-or'), 'no key label');
});

test('costsLines: a weekly and a monthly reset, BYOK left out of the limit', () => {
  for (const [interval, word] of [['weekly', 'week'], ['monthly', 'month']]) {
    const key = { limit: 50, limit_reset: interval, limit_remaining: 40, include_byok_in_limit: false };
    assert.deepEqual(keyLines(ok(key)), [`key 10.00/50.00 (resets ${word}; byok out)`], interval);
  }
});

test('costsLines: a limit that never resets, an unknown interval as its code, a missing reset with no note', () => {
  assert.deepEqual(keyLines(ok({ limit: 20, limit_reset: null, limit_remaining: 5 })), ['key 15.00/20.00 (never resets)']);
  assert.deepEqual(keyLines(ok({ limit: 20, limit_reset: 'hourly', limit_remaining: 5 })), ['key 15.00/20.00 (resets hourly)']);
  assert.deepEqual(keyLines(ok({ limit: 20, limit_remaining: 5 })), ['key 15.00/20.00'], 'no reset field, no BYOK field: no notes');
});

test('costsLines: budgets missing or empty fall back to the top-level fields; the spend from the interval usage when no remainder', () => {
  assert.deepEqual(keyLines(ok({ limit: 30, limit_reset: 'daily', budgets: [], usage_daily: 2.5 })), ['key 2.50/30.00 (resets day)', 'usage D 2.50']);
  assert.deepEqual(keyLines(ok({ limit: 30, limit_reset: 'daily' })), ['key -/30.00 (resets day)'], 'no spend known');
});

test('costsLines: the effective budget stands in when no budget is the key limit', () => {
  const key = { limit: null, budgets: [{ scope: 'other', limit_usd: 9 }], effective_budget: { limit_usd: 10, spend_usd: 1, reset_interval: 'weekly' } };
  assert.deepEqual(keyLines(ok(key)), ['key 1.00/10.00 (resets week)']);
});

test('costsLines: no limit shows the total used, or nothing more when even that is missing', () => {
  assert.deepEqual(keyLines(ok({ limit: null, limit_reset: null, budgets: [], usage: 52.314 })), ['key none, used 52.31']);
  assert.deepEqual(keyLines(ok({})), ['key none']);
});

test('costsLines: a failed read of the key or the credits says why', () => {
  const lines = costsLines({
    key: { ok: false, reason: 'http', status: 401 },
    credits: { ok: false, reason: 'timeout' },
    rows: [],
    labels: LABELS,
  });
  assert.deepEqual(lines, ['key unavailable: http 401', 'credits unavailable: slow', 'by role: nothing']);
  const more = costsLines({ key: { ok: false, reason: 'network' }, credits: { ok: false, reason: 'no-client' }, rows: [], labels: LABELS });
  assert.deepEqual(more.slice(0, 2), ['key unavailable: net', 'credits unavailable: none']);
  const odd = costsLines({ key: { ok: false, reason: 'bad-answer' }, credits: ok({ total_credits: 'x' }), rows: [], labels: LABELS });
  assert.deepEqual(odd.slice(0, 2), ['key unavailable: odd', 'credits unavailable: odd'], 'credits with no numbers');
});

test('costsLines: one line per role in the given order, then the total', () => {
  const rows = [
    { role: 'voice', requests: 38, promptTokens: 974_000, cachedTokens: 342_000, completionTokens: 9_300, cost: 4.03 },
    { role: 'analyzer', requests: 12, promptTokens: 51_200, cachedTokens: 0, completionTokens: 812, cost: 0.2 },
  ];
  assert.deepEqual(costsLines({ key: ok({}), credits: CREDITS, rows, labels: LABELS }).slice(2), [
    'by role',
    'voice 38 in 974k c 342k out 9.3k = 4.03',
    'analyzer 12 in 51k c 0 out 812 = 0.20',
    'total 50 in 1.03M c 342k out 10k = 4.23',
  ]);
});

test('costsLines: no labels, no lines; a missing label leaves its line out', () => {
  assert.deepEqual(costsLines({ key: ok(KEY_DAILY), credits: CREDITS, rows: [], labels: {} }), []);
  const partial = { status: { costs: { ...LABELS.status.costs, usage: undefined } } };
  assert.deepEqual(costsLines({ key: ok(KEY_DAILY), credits: CREDITS, rows: [], labels: partial }).length, 3, 'no usage line');
});

test('compactTokens: plain below a thousand, one decimal below ten thousand, whole k, then M', () => {
  assert.deepEqual([0, 812, 9_300, 10_000, 974_000, 999_700, 1_234_567].map(compactTokens), ['0', '812', '9.3k', '10k', '974k', '1.00M', '1.23M']);
});

// ---- the account reads ---------------------------------------------------------------

test('readAccount: the data of a 2xx answer, else the reason', async () => {
  assert.deepEqual(await readAccount(async () => ({ ok: true, status: 200, json: { data: { limit: 1 } } })), { ok: true, data: { limit: 1 } });
  assert.deepEqual(await readAccount(async () => ({ ok: false, status: 403, json: null })), { ok: false, reason: 'http', status: 403 });
  assert.deepEqual(await readAccount(async () => ({ ok: true, status: 200, json: null })), { ok: false, reason: 'bad-answer' });
  assert.deepEqual(await readAccount(null), { ok: false, reason: 'no-client' });
  const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
  assert.deepEqual(await readAccount(async () => { throw timeout; }), { ok: false, reason: 'timeout' });
  assert.deepEqual(await readAccount(async () => { throw new TypeError('fetch failed'); }), { ok: false, reason: 'network' });
});

test('createLlm: keyInfo and credits are one GET each with the key and a timeout; nothing counted', async () => {
  const calls = [];
  const state = {
    data: {},
    markDirty() {
      this.dirty = true;
    },
  };
  const llm = createLlm({
    apiKey: 'k-test',
    getConfig: () => ({ llm: { baseUrl: 'https://openrouter.ai/api/v1/', timeoutMs: 5000, maxRequestsPerDay: 1 } }),
    calibrator: { observe() {} },
    state,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ data: { ok: 1 } }) };
    },
  });
  assert.deepEqual(await llm.keyInfo({ timeoutMs: 1234 }), { ok: true, status: 200, json: { data: { ok: 1 } } });
  assert.deepEqual(await llm.keyInfo({ timeoutMs: 1234, apiKey: 'sim-test' }), { ok: true, status: 200, json: { data: { ok: 1 } } });
  assert.equal(calls.pop().init.headers.Authorization, 'Bearer sim-test', 'another key for this one GET');
  assert.deepEqual(await llm.credits({ timeoutMs: 1234 }), { ok: true, status: 200, json: { data: { ok: 1 } } });
  assert.deepEqual(calls.map((call) => call.url), ['https://openrouter.ai/api/v1/key', 'https://openrouter.ai/api/v1/credits']);
  for (const call of calls) {
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.headers.Authorization, 'Bearer k-test');
    assert.ok(call.init.signal instanceof AbortSignal);
  }
  assert.deepEqual(state.data, {}, 'the daily counter is untouched');
  assert.equal(state.dirty, undefined);
});

// ---- the accumulator ------------------------------------------------------------------

test('usage: requests add up per role, the cost is the upstream cost when there is one, ordered by cost', () => {
  const usage = createUsage({ dataDir: tmpDir(), now: clock() });
  const tap = usageTap(usage);
  tap({ msg: 'llm: usage', role: 'analyzer', promptTokens: 1000, cachedTokens: null, completionTokens: 50, cost: 0.01, upstreamCost: null });
  tap({ msg: 'llm: usage', role: 'voice', promptTokens: 20000, cachedTokens: 8000, completionTokens: 300, cost: 0.002, upstreamCost: 0.5, byok: true });
  tap({ msg: 'llm: usage', role: 'voice', promptTokens: 10000, cachedTokens: 2000, completionTokens: 100, cost: 0.3 });
  tap({ msg: 'llm: usage', role: null, promptTokens: 5 });
  tap({ msg: 'turn: sent', role: 'voice', promptTokens: 999 });
  tap(null);
  assert.deepEqual(usage.byRole(), [
    { role: 'voice', requests: 2, promptTokens: 30000, cachedTokens: 10000, completionTokens: 400, cost: 0.8 },
    { role: 'analyzer', requests: 1, promptTokens: 1000, cachedTokens: 0, completionTokens: 50, cost: 0.01 },
    { role: 'other', requests: 1, promptTokens: 5, cachedTokens: 0, completionTokens: 0, cost: 0 },
  ]);
});

test('usage: a generated picture counts under drawing with its cost and no tokens', () => {
  const usage = createUsage({ dataDir: tmpDir(), now: clock() });
  const tap = usageTap(usage);
  tap({ msg: 'images: generated', model: 'x/img', family: 'openai', seconds: 12.5, cost: 0.04, bytes: 1000, reference: true });
  tap({ msg: 'images: generated', model: 'x/img', cost: null, bytes: 900 });
  tap({ msg: 'llm: usage', role: 'voice', promptTokens: 100, completionTokens: 5, cost: 0.01 });
  assert.deepEqual(usage.byRole(), [
    { role: 'drawing', requests: 2, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0.04 },
    { role: 'voice', requests: 1, promptTokens: 100, cachedTokens: 0, completionTokens: 5, cost: 0.01 },
  ]);
});

test('costsLines: a role with no tokens shows them as -', () => {
  const rows = [
    { role: 'drawing', requests: 3, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0.12 },
    { role: 'voice', requests: 1, promptTokens: 100, cachedTokens: 0, completionTokens: 5, cost: 0.01 },
  ];
  assert.deepEqual(costsLines({ key: ok({}), credits: CREDITS, rows, labels: LABELS }).slice(3), [
    'drawing 3 in - c - out - = 0.12',
    'voice 1 in 100 c 0 out 5 = 0.01',
    'total 4 in 100 c 0 out 5 = 0.13',
  ]);
});

test('usage: equal costs order by requests, then by role name', () => {
  const usage = createUsage({ dataDir: tmpDir(), now: clock() });
  for (const role of ['b', 'a', 'c', 'c']) usage.record({ role, cost: 0 });
  assert.deepEqual(usage.byRole().map((row) => row.role), ['c', 'a', 'b']);
});

test('usage: the UTC day rolls over at midnight and only today and yesterday are kept', async () => {
  const dataDir = tmpDir();
  const now = clock(Date.parse('2026-10-14T23:00:00.000Z'));
  const usage = createUsage({ dataDir, now });
  usage.record({ role: 'voice', promptTokens: 10, cost: 1 });
  now.advance(2 * HOUR);
  assert.deepEqual(usage.byRole(), [], 'a new day starts empty');
  usage.record({ role: 'voice', promptTokens: 20, cost: 2 });
  assert.equal(usage.byRole()[0].promptTokens, 20);
  await usage.save({ force: true });
  const daysOnDisk = () => Object.keys(JSON.parse(fs.readFileSync(path.join(dataDir, USAGE_FILE), 'utf8')).days).sort();
  assert.deepEqual(daysOnDisk(), ['2026-10-14', '2026-10-15']);
  now.advance(24 * HOUR);
  usage.record({ role: 'voice', cost: 3 });
  await usage.save({ force: true });
  assert.deepEqual(daysOnDisk(), ['2026-10-15', '2026-10-16']);
});

test('usage: the day survives a restart through the file; a broken file starts empty', async () => {
  const dataDir = tmpDir();
  const now = clock();
  const first = createUsage({ dataDir, now });
  first.record({ role: 'voice', promptTokens: 100, cachedTokens: 40, completionTokens: 7, cost: 0.25 });
  assert.equal(await first.save(), true);
  assert.equal(await first.save(), false, 'nothing new, no write');
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, USAGE_FILE), 'utf8'));
  assert.deepEqual(saved, { v: 1, days: { '2026-10-15': { voice: { requests: 1, promptTokens: 100, cachedTokens: 40, completionTokens: 7, cost: 0.25 } } } });
  const second = createUsage({ dataDir, now });
  assert.deepEqual(second.byRole(), [{ role: 'voice', requests: 1, promptTokens: 100, cachedTokens: 40, completionTokens: 7, cost: 0.25 }]);

  fs.writeFileSync(path.join(dataDir, USAGE_FILE), '{not json');
  const warnings = [];
  const third = createUsage({ dataDir, now, log: { warn: (msg, meta) => warnings.push({ msg, meta }) } });
  assert.deepEqual(third.byRole(), []);
  assert.equal(warnings.length, 1);
});

test('usage: a save within a minute of the last waits unless forced', async () => {
  const now = clock();
  const usage = createUsage({ dataDir: tmpDir(), now });
  usage.record({ role: 'voice', cost: 1 });
  assert.equal(await usage.save(), true);
  usage.record({ role: 'voice', cost: 1 });
  assert.equal(await usage.save(), false);
  assert.equal(await usage.save({ force: true }), true);
});

test('costsLines: the simulator key line comes right after the key line, through the same renderer; not set says so', () => {
  const labels = {
    status: {
      costs: {
        ...LABELS.status.costs,
        keyLead: 'key',
        simKeyLead: 'sim',
        simKeyNotSet: 'sim: not set',
        keyLimit: '{lead} limit {spent}/{limit} ({notes})',
        keyUnavailable: '{lead} limit unavailable: {reason}',
      },
    },
  };
  const simKey = ok({ limit: 5, limit_remaining: 4, limit_reset: null });
  const withSim = costsLines({ key: ok({ limit: 30, limit_remaining: 21, limit_reset: null }), sim: simKey, credits: CREDITS, rows: [], labels });
  assert.deepEqual(withSim.slice(0, 2), ['key limit 9.00/30.00 (never resets)', 'sim limit 1.00/5.00 (never resets)'], 'same renderer, other lead word');
  const notSet = costsLines({ key: ok({ limit: 30, limit_remaining: 21, limit_reset: null }), sim: null, credits: CREDITS, rows: [], labels });
  assert.equal(notSet[1], 'sim: not set');
  const failed = costsLines({ key: ok({}), sim: { ok: false, reason: 'http', status: 401 }, credits: CREDITS, rows: [], labels });
  assert.ok(failed.includes('sim limit unavailable: http 401'));
});
