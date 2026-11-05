// Direct OpenRouter accounting (src/subharness/usage/openrouter.ts): one authenticated read of the key's account, no
// completion. The account is named by the key's name in the store, a limit OpenRouter does not report stays unknown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOpenRouterUsage } from '../src/subharness/usage/openrouter.ts';
import { fakeFetch } from './fixtures/keys-rig.ts';
import type { Call, Reply } from './fixtures/keys-rig.ts';

const BASE = 'https://openrouter.test/api/v1';
const T0 = 1_790_000_000_000;
const KEY = { name: 'core one', value: 'or-value-secret' };

const accountReply =
  (data: Record<string, unknown>) =>
  (call: Call): Reply =>
    call.url.endsWith('/key') ? { status: 200, body: { data } } : { status: 404, body: {} };

function deps(answer: (call: Call) => Reply, key: typeof KEY | null = KEY) {
  const { fetch, calls } = fakeFetch(answer);
  return { calls, given: { fetch, baseUrl: BASE, key, now: () => T0 } };
}

const FULL = { label: 'sk-or-v1-abc...xyz', usage: 12.5, limit: 100, limit_remaining: 87.5 };

test('the reported spend and limit survive under the name of the key, as API accounting', async () => {
  // Catches: spend recalculated from tokens, or an observation that does not say which key it read.
  const { given } = deps(accountReply(FULL));
  const usage = await readOpenRouterUsage(given);
  assert.equal(usage.source, 'openrouter');
  assert.equal(usage.variant, 'api');
  assert.equal(usage.account.label, 'core one');
  assert.equal(usage.observedAt, T0);
  const value = (name: string) => usage.metrics.find((one) => one.name === name);
  assert.equal(value('usage')?.value, 12.5);
  assert.equal(value('usage')?.unit, 'usd');
  assert.equal(value('limit')?.value, 100);
  assert.equal(value('limitRemaining')?.value, 87.5);
});

test('a key with no limit has an unknown limit, not a limit of zero', async () => {
  // Catches: `null` read as zero, an unlimited key drawn as an exhausted one.
  const { given } = deps(accountReply({ ...FULL, limit: null, limit_remaining: null }));
  const usage = await readOpenRouterUsage(given);
  const limit = usage.metrics.find((one) => one.name === 'limit');
  assert.equal(limit?.value, null);
  assert.equal(limit?.state, 'unknown');
});

test('it sends one account read and no completion, and the key value is not in the result', async () => {
  // Catches: a hidden model call for a balance, or the credential copied into the observation.
  const { given, calls } = deps(accountReply(FULL));
  const usage = await readOpenRouterUsage(given);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.url.endsWith('/key'));
  assert.equal(JSON.stringify(usage).includes(KEY.value), false);
  assert.equal(JSON.stringify(usage).includes(FULL.label), false);
});

test('no key, a refused read and an unanswered read each have their own code and no metric', async () => {
  // Catches: a network failure drawn as zero spend.
  const none = deps(accountReply(FULL), null);
  const noKey = await readOpenRouterUsage(none.given);
  assert.deepEqual(
    noKey.errors.map((one) => one.code),
    ['no-key']
  );
  assert.deepEqual(none.calls, []);

  const refused = await readOpenRouterUsage(deps(() => ({ status: 401, body: {} })).given);
  assert.deepEqual(
    refused.errors.map((one) => one.code),
    ['provider-rejected']
  );
  assert.deepEqual(refused.metrics, []);

  const lost = await readOpenRouterUsage({
    baseUrl: BASE,
    key: KEY,
    now: () => T0,
    fetch: () => Promise.reject(new Error('the network')),
  });
  assert.deepEqual(
    lost.errors.map((one) => one.code),
    ['read-failed']
  );
  assert.equal(lost.availability, 'unavailable');
});
