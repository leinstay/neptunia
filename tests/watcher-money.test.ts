// What the watcher knows of the money (src/watcher/money.ts): `moneyFacts` sums the spend of the last 24 hours from
// `model_requests.usage` by key slot, role and model, keeps BYOK apart and counts subscription runs without dollars, reads
// each OpenRouter key's balance with an injected `fetch`, and gives every limit its runway to its reset on the engine clock.
// Keys reach it as named slots with values; the fact and the brief hold slot names only. Rows go through the memory writer.
// Invented keys, models and ids only; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { MemoryHandle } from '../src/memory/db/types.ts';
import { runInspection } from '../src/watcher/inspection.ts';
import { moneyFacts } from '../src/watcher/money.ts';
import type { MoneyFacts, MoneyKey } from '../src/watcher/money.ts';
import { tempDir } from './fixtures/tmp.ts';
import { answerOf, inspectionDeps, inspectionRig, said } from './fixtures/watcher-inspection-rig.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MIDNIGHT = '2026-11-06T00:00:00.000Z';
/** Key values shaped like no real key, built in pieces so no scanner takes them for one. */
const CORE_VALUE = ['invented', 'core', 'c0ffee11223344556677'].join('-');
const HELPERS_VALUE = ['invented', 'helpers', 'beef00112233445566'].join('-');
const SIMULATION_VALUE = ['invented', 'sim', 'f00d99887766554433'].join('-');
const KEYS: ReadonlyArray<MoneyKey> = [
  { slot: 'core', service: 'openrouter', value: CORE_VALUE },
  { slot: 'helpers', service: 'openrouter', value: HELPERS_VALUE },
];
/** The analyzer spends on the extra key `helpers`; every other role on the core keys. */
const ROLE_SLOTS = { analyzer: 'helpers' };
const CONFIG = { bot: { timezone: 'UTC' }, llm: { maxRequestsPerDay: 5000, maxRequestTokens: 50_000 } };

function freshHandle(): MemoryHandle {
  return openMemoryDb(path.join(tempDir('nep-money-'), 'memory.db'));
}

let made = 0;
/** One finished request through the writer, with its usage as the provider answered it. */
function request(
  handle: MemoryHandle,
  row: { at: number; role: string; model: string; usage?: Record<string, unknown>; backend?: string }
): void {
  made += 1;
  const id = `req-${made}`;
  applyMemoryWrite(handle, {
    kind: 'request-archive',
    op: 'start',
    record: {
      id,
      at: row.at - MINUTE,
      role: row.role,
      purpose: 'invented',
      model: row.model,
      system_text: 'system',
      messages: '[]',
      backend: row.backend ?? 'openrouter',
    },
  });
  applyMemoryWrite(handle, {
    kind: 'request-archive',
    op: 'finish',
    id,
    at: row.at,
    status: 'ok',
    response_text: 'ok',
    ...(row.usage === undefined ? {} : { usage: JSON.stringify(row.usage) }),
    ...(row.backend === undefined ? {} : { backend: row.backend }),
  });
}

/** The numbers OpenRouter's `GET /api/v1/key` gives for a key, inside its `data`. */
const keyAnswer = (fields: Record<string, unknown>): Record<string, unknown> => ({
  data: {
    label: 'invented',
    limit: 10,
    limit_remaining: 4,
    limit_reset: 'daily',
    usage: 6,
    usage_daily: 1,
    usage_weekly: 3,
    usage_monthly: 6,
    is_free_tier: false,
    ...fields,
  },
});

type Call = { url: string; authorization: string };

/** A `fetch` that answers by the key in the Authorization header: a body, a status, or a throw. */
function fakeFetch(byValue: Readonly<Record<string, { status: number; body?: unknown } | 'throw'>>) {
  const calls: Array<Call> = [];
  const fetch = (url: string, init: { headers: Record<string, string> }): Promise<Response> => {
    const authorization = init.headers.Authorization ?? init.headers.authorization ?? '';
    calls.push({ url, authorization });
    const value = authorization.replace(/^Bearer /, '');
    const answer = byValue[value];
    if (answer === undefined) return Promise.resolve(new Response('{}', { status: 404 }));
    if (answer === 'throw') return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(new Response(JSON.stringify(answer.body ?? {}), { status: answer.status }));
  };
  return { fetch, calls };
}

/** The facts over `handle` at `NOW`, the core key answering `core` and the helpers key a 401 unless told otherwise. */
async function factsOf(
  handle: MemoryHandle,
  options: {
    core?: Record<string, unknown>;
    keys?: ReadonlyArray<MoneyKey>;
    answers?: Readonly<Record<string, { status: number; body?: unknown } | 'throw'>>;
    config?: Record<string, unknown>;
    requestsToday?: number;
  } = {}
): Promise<{ facts: MoneyFacts; calls: Array<Call> }> {
  const { fetch, calls } = fakeFetch(
    options.answers ?? {
      [CORE_VALUE]: { status: 200, body: keyAnswer(options.core ?? {}) },
      [HELPERS_VALUE]: { status: 401, body: { error: { code: 401 } } },
    }
  );
  const facts = await moneyFacts({
    db: dbOf(handle),
    keys: options.keys ?? KEYS,
    roleSlots: ROLE_SLOTS,
    requestsToday: options.requestsToday ?? 0,
    fetch,
    now: () => NOW,
    config: options.config ?? CONFIG,
  });
  return { facts, calls };
}

/** Two core requests at $1.5 and $0.5 in the last 24 hours: $2 on the core key. */
function twoDollarsOnCore(handle: MemoryHandle): void {
  const usage = (cost: number) => ({ prompt_tokens: 100, completion_tokens: 20, cost, is_byok: false });
  request(handle, { at: NOW - 2 * HOUR, role: 'core', model: 'invented/large', usage: usage(1.5) });
  request(handle, { at: NOW - 3 * HOUR, role: 'core', model: 'invented/large', usage: usage(0.5) });
}

// Bug: the spend is summed over the whole archive, mixes BYOK into the credits, prices a subscription run, or takes the
// upstream cost over the cost OpenRouter charged.
test('sums the spend of the last 24 hours by key, role and model, BYOK apart and subscription runs without dollars', async () => {
  const handle = freshHandle();
  twoDollarsOnCore(handle);
  request(handle, {
    at: NOW - HOUR,
    role: 'analyzer',
    model: 'invented/small',
    usage: { prompt_tokens: 10, completion_tokens: 2, is_byok: true, cost_details: { upstream_inference_cost: 0.25 } },
  });
  request(handle, {
    at: NOW - HOUR,
    role: 'analyzer',
    model: 'invented/small',
    usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.25, cost_details: { upstream_inference_cost: 0.125 } },
  });
  request(handle, {
    at: NOW - HOUR,
    role: 'memory',
    model: 'invented/subscribed',
    backend: 'claude',
    usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 5 },
  });
  request(handle, { at: NOW - 25 * HOUR, role: 'core', model: 'invented/large', usage: { cost: 7 } });
  const { facts } = await factsOf(handle);
  handle.close();
  const { byKey, byRole, byModel, subscription } = facts.spend;
  assert.deepEqual(byKey.core, { requests: 2, tokens: 240, credits: 2, byok: 0 });
  assert.deepEqual(byKey.helpers, { requests: 2, tokens: 24, credits: 0.25, byok: 0.25 });
  assert.deepEqual(byRole.analyzer, { requests: 2, tokens: 24, credits: 0.25, byok: 0.25 });
  assert.deepEqual(byModel['invented/large'], { requests: 2, tokens: 240, credits: 2, byok: 0 });
  assert.deepEqual(subscription.claude, { requests: 1, tokens: 1100 });
  const credits = Object.values(byKey).reduce((sum, row) => sum + row.credits, 0);
  assert.equal(credits, 2.25);
});

// Bug: the runway divides by the wrong spend or ignores the reset, so a key that lasts the day reads as running out.
test('a key read gives its limit, remaining and reset, and a runway that lasts past the reset with its margin', async () => {
  const handle = freshHandle();
  twoDollarsOnCore(handle);
  const { facts } = await factsOf(handle);
  handle.close();
  const core = facts.keys.find((one) => one.slot === 'core') ?? assert.fail('the core key was not read');
  assert.equal(core.limit, 10);
  assert.equal(core.limit_remaining, 4);
  assert.equal(core.limit_reset, 'daily');
  assert.equal(core.usage_daily, 1);
  assert.equal(core.resetAt, MIDNIGHT);
  assert.deepEqual(core.runway, { state: 'enough', margin: 4 });
});

// Bug: a key that runs dry this afternoon is reported as fine because only the daily total is compared.
test('a key that runs out before its reset is short, with the hour it runs out', async () => {
  const handle = freshHandle();
  twoDollarsOnCore(handle);
  const { facts } = await factsOf(handle, { core: { limit_remaining: 0.5 } });
  handle.close();
  const core = facts.keys.find((one) => one.slot === 'core') ?? assert.fail('the core key was not read');
  assert.deepEqual(core.runway, { state: 'short', runsOutAt: '2026-11-05T18:00:00.000Z' });
});

// Bug: a refused or unreachable key read fails the whole fact, or is filled with a guess.
test('a failed read is unavailable with its code, and the other keys are still read', async () => {
  const handle = freshHandle();
  const keys: ReadonlyArray<MoneyKey> = [
    ...KEYS,
    { slot: 'simulation', service: 'openrouter', value: SIMULATION_VALUE },
  ];
  const { facts } = await factsOf(handle, {
    keys,
    answers: {
      [CORE_VALUE]: { status: 200, body: keyAnswer({}) },
      [HELPERS_VALUE]: { status: 401, body: { error: { code: 401 } } },
      [SIMULATION_VALUE]: 'throw',
    },
  });
  handle.close();
  assert.deepEqual(
    facts.keys.map((one) => one.slot),
    ['core']
  );
  assert.ok(
    facts.unavailable.some((one) => one.slot === 'helpers' && one.code === 'http_401'),
    JSON.stringify(facts.unavailable)
  );
  assert.ok(
    facts.unavailable.some((one) => one.slot === 'simulation' && one.code !== ''),
    JSON.stringify(facts.unavailable)
  );
});

// Bug: a key value leaks into the fact, or a key is sent somewhere other than the endpoint that reads it.
test('no key value appears in the fact, and each key goes to the OpenRouter key endpoint alone', async () => {
  const handle = freshHandle();
  twoDollarsOnCore(handle);
  const { facts, calls } = await factsOf(handle);
  handle.close();
  const text = JSON.stringify(facts);
  for (const value of [CORE_VALUE, HELPERS_VALUE])
    assert.equal(text.includes(value), false, 'a key value is in the fact');
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.url, 'https://openrouter.ai/api/v1/key');
});

/** 48 requests over the last 24 hours, one every half hour: two an hour. */
function twoAnHour(handle: MemoryHandle): void {
  for (let n = 0; n < 48; n += 1)
    request(handle, { at: NOW - n * 30 * MINUTE - MINUTE, role: 'core', model: 'invented/large' });
}

// Bug: the daily cap's runway runs to a reset 24 hours away instead of midnight, and a cap that holds reads as short.
test('the daily request cap against today’s count lasts to midnight of the engine clock with its margin', async () => {
  const handle = freshHandle();
  twoAnHour(handle);
  const config = { ...CONFIG, llm: { maxRequestsPerDay: 100, maxRequestTokens: 50_000 } };
  const { facts } = await factsOf(handle, { config, requestsToday: 40 });
  handle.close();
  const { requestsPerDay } = facts.rails;
  assert.equal(requestsPerDay.remaining, 60);
  assert.equal(requestsPerDay.resetAt, MIDNIGHT);
  assert.deepEqual(requestsPerDay.runway, { state: 'enough', margin: 2.5 });
  assert.equal(facts.rails.maxRequestTokens, 50_000);
});

// Bug: a cap that will refuse her turns this evening is reported as fine because the day's count is under it now.
test('the daily request cap that runs out before midnight is short, with its hour', async () => {
  const handle = freshHandle();
  twoAnHour(handle);
  const config = { ...CONFIG, llm: { maxRequestsPerDay: 50, maxRequestTokens: 50_000 } };
  const { facts } = await factsOf(handle, { config, requestsToday: 40 });
  handle.close();
  const { requestsPerDay } = facts.rails;
  assert.deepEqual(requestsPerDay.runway, { state: 'short', runsOutAt: '2026-11-05T17:00:00.000Z' });
});

// Bug: the fact is gathered and never reaches the agent, or the brief carries a key the fact was built from.
test('the inspection brief carries the money fact by slot and no key value', async () => {
  const handle = freshHandle();
  twoDollarsOnCore(handle);
  const { facts } = await factsOf(handle);
  handle.close();
  const rig = inspectionRig();
  const briefs: Array<string> = [];
  await runInspection(
    inspectionDeps(rig, {
      money: () => Promise.resolve(facts),
      runAgent: (brief) => {
        briefs.push(brief);
        return Promise.resolve(said(answerOf()));
      },
    })
  );
  const [brief = ''] = briefs;
  const money = /<money>\n([\s\S]*?)\n<\/money>/.exec(brief)?.[1] ?? assert.fail('the brief has no <money>');
  assert.deepEqual(JSON.parse(money), JSON.parse(JSON.stringify(facts)));
  for (const value of [CORE_VALUE, HELPERS_VALUE])
    assert.equal(brief.includes(value), false, 'a key value is in the brief');
});
