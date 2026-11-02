// Tests for src/keys/check.ts: the one minimal request that proves a key and a model, and the GET of /auth/key. The
// fetch is a fake that records the call; a failure never throws and never carries the key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkKey, checkRole } from '../src/keys/check.ts';
import { BASE_URL, SECRET, fakeFetch } from './fixtures/keys-rig.ts';

const input = { baseUrl: BASE_URL, keyName: 'core-1', value: SECRET };

test('a chat role sends one short completion with the key and reports model, key name, cost and is_byok', async () => {
  const { fetch, calls } = fakeFetch(() => ({
    status: 200,
    body: { choices: [{ message: { content: 'ok' } }], usage: { cost: 0.012, is_byok: true } },
  }));
  const result = await checkRole({ ...input, fetch, role: 'analyzer', model: 'x/analyzer' });
  assert.deepEqual(result, {
    ok: true,
    role: 'analyzer',
    model: 'x/analyzer',
    keyName: 'core-1',
    isByok: true,
    status: 200,
    cost: 0.012,
    error: null,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.auth, SECRET);
  assert.equal(calls[0]?.body?.model, 'x/analyzer');
  // Bug caught: a probe that asks for a full answer, so every check costs real money.
  assert.ok(Number(calls[0]?.body?.max_tokens) <= 8, 'the probe asks for a few tokens at most');
});

test('the embedding role is probed on the embeddings endpoint, not as a chat', async () => {
  const { fetch, calls } = fakeFetch();
  const result = await checkRole({ ...input, fetch, role: 'embedding', model: 'x/embed' });
  assert.equal(result.ok, true);
  assert.equal(result.isByok, null, 'an answer without is_byok reports null, not false');
  // Bug caught: sending a chat completion to an embedding model, which fails the check of a healthy key.
  assert.ok(calls[0]?.url.endsWith('/embeddings'));
  assert.equal(calls[0]?.body?.model, 'x/embed');
});

test('a 200 whose body is an error is a failed check', async () => {
  const { fetch } = fakeFetch(() => ({ status: 200, body: { error: { message: 'No endpoints found for x/gone' } } }));
  const result = await checkRole({ ...input, fetch, role: 'core', model: 'x/gone' });
  // Bug caught: trusting the status alone, so a model OpenRouter does not serve passes the check.
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /No endpoints/);
});

test('a provider that echoes the key in its error does not put it into the result', async () => {
  const { fetch } = fakeFetch(() => ({ status: 401, body: { error: { message: `Invalid key ${SECRET}` } } }));
  const result = await checkRole({ ...input, fetch, role: 'core', model: 'x/core' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  // Bug caught: the provider's text copied into the answer and the log with the key inside it.
  assert.ok(!(result.error ?? '').includes('SECRETVALUE'));
  assert.ok(!JSON.stringify(result).includes('SECRETVALUE'));
});

test('a network failure is a failed result with no status, not a throw', async () => {
  const fetch = (() =>
    Promise.reject(new Error(`connect refused for ${SECRET}`))) as unknown as typeof globalThis.fetch;
  const result = await checkRole({ ...input, fetch, role: 'core', model: 'x/core' });
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.ok(!(result.error ?? '').includes('SECRETVALUE'));
});

test('checkKey is one GET of /auth/key and reads the limit and usage', async () => {
  const { fetch, calls } = fakeFetch();
  const info = await checkKey({ baseUrl: BASE_URL, fetch, value: SECRET });
  assert.deepEqual(info, { ok: true, status: 200, limit: 100, usage: 1, error: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'GET');
  assert.ok(calls[0]?.url.endsWith('/auth/key'));
  assert.equal(calls[0]?.auth, SECRET);
});

test('checkKey on a rejected key is not ok and says the status', async () => {
  const { fetch } = fakeFetch(() => ({ status: 401, body: { error: { message: 'User not found.' } } }));
  const info = await checkKey({ baseUrl: BASE_URL, fetch, value: SECRET });
  assert.equal(info.ok, false);
  assert.equal(info.status, 401);
});

test('a request that never answers is aborted at the timeout and reported as a failed check', async () => {
  // A fetch that settles only when the caller aborts it.
  const fetch = ((_url: string, init: { signal: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof globalThis.fetch;
  // Bug caught: a probe with no timeout hanging the chat command on a provider that accepts the connection and goes quiet.
  const result = await checkRole({ ...input, fetch, role: 'core', model: 'x/core', timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
});

test('a long provider body is cut in the error', async () => {
  const { fetch } = fakeFetch(() => ({ status: 500, body: 'x'.repeat(5000) }));
  const result = await checkRole({ ...input, fetch, role: 'core', model: 'x/core' });
  assert.ok((result.error ?? '').length <= 500);
});
