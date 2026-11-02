// Tests for src/keys/ring.ts and its use by createLlm: the core key list, the failover of #476 over the store's names,
// a role bound to an extra key, and the pick of the key at the moment of each request. `fetch` is a fake that answers
// by the key it is given; the store is a file in a temp folder; the clock is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyFailover } from '../src/llm/key-failover.ts';
import { createKeyRing } from '../src/keys/ring.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { createLlm } from './fixtures/llm.ts';
import { BASE_URL, SECRET, SECRET_2, SECRET_3, fakeFetch } from './fixtures/keys-rig.ts';
import type { Reply } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const T0 = Date.parse('2026-11-02T09:00:00Z');
const ask = [{ role: 'user', content: 'hello' }];
const OUT_OF_CREDIT: Reply = { status: 402, body: { error: { message: 'Payment Required' } } };
const FINE: Reply = {
  status: 200,
  body: { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5, cost: 0.01 } },
};

const config = {
  models: { base: { core: 'x/core', vision: 'x/vision' } },
  llm: {
    baseUrl: BASE_URL,
    temperature: 1,
    maxOutputTokens: 100,
    maxRequestTokens: 1000,
    maxRequestsPerDay: 300,
    timeoutMs: 5000,
    analyzerTimeoutMs: 5000,
    retries: 0,
  },
};

/** A store with `values` as core keys core-1, core-2, ..., a client over the ring, and the key each request used. */
function rig(values: Array<string>, script: Record<string, Array<Reply>> = {}) {
  const privateDir = tempDir('keys-ring-');
  const store = createKeyStore({ privateDir });
  values.forEach((value, i) => store.addCore({ name: `core-${i + 1}`, value }));
  const clock = { at: T0 };
  const failover = createKeyFailover({ now: () => clock.at });
  const ring = createKeyRing({ store, failover });
  const used: Record<string, number> = {};
  const { fetch, calls } = fakeFetch((call) => {
    const steps = script[call.auth] ?? [FINE];
    const reply = steps[Math.min(used[call.auth] ?? 0, steps.length - 1)] ?? FINE;
    used[call.auth] = (used[call.auth] ?? 0) + 1;
    return reply;
  });
  const llm = createLlm({
    keys: ring,
    getConfig: () => config,
    calibrator: { ratio: 1, apply: (n: number) => n, observe() {} },
    state: { data: {}, markDirty() {} },
    fetchImpl: fetch,
    now: () => clock.at,
  });
  return { store, ring, llm, clock, privateDir, sent: () => calls.map((call) => call.auth) };
}

test('three core keys are walked in order, one repeat per request; the third failing within a minute is keys-exhausted', async () => {
  const { llm, sent, clock } = rig([SECRET, SECRET_2, SECRET_3], {
    [SECRET]: [OUT_OF_CREDIT],
    [SECRET_2]: [OUT_OF_CREDIT],
    [SECRET_3]: [FINE, OUT_OF_CREDIT],
  });
  // The first request spends its one repeat on the second key and fails with that key's error; the role has moved on.
  await assert.rejects(llm.complete(ask, { role: 'core' }), { statusCode: 402 });
  assert.deepEqual(sent(), [SECRET, SECRET_2]);
  const answer = await llm.complete(ask, { role: 'core' });
  assert.equal(answer.text, 'ok');
  // Bug caught: the failover still hard-wired to a main key and one backup, so the third key is never reached.
  assert.deepEqual(sent().slice(2), [SECRET_3], 'the next request goes to the third key');
  clock.at += 5000;
  await assert.rejects(llm.complete(ask, { role: 'core' }), { code: 'keys-exhausted' });
});

test('the last key failing switches back to the first once the first failed more than a minute ago', async () => {
  const { llm, sent, clock } = rig([SECRET, SECRET_2], {
    [SECRET]: [OUT_OF_CREDIT, FINE],
    [SECRET_2]: [FINE, OUT_OF_CREDIT],
  });
  await llm.complete(ask, { role: 'core' });
  assert.deepEqual(sent(), [SECRET, SECRET_2]);
  clock.at += 2 * 60_000;
  await llm.complete(ask, { role: 'core' });
  // Bug caught: the list ending at its last key instead of wrapping to the first after the first one's credit came back.
  assert.deepEqual(sent().slice(2), [SECRET_2, SECRET], 'the failure on the last key goes back to the first');
});

test('a key added after the client was built is used by the next request, and a removed current key is dropped', async () => {
  const { llm, store, sent } = rig([SECRET], { [SECRET]: [OUT_OF_CREDIT, OUT_OF_CREDIT, FINE] });
  await assert.rejects(llm.complete(ask, { role: 'core' }), { statusCode: 402 });
  assert.deepEqual(sent(), [SECRET], 'one key: the budget error is the request error, no repeat');
  store.addCore({ name: 'core-2', value: SECRET_2 });
  // Bug caught: the key list read once at the start, so a key added from the chat waits for a restart.
  await llm.complete(ask, { role: 'core' });
  assert.deepEqual(sent().slice(1), [SECRET, SECRET_2]);
  store.removeCore('core-2');
  await llm.complete(ask, { role: 'core' });
  assert.equal(sent().at(-1), SECRET, 'the removed key is not sent on again');
});

test('a role bound to an extra key goes out on it alone, a budget error there is not failed over, and unbind returns it', async () => {
  const { llm, store, sent } = rig([SECRET, SECRET_2], { [SECRET_3]: [OUT_OF_CREDIT] });
  store.addExtra({ name: 'vision-key', value: SECRET_3 });
  store.bind('vision', 'vision-key');
  await assert.rejects(llm.complete(ask, { role: 'vision' }), { statusCode: 402 });
  // Bug caught: a bound role failing over onto the core keys and spending them for a role the owner moved off them.
  assert.deepEqual(sent(), [SECRET_3], 'one send on the bound key and no repeat on a core key');
  await llm.complete(ask, { role: 'core' });
  assert.equal(sent().at(-1), SECRET, 'the core is untouched by the bound role');
  store.unbind('vision');
  await llm.complete(ask, { role: 'vision' });
  assert.equal(sent().at(-1), SECRET, 'unbound, the role is on the core list again');
});

test('with no core key and no binding a request has no route and is refused before anything is sent', async () => {
  const { llm, ring, sent } = rig([]);
  assert.equal(ring.route('core'), null);
  assert.deepEqual(ring.names('core'), []);
  await assert.rejects(llm.complete(ask, { role: 'core' }), { code: 'ROLE_KEY_MISSING' });
  assert.deepEqual(sent(), []);
});

test('route names the key and failed answers with names, never a value', () => {
  const { ring } = rig([SECRET, SECRET_2]);
  assert.deepEqual(ring.route('analyzer'), { name: 'core-1', value: SECRET });
  assert.equal(ring.failed('analyzer', 'core-1', 402), 'core-2');
  assert.equal(ring.route('analyzer')?.name, 'core-2');
  assert.deepEqual(
    ring.states().map((state) => [state.role, state.key]),
    [['analyzer', 'core-2']]
  );
});
