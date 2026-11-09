// Tests for the route key of src/llm/openrouter.ts#createLlm: a request that brings `routeKey` (the chain client's,
// src/llm/chain-client.ts) goes out on that key alone, never on the key ring's, and a spent key there is thrown at
// once for the chain to move on, with no retry and no failover of its own. `fetch` is a fake that answers by key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyFailover } from '../src/llm/key-failover.ts';
import { createKeyRing } from '../src/keys/ring.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { createLlm } from './fixtures/llm.ts';
import { BASE_URL, SECRET, SECRET_2, SECRET_3, fakeFetch } from './fixtures/keys-rig.ts';
import type { Reply } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const ask = [{ role: 'user', content: 'hello' }];
const FINE: Reply = { status: 200, body: { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5 } } };
const config = {
  models: { base: { core: 'x/core', vision: 'x/vision' } },
  llm: {
    baseUrl: BASE_URL,
    maxOutputTokens: 100,
    maxRequestTokens: 1000,
    maxRequestsPerDay: 300,
    timeoutMs: 5000,
    retries: 2,
  },
};

function rig(reply: (auth: string) => Reply) {
  const store = createKeyStore({ privateDir: tempDir('route-key-') });
  store.addCore({ name: 'core-1', value: SECRET });
  store.addCore({ name: 'core-2', value: SECRET_2 });
  const ring = createKeyRing({ store, failover: createKeyFailover({ now: () => 0 }) });
  const { fetch, calls } = fakeFetch((call) => reply(call.auth));
  const llm = createLlm({
    keys: ring,
    getConfig: () => config,
    calibrator: { ratio: 1, apply: (n: number) => n, observe() {} },
    state: { data: {}, markDirty() {} },
    fetchImpl: fetch,
    now: () => 0,
  });
  return { llm, sent: () => calls.map((call) => call.auth), bodies: () => calls.map((call) => call.body) };
}

test('a request with a route key goes out on that key and leaves the key out of the body', async () => {
  // Catches: the ring's first core key used although the chain chose another key for the route.
  const { llm, sent, bodies } = rig(() => FINE);
  await llm.complete(ask, { role: 'vision', model: 'x/vision', routeKey: { name: 'helpers', value: SECRET_3 } });
  assert.deepEqual(sent(), [SECRET_3]);
  assert.equal(JSON.stringify(bodies()).includes(SECRET_3), false);
  assert.equal(JSON.stringify(bodies()).includes('helpers'), false);
});

test('a 402 on a route key is thrown at once, with no other key tried', async () => {
  // Catches: the ring's failover repeating the request on a core key the chain did not choose.
  const { llm, sent } = rig(() => ({ status: 402, body: { error: { message: 'Payment Required' } } }));
  await assert.rejects(
    llm.complete(ask, { role: 'core', model: 'x/core', routeKey: { name: 'helpers', value: SECRET_3 } }),
    { statusCode: 402 }
  );
  assert.deepEqual(sent(), [SECRET_3]);
});

test('a 429 that names credits on a route key is thrown at once, not retried', async () => {
  // Catches: a spent key retried with backoff, holding her turn for seconds before the chain can move on.
  const { llm, sent } = rig(() => ({ status: 429, body: { error: { message: 'Insufficient credits' } } }));
  await assert.rejects(
    llm.complete(ask, { role: 'core', model: 'x/core', routeKey: { name: 'helpers', value: SECRET_3 } }),
    { statusCode: 429 }
  );
  assert.equal(sent().length, 1);
});
