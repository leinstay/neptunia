// The costs fields of the owner's /nep status card (keys.base, costs.base, costs.errands, costs.development): today's per-role accumulator fed by the
// `llm: usage` log lines (src/ops/usage.js), the OpenRouter key reads, and the pure renderers
// over every key shape the owner may set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  createUsage,
  usageTap,
  agentCostsLines,
  keyCostsLines,
  roleCostsLines,
  readAccount,
  readActivity,
  activitySums,
  compactTokens,
  USAGE_FILE,
  KEEP_DAYS,
} from '../src/ops/usage.js';
import { createLlm, keyHashOf } from '../src/llm/openrouter.js';
import { tempDir } from './fixtures/tmp.js';

const HOUR = 3_600_000;

function tmpDir() {
  return tempDir('nep-usage-');
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
      last7: 'L7 {usd}{since}',
      last30: 'L30 {usd}{since}',
      since: ' from {day}',
      partSeparator: ' | ',
      reasons: { timeout: 'slow', network: 'net', http: 'http {status}', noClient: 'none', badAnswer: 'odd' },
      byRoleEmpty: 'by role: nothing',
      role: '{role} {requests} in {in} c {cached} out {out} = {cost}',
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
  budgets: [
    {
      scope: 'key_limit',
      limit_usd: 30,
      spend_usd: 8.45,
      remaining_usd: 21.55,
      reset_interval: 'daily',
      resets_at: '2026-10-16T00:00:00.000Z',
      include_byok: true,
    },
  ],
  usage: 52.3,
  usage_daily: 0.1,
  usage_weekly: 3.41,
  usage_monthly: 12,
};
/** The main key's lines (no simulator label in the fixture: no simulator line). */
function keyLines(key) {
  return keyCostsLines({ key, labels: LABELS });
}

// ---- the renderers -----------------------------------------------------------------

test('keyCostsLines: a daily budget shows spend over limit, the reset time and BYOK, then usage today only (never the calendar week or month); no credits line', () => {
  assert.deepEqual(keyCostsLines({ key: ok(KEY_DAILY), labels: LABELS }), [
    'key 8.45/30.00 (resets day at 2026-10-16 00:00 UTC; byok in)',
    'usage D 0.10',
  ]);
});

test('keyCostsLines: never prints the key label', () => {
  const text = keyCostsLines({ key: ok(KEY_DAILY), labels: LABELS }).join('\n');
  assert.ok(!text.includes('sk-or'), 'no key label');
});

test('keyCostsLines: a weekly and a monthly reset, BYOK left out of the limit', () => {
  for (const [interval, word] of [
    ['weekly', 'week'],
    ['monthly', 'month'],
  ]) {
    const key = { limit: 50, limit_reset: interval, limit_remaining: 40, include_byok_in_limit: false };
    assert.deepEqual(keyLines(ok(key)), [`key 10.00/50.00 (resets ${word}; byok out)`], interval);
  }
});

test('keyCostsLines: a limit that never resets, an unknown interval as its code, a missing reset with no note', () => {
  assert.deepEqual(keyLines(ok({ limit: 20, limit_reset: null, limit_remaining: 5 })), [
    'key 15.00/20.00 (never resets)',
  ]);
  assert.deepEqual(keyLines(ok({ limit: 20, limit_reset: 'hourly', limit_remaining: 5 })), [
    'key 15.00/20.00 (resets hourly)',
  ]);
  assert.deepEqual(
    keyLines(ok({ limit: 20, limit_remaining: 5 })),
    ['key 15.00/20.00'],
    'no reset field, no BYOK field: no notes'
  );
});

test('keyCostsLines: budgets missing or empty fall back to the top-level fields; the spend from the interval usage when no remainder', () => {
  assert.deepEqual(keyLines(ok({ limit: 30, limit_reset: 'daily', budgets: [], usage_daily: 2.5 })), [
    'key 2.50/30.00 (resets day)',
    'usage D 2.50',
  ]);
  assert.deepEqual(keyLines(ok({ limit: 30, limit_reset: 'daily' })), ['key -/30.00 (resets day)'], 'no spend known');
});

test('keyCostsLines: the effective budget stands in when no budget is the key limit', () => {
  const key = {
    limit: null,
    budgets: [{ scope: 'other', limit_usd: 9 }],
    effective_budget: { limit_usd: 10, spend_usd: 1, reset_interval: 'weekly' },
  };
  assert.deepEqual(keyLines(ok(key)), ['key 1.00/10.00 (resets week)']);
});

test('keyCostsLines: no limit shows the total used, or nothing more when even that is missing', () => {
  assert.deepEqual(keyLines(ok({ limit: null, limit_reset: null, budgets: [], usage: 52.314 })), [
    'key none, used 52.31',
  ]);
  assert.deepEqual(keyLines(ok({})), ['key none']);
});

test('keyCostsLines: a failed read of the key says why', () => {
  assert.deepEqual(keyCostsLines({ key: { ok: false, reason: 'http', status: 401 }, labels: LABELS }), [
    'key unavailable: http 401',
  ]);
  assert.deepEqual(keyCostsLines({ key: { ok: false, reason: 'network' }, labels: LABELS }), ['key unavailable: net']);
  assert.deepEqual(keyCostsLines({ key: { ok: false, reason: 'bad-answer' }, labels: LABELS }), [
    'key unavailable: odd',
  ]);
});

test('roleCostsLines: one line per role in the given order, no header and no total; the empty day says so', () => {
  const rows = [
    { role: 'core', requests: 38, promptTokens: 974_000, cachedTokens: 342_000, completionTokens: 9_300, cost: 4.03 },
    { role: 'analyzer', requests: 12, promptTokens: 51_200, cachedTokens: 0, completionTokens: 812, cost: 0.2 },
  ];
  assert.deepEqual(roleCostsLines({ rows, labels: LABELS }), [
    'core 38 in 974k c 342k out 9.3k = 4.03',
    'analyzer 12 in 51k c 0 out 812 = 0.20',
  ]);
  assert.deepEqual(roleCostsLines({ rows: [], labels: LABELS }), ['by role: nothing']);
});

test('keyCostsLines / roleCostsLines: no labels, no lines; a missing label leaves its line out', () => {
  assert.deepEqual(keyCostsLines({ key: ok(KEY_DAILY), labels: {} }), []);
  assert.deepEqual(roleCostsLines({ rows: [], labels: {} }), []);
  const partial = { status: { costs: { ...LABELS.status.costs, usage: undefined } } };
  assert.deepEqual(keyCostsLines({ key: ok(KEY_DAILY), labels: partial }).length, 1, 'no usage line');
});

test('compactTokens: plain below a thousand, one decimal below ten thousand, whole k, then M', () => {
  assert.deepEqual([0, 812, 9_300, 10_000, 974_000, 999_700, 1_234_567].map(compactTokens), [
    '0',
    '812',
    '9.3k',
    '10k',
    '974k',
    '1.00M',
    '1.23M',
  ]);
});

// ---- the account reads ---------------------------------------------------------------

test('readAccount: the data of a 2xx answer, else the reason', async () => {
  assert.deepEqual(await readAccount(async () => ({ ok: true, status: 200, json: { data: { limit: 1 } } })), {
    ok: true,
    data: { limit: 1 },
  });
  assert.deepEqual(await readAccount(async () => ({ ok: false, status: 403, json: null })), {
    ok: false,
    reason: 'http',
    status: 403,
  });
  assert.deepEqual(await readAccount(async () => ({ ok: true, status: 200, json: null })), {
    ok: false,
    reason: 'bad-answer',
  });
  assert.deepEqual(await readAccount(null), { ok: false, reason: 'no-client' });
  const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
  assert.deepEqual(
    await readAccount(async () => {
      throw timeout;
    }),
    { ok: false, reason: 'timeout' }
  );
  assert.deepEqual(
    await readAccount(async () => {
      throw new TypeError('fetch failed');
    }),
    { ok: false, reason: 'network' }
  );
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
  assert.deepEqual(await llm.keyInfo({ timeoutMs: 1234, apiKey: 'sim-test' }), {
    ok: true,
    status: 200,
    json: { data: { ok: 1 } },
  });
  assert.equal(calls.pop().init.headers.Authorization, 'Bearer sim-test', 'another key for this one GET');
  assert.deepEqual(await llm.credits({ timeoutMs: 1234 }), { ok: true, status: 200, json: { data: { ok: 1 } } });
  assert.deepEqual(
    calls.map((call) => call.url),
    ['https://openrouter.ai/api/v1/key', 'https://openrouter.ai/api/v1/credits']
  );
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
  tap({
    msg: 'llm: usage',
    role: 'analyzer',
    promptTokens: 1000,
    cachedTokens: null,
    completionTokens: 50,
    cost: 0.01,
    upstreamCost: null,
  });
  tap({
    msg: 'llm: usage',
    role: 'core',
    promptTokens: 20000,
    cachedTokens: 8000,
    completionTokens: 300,
    cost: 0.002,
    upstreamCost: 0.5,
    byok: true,
  });
  tap({ msg: 'llm: usage', role: 'core', promptTokens: 10000, cachedTokens: 2000, completionTokens: 100, cost: 0.3 });
  tap({ msg: 'llm: usage', role: null, promptTokens: 5 });
  tap({ msg: 'turn: sent', role: 'core', promptTokens: 999 });
  tap(null);
  assert.deepEqual(usage.byRole(), [
    { role: 'core', requests: 2, promptTokens: 30000, cachedTokens: 10000, completionTokens: 400, cost: 0.8 },
    { role: 'analyzer', requests: 1, promptTokens: 1000, cachedTokens: 0, completionTokens: 50, cost: 0.01 },
    { role: 'other', requests: 1, promptTokens: 5, cachedTokens: 0, completionTokens: 0, cost: 0 },
  ]);
});

test('usage: a generated picture counts under drawing with its cost and no tokens', () => {
  const usage = createUsage({ dataDir: tmpDir(), now: clock() });
  const tap = usageTap(usage);
  tap({
    msg: 'images: generated',
    model: 'x/img',
    family: 'openai',
    seconds: 12.5,
    cost: 0.04,
    bytes: 1000,
    reference: true,
  });
  tap({ msg: 'images: generated', model: 'x/img', cost: null, bytes: 900 });
  tap({ msg: 'llm: usage', role: 'core', promptTokens: 100, completionTokens: 5, cost: 0.01 });
  assert.deepEqual(usage.byRole(), [
    { role: 'drawing', requests: 2, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0.04 },
    { role: 'core', requests: 1, promptTokens: 100, cachedTokens: 0, completionTokens: 5, cost: 0.01 },
  ]);
});

test('roleCostsLines: a role with no tokens shows them as -', () => {
  const rows = [
    { role: 'drawing', requests: 3, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0.12 },
    { role: 'core', requests: 1, promptTokens: 100, cachedTokens: 0, completionTokens: 5, cost: 0.01 },
  ];
  assert.deepEqual(roleCostsLines({ rows, labels: LABELS }), [
    'drawing 3 in - c - out - = 0.12',
    'core 1 in 100 c 0 out 5 = 0.01',
  ]);
});

test('usage: equal costs order by requests, then by role name', () => {
  const usage = createUsage({ dataDir: tmpDir(), now: clock() });
  for (const role of ['b', 'a', 'c', 'c']) usage.record({ role, cost: 0 });
  assert.deepEqual(
    usage.byRole().map((row) => row.role),
    ['c', 'a', 'b']
  );
});

test('usage: the UTC day rolls over at midnight; the last 31 days are kept and day 32 is dropped', async () => {
  const dataDir = tmpDir();
  const now = clock(Date.parse('2026-10-14T23:00:00.000Z'));
  const usage = createUsage({ dataDir, now });
  usage.record({ role: 'core', promptTokens: 10, cost: 1 });
  now.advance(2 * HOUR);
  assert.deepEqual(usage.byRole(), [], 'a new day starts empty');
  usage.record({ role: 'core', promptTokens: 20, cost: 2 });
  assert.equal(usage.byRole()[0].promptTokens, 20);
  await usage.save({ force: true });
  const daysOnDisk = () => Object.keys(JSON.parse(fs.readFileSync(path.join(dataDir, USAGE_FILE), 'utf8')).days).sort();
  assert.deepEqual(daysOnDisk(), ['2026-10-14', '2026-10-15']);
  assert.equal(KEEP_DAYS, 31);
  now.advance(29 * 24 * HOUR); // 2026-11-13: 2026-10-14 is day 31 counting today
  usage.record({ role: 'core', cost: 3 });
  await usage.save({ force: true });
  assert.deepEqual(daysOnDisk(), ['2026-10-14', '2026-10-15', '2026-11-13']);
  now.advance(24 * HOUR); // 2026-11-14: 2026-10-14 is day 32
  usage.record({ role: 'core', cost: 4 });
  await usage.save({ force: true });
  assert.deepEqual(daysOnDisk(), ['2026-10-15', '2026-11-13', '2026-11-14']);
});

test('usage: a file of the older two-day format loads; days beyond the window or after today are dropped', () => {
  const dataDir = tmpDir();
  const row = { requests: 1, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 1 };
  const days = {
    '2026-10-14': { core: row },
    '2026-10-15': { core: row },
    '2026-09-01': { core: row },
    '2026-10-16': { core: row },
    junk: { core: row },
  };
  fs.writeFileSync(path.join(dataDir, USAGE_FILE), JSON.stringify({ v: 1, days }));
  const usage = createUsage({ dataDir, now: clock() });
  const sum = usage.sumDays(30);
  assert.equal(sum.total.cost, 2);
  assert.equal(sum.since, '2026-10-14');
});

test('usage: sumDays sums the last N days per role, filtered by only or except, with the first day covered', () => {
  const now = clock(Date.parse('2026-10-01T12:00:00.000Z'));
  const usage = createUsage({ dataDir: tmpDir(), now });
  usage.record({ role: 'core', cost: 1, promptTokens: 10 }); // 2026-10-01, outside the 7 days of 10-15
  now.advance(10 * 24 * HOUR); // 2026-10-11
  usage.record({ role: 'core', cost: 2 });
  usage.record({ role: 'analyzer', cost: 0.5 });
  now.advance(4 * 24 * HOUR); // 2026-10-15
  usage.record({ role: 'vision', cost: 0.25 });
  usage.record({ role: 'core', cost: 0.75 });

  const week = usage.sumDays(7);
  assert.deepEqual(
    week.rows.map((row) => [row.role, row.requests, row.cost]),
    [
      ['core', 2, 2.75],
      ['analyzer', 1, 0.5],
      ['vision', 1, 0.25],
    ]
  );
  assert.equal(week.total.cost, 3.5);
  assert.equal(week.total.requests, 4);
  assert.deepEqual(
    [week.since, week.partial],
    ['2026-10-09', false],
    'the accumulator reaches back further: the whole window'
  );

  const month = usage.sumDays(30);
  assert.equal(month.total.cost, 4.5);
  assert.equal(month.total.promptTokens, 10);
  assert.deepEqual(
    [month.since, month.partial],
    ['2026-10-01', true],
    'fewer days than the window: since the first recorded day'
  );

  assert.equal(usage.sumDays(30, { only: ['core'] }).total.cost, 3.75);
  assert.deepEqual(
    usage.sumDays(7, { except: ['core', 'vision'] }).rows.map((row) => row.role),
    ['analyzer']
  );
  assert.deepEqual(usage.sumDays(7, { only: [] }).rows, [], 'a key with no role sums nothing');
});

test('usage: sumDays of an empty accumulator covers today only', () => {
  const usage = createUsage({ dataDir: tmpDir(), now: clock() });
  const sum = usage.sumDays(7);
  assert.deepEqual([sum.total.cost, sum.since, sum.partial], [0, '2026-10-15', true]);
});

test('usage: the day survives a restart through the file; a broken file starts empty', async () => {
  const dataDir = tmpDir();
  const now = clock();
  const first = createUsage({ dataDir, now });
  first.record({ role: 'core', promptTokens: 100, cachedTokens: 40, completionTokens: 7, cost: 0.25 });
  assert.equal(await first.save(), true);
  assert.equal(await first.save(), false, 'nothing new, no write');
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, USAGE_FILE), 'utf8'));
  assert.deepEqual(saved, {
    v: 1,
    days: {
      '2026-10-15': { core: { requests: 1, promptTokens: 100, cachedTokens: 40, completionTokens: 7, cost: 0.25 } },
    },
  });
  const second = createUsage({ dataDir, now });
  assert.deepEqual(second.byRole(), [
    { role: 'core', requests: 1, promptTokens: 100, cachedTokens: 40, completionTokens: 7, cost: 0.25 },
  ]);

  fs.writeFileSync(path.join(dataDir, USAGE_FILE), '{not json');
  const warnings = [];
  const third = createUsage({ dataDir, now, log: { warn: (msg, meta) => warnings.push({ msg, meta }) } });
  assert.deepEqual(third.byRole(), []);
  assert.equal(warnings.length, 1);
});

test('usage: a save within a minute of the last waits unless forced', async () => {
  const now = clock();
  const usage = createUsage({ dataDir: tmpDir(), now });
  usage.record({ role: 'core', cost: 1 });
  assert.equal(await usage.save(), true);
  usage.record({ role: 'core', cost: 1 });
  assert.equal(await usage.save(), false);
  assert.equal(await usage.save({ force: true }), true);
});

test('keyCostsLines: the simulator key follows the main key and its usage, through the same renderer, its usage all from its own report; not set is one line', () => {
  const labels = {
    status: {
      costs: {
        ...LABELS.status.costs,
        keyLead: 'key',
        simKeyLead: 'sim',
        simKeyNotSet: 'sim: not set',
        keyLimit: '{lead} limit {spent}/{limit} ({notes})',
        keyUnavailable: '{lead} limit unavailable: {reason}',
        usageWeekCal: 'W {usd}',
        usageMonthCal: 'M {usd}',
      },
    },
  };
  const main = ok({ limit: 30, limit_remaining: 21, limit_reset: null, usage_daily: 0.5 });
  const windows = { last7: window(3), last30: window(4) };
  const simKey = ok({
    limit: 5,
    limit_remaining: 4,
    limit_reset: null,
    usage_daily: 0.25,
    usage_weekly: 1,
    usage_monthly: 2,
  });
  assert.deepEqual(
    keyCostsLines({ key: main, sim: simKey, labels, windows }),
    [
      'key limit 9.00/30.00 (never resets)',
      'usage D 0.50 | L7 3.00 | L30 4.00',
      'sim limit 1.00/5.00 (never resets)',
      'usage D 0.25 | W 1.00 | M 2.00',
    ],
    'the main key with its rolling sums, then the simulator key with its calendar periods'
  );
  const partial = ok({ limit: 5, limit_remaining: 4, limit_reset: null, usage_daily: 0 });
  assert.equal(
    keyCostsLines({ key: main, sim: partial, labels }).at(-1),
    'usage D 0.00',
    'only the periods the key reports'
  );
  assert.deepEqual(
    keyCostsLines({ key: main, sim: null, labels, windows }).slice(2),
    ['sim: not set'],
    'no usage line under an unset key'
  );
  const failed = keyCostsLines({ key: ok({}), sim: { ok: false, reason: 'http', status: 401 }, labels });
  assert.equal(failed.at(-1), 'sim limit unavailable: http 401', 'a failed read: no usage line under it');
});

// ---- rolling windows, extra role keys, the average ------------------------------------

const window = (cost, since = '2026-09-16', partial = false) => ({
  rows: [],
  total: { requests: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost },
  since,
  partial,
});

test('keyCostsLines: the usage line is today from the key, then the rolling 7 and 30 days; a short window says since when', () => {
  const lines = keyCostsLines({
    key: ok({ usage_daily: 0.1, usage_weekly: 9, usage_monthly: 99 }),
    labels: LABELS,
    windows: { last7: window(3.5, '2026-10-15', true), last30: window(12) },
  });
  assert.equal(lines[1], 'usage D 0.10 | L7 3.50 from 2026-10-15 | L30 12.00');
  const failed = keyCostsLines({
    key: { ok: false, reason: 'timeout' },
    labels: LABELS,
    windows: { last7: window(1), last30: window(2) },
  });
  assert.equal(failed[1], 'usage L7 1.00 | L30 2.00', 'the rolling sums stay when the key read fails');
});

test('keyCostsLines: each extra role key gets its key line led by its roles and its own usage line under it, after the main and the simulator key', () => {
  const labels = {
    status: {
      costs: {
        ...LABELS.status.costs,
        keyLead: 'main',
        roleKeyLead: '{roles} key',
        roleSeparator: '+',
        keyLimitPlain: '{lead} {spent}/{limit}',
        keyUnavailable: '{lead} unavailable: {reason}',
        simKeyNotSet: 'sim: not set',
      },
    },
  };
  const lines = keyCostsLines({
    key: ok({ limit: 30, limit_remaining: 20, usage_daily: 1 }),
    labels,
    windows: { last7: window(5), last30: window(6) },
    roleKeys: [
      {
        roles: ['video', 'core'],
        key: ok({ limit: 200, limit_remaining: 10, usage_daily: 2 }),
        windows: { last7: window(7), last30: window(8) },
      },
      {
        roles: ['vision'],
        key: { ok: false, reason: 'http', status: 401 },
        windows: { last7: window(0.5), last30: window(0.5) },
      },
    ],
  });
  assert.deepEqual(lines, [
    'main 10.00/30.00',
    'usage D 1.00 | L7 5.00 | L30 6.00',
    'sim: not set',
    'video+core key 190.00/200.00',
    'usage D 2.00 | L7 7.00 | L30 8.00',
    'vision key unavailable: http 401',
    'usage L7 0.50 | L30 0.50',
  ]);
  const noLead = { status: { costs: { ...labels.status.costs, roleKeyLead: undefined } } };
  const without = keyCostsLines({ key: ok({}), labels: noLead, roleKeys: [{ roles: ['core'], key: ok({}) }] });
  assert.equal(
    without.some((text) => text.includes('core')),
    false,
    'no lead label, no role key line'
  );
});

test('keyCostsLines: roleNames names the roles of an extra key, each name once, so the agents key is one word', () => {
  const labels = {
    status: {
      costs: {
        ...LABELS.status.costs,
        keyLead: 'main',
        roleKeyLead: '{roles} key',
        roleSeparator: '+',
        keyLimitPlain: '{lead} {spent}/{limit}',
        simKeyNotSet: 'sim: not set',
        roleNames: { scout: 'agents', server: 'agents', dev: 'agents' },
      },
    },
  };
  const lines = keyCostsLines({
    key: ok({ limit: 30, limit_remaining: 20, usage_daily: 1 }),
    labels,
    roleKeys: [
      {
        roles: ['dev', 'server', 'scout'],
        key: ok({ limit: 10, limit_remaining: 9, usage_daily: 0.5 }),
        windows: { last7: window(0), last30: window(0) },
      },
      { roles: ['scout', 'core'], key: ok({ limit: 5, limit_remaining: 5 }) },
    ],
  });
  assert.deepEqual(lines.slice(3), [
    'agents key 1.00/10.00',
    'usage D 0.50 | L7 0.00 | L30 0.00',
    'agents+core key 0.00/5.00',
  ]);
  const plain = keyCostsLines({
    key: ok({}),
    labels: { status: { costs: { ...labels.status.costs, roleNames: 'odd' } } },
    roleKeys: [{ roles: ['scout'], key: ok({ limit: 5, limit_remaining: 5 }) }],
  });
  assert.ok(
    plain.some((text) => text.startsWith('scout key')),
    'no usable roleNames: the role itself'
  );
});

test('roleCostsLines: the role lines carry the average cost per request, left out with no request or no label', () => {
  const labels = {
    status: { costs: { ...LABELS.status.costs, role: '{role} {requests} = {cost}{avg}', avg: ' avg {usd}' } },
  };
  const rows = [
    { role: 'core', requests: 4, promptTokens: 150_000, cachedTokens: 57_000, completionTokens: 635, cost: 0.61 },
    { role: 'idle', requests: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0 },
  ];
  assert.deepEqual(roleCostsLines({ rows, labels }), ['core 4 = 0.61 avg 0.153', 'idle 0 = 0.00']);
  const noAvg = { status: { costs: { ...labels.status.costs, avg: undefined } } };
  assert.equal(roleCostsLines({ rows, labels: noAvg })[0], 'core 4 = 0.61');
});

// ---- the management key's activity ---------------------------------------------------------

test('activitySums: the last 6 and 29 completed UTC days, each day usage plus BYOK inference over its rows; today and older days left out', () => {
  const rows = [
    { date: '2026-10-14 00:00:00', usage: 1, byok_usage_inference: 0.5, requests: 3 },
    { date: '2026-10-14 00:00:00', usage: 0.25, byok_usage_inference: 0 },
    { date: '2026-10-09 00:00:00', usage: 2, byok_usage_inference: null },
    { date: '2026-10-08 00:00:00', usage: 4 },
    { date: '2026-09-16 00:00:00', usage: 8 },
    { date: '2026-09-15 00:00:00', usage: 16 },
    { date: '2026-10-15 00:00:00', usage: 32 },
    { date: 'not a day', usage: 64 },
    null,
  ];
  assert.deepEqual(activitySums(rows, '2026-10-15'), { last7: 3.75, last30: 15.75 });
  assert.equal(activitySums('odd', '2026-10-15'), null);
});

test('readActivity: the rows of a 2xx answer, or why not', async () => {
  assert.deepEqual(await readActivity(async () => ({ ok: true, status: 200, json: { data: [{ usage: 1 }] } })), {
    ok: true,
    data: [{ usage: 1 }],
  });
  assert.deepEqual(await readActivity(async () => ({ ok: true, status: 200, json: { data: {} } })), {
    ok: false,
    reason: 'bad-answer',
  });
  assert.deepEqual(await readActivity(async () => ({ ok: false, status: 403, json: null })), {
    ok: false,
    reason: 'http',
    status: 403,
  });
  assert.deepEqual(await readActivity(null), { ok: false, reason: 'no-client' });
});

test('keyCostsLines: with the activity of a key its usage line is today, then today plus the completed days of the last 7 and 30, for the simulator key too', () => {
  const labels = {
    status: {
      costs: {
        ...LABELS.status.costs,
        keyLead: 'main',
        simKeyLead: 'sim',
        roleKeyLead: '{roles} key',
        keyLimitPlain: '{lead} {spent}/{limit}',
        usageWeekCal: 'W {usd}',
        usageMonthCal: 'M {usd}',
      },
    },
  };
  const lines = keyCostsLines({
    key: ok({ limit: 30, limit_remaining: 20, usage_daily: 1 }),
    activity: { last7: 2, last30: 5 },
    windows: { last7: window(99), last30: window(99) },
    sim: ok({ limit: 5, limit_remaining: 5, usage_daily: 0.5, usage_weekly: 9, usage_monthly: 9 }),
    simActivity: { last7: 0.25, last30: 0.75 },
    labels,
    roleKeys: [
      {
        roles: ['core'],
        key: ok({ limit: 200, limit_remaining: 100, usage_daily: 3 }),
        activity: { last7: 1, last30: 2 },
        windows: { last7: window(99), last30: window(99) },
      },
      {
        roles: ['vision'],
        key: ok({ limit: 10, limit_remaining: 10, usage_daily: 0 }),
        activity: null,
        windows: { last7: window(4), last30: window(6) },
      },
    ],
  });
  assert.deepEqual(
    lines,
    [
      'main 10.00/30.00',
      'usage D 1.00 | L7 3.00 | L30 6.00',
      'sim 0.00/5.00',
      'usage D 0.50 | L7 0.75 | L30 1.25',
      'core key 100.00/200.00',
      'usage D 3.00 | L7 4.00 | L30 5.00',
      'vision key 0.00/10.00',
      'usage D 0.00 | L7 4.00 | L30 6.00',
    ],
    'no activity for a key: the accumulator sums (the simulator key: its calendar periods)'
  );
  const failedKey = keyCostsLines({
    key: { ok: false, reason: 'timeout' },
    activity: { last7: 2, last30: 5 },
    labels,
    windows: { last7: window(1), last30: window(2) },
  });
  assert.equal(failedKey[1], 'usage L7 1.00 | L30 2.00', 'a failed key read: no today to add to, the accumulator sums');
});

test('createLlm: activity is one GET with the hash in the query and the management key; keyHash hashes the key a role goes out on', async () => {
  const calls = [];
  const state = { data: {}, markDirty() {} };
  const llm = createLlm({
    apiKey: 'k-test',
    env: { OPENROUTER_CORE_KEY_X: 'k-core' },
    getConfig: () => ({
      llm: {
        baseUrl: 'https://openrouter.ai/api/v1',
        timeoutMs: 5000,
        maxRequestsPerDay: 1,
        keyByRole: { core: 'OPENROUTER_CORE_KEY_X' },
      },
    }),
    calibrator: { observe() {} },
    state,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    },
  });
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  assert.equal(keyHashOf('k-test'), sha('k-test'));
  assert.equal(llm.keyHash(), sha('k-test'));
  assert.equal(llm.keyHash({ role: 'core' }), sha('k-core'));
  assert.deepEqual(await llm.activity({ apiKey: 'mgmt-test', keyHash: sha('k-core'), timeoutMs: 1234 }), {
    ok: true,
    status: 200,
    json: { data: [] },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://openrouter.ai/api/v1/activity?api_key_hash=${sha('k-core')}`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer mgmt-test');
  assert.deepEqual(state.data, {}, 'nothing counted');
});

test('agentCostsLines: one line per agent in order with today, 7 and 30 days, no runs for an agent without any, then the estimate note', () => {
  const labels = {
    status: {
      costs: {
        partSeparator: ' | ',
        agentLine: '{agent}: {parts}',
        agentWindow: '{window} {runs}r {in}/{out} {usd}',
        agentWindows: { today: 'D', last7: 'W' },
        agentNoRuns: '{agent}: none',
        agentEstimate: 'est.',
      },
    },
  };
  const row = (runs, input, output, usd) => ({ runs, input, output, usd });
  const totals = {
    scout: {
      today: row(2, 12_400, 3_100, 0.123),
      last7: row(9, 98_000, 20_000, 0.8),
      last30: row(30, 1_234_567, 99_999, 3.456),
    },
    server: { today: row(0, 0, 0, 0), last7: row(0, 0, 0, 0), last30: row(0, 0, 0, 0) },
  };
  assert.deepEqual(agentCostsLines({ agents: ['scout', 'server', 'dev'], totals, labels }), [
    'scout: D 2r 12k/3.1k 0.12 | W 9r 98k/20k 0.80 | last30 30r 1.23M/100k 3.46',
    'server: none',
    'dev: none',
    'est.',
  ]);
  const noNote = { status: { costs: { ...labels.status.costs, agentEstimate: undefined } } };
  assert.deepEqual(agentCostsLines({ agents: ['dev'], totals: null, labels: noNote }), ['dev: none']);
  assert.deepEqual(agentCostsLines({ agents: ['scout'], totals, labels: {} }), []);
});

test('agentCostsLines: an agent with a last wave gets its context line right after its own line; a wave without context, or no label, adds none', () => {
  const costs = {
    partSeparator: ' | ',
    agentLine: '{agent}: {parts}',
    agentWindow: '{window} {runs}r {usd}',
    agentNoRuns: '{agent}: none',
    agentContext: '{agent} wave {wave} {turns}t ctx {mean}/{peak} {usd}',
    agentEstimate: 'est.',
  };
  const row = (runs, usd) => ({ runs, input: 0, output: 0, usd });
  const thinker = {
    today: row(2, 1.5),
    last7: row(2, 1.5),
    last30: row(2, 1.5),
    last_wave: { wave: 3, turns: 2, usd: 1.5, context_mean: 123_456, context_peak: null },
  };
  const totals = {
    thinker,
    dev: {
      today: row(0, 0),
      last7: row(0, 0),
      last30: row(0, 0),
      last_wave: { wave: 1, turns: 1, usd: 0, context_mean: null, context_peak: null },
    },
  };
  assert.deepEqual(agentCostsLines({ agents: ['thinker', 'dev'], totals, labels: { status: { costs } } }), [
    'thinker: today 2r 1.50 | last7 2r 1.50 | last30 2r 1.50',
    'thinker wave 3 2t ctx 123k/- 1.50',
    'dev: none',
    'est.',
  ]);
  const old = { thinker: { ...thinker, today: row(0, 0), last7: row(0, 0), last30: row(0, 0) } };
  assert.deepEqual(
    agentCostsLines({ agents: ['thinker'], totals: old, labels: { status: { costs } } }),
    ['thinker: none', 'thinker wave 3 2t ctx 123k/- 1.50', 'est.'],
    'an old wave still shows under no runs'
  );
  const noContext = { status: { costs: { ...costs, agentContext: undefined } } };
  assert.deepEqual(agentCostsLines({ agents: ['thinker'], totals, labels: noContext }), [
    'thinker: today 2r 1.50 | last7 2r 1.50 | last30 2r 1.50',
    'est.',
  ]);
});
