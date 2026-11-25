// Tests for src/keys/check.ts: the one minimal request that proves a key and a model, and the GET of /auth/key. The
// fetch is a fake that records the call; a failure never throws and never carries the key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkKey, checkRole } from '../../../src/keys/check.ts';
import { BASE_URL, SECRET, fakeFetch, healthy } from '../../fixtures/keys-rig.ts';
import type { Call, Reply } from '../../fixtures/keys-rig.ts';

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
  const sent = calls[0];
  assert.equal(sent?.auth, SECRET);
  assert.equal(sent?.body?.model, 'x/analyzer');
  // Bug caught: a probe that asks for a full answer, so every check costs real money.
  assert.ok(Number(sent?.body?.max_tokens) <= 8, 'the probe asks for a few tokens at most');
});

test('the embedding role is probed on the embeddings endpoint, not as a chat', async () => {
  const { fetch, calls } = fakeFetch();
  const result = await checkRole({ ...input, fetch, role: 'embedding', model: 'x/embed' });
  assert.equal(result.ok, true);
  assert.equal(result.isByok, null, 'an answer without is_byok reports null, not false');
  // Bug caught: sending a chat completion to an embedding model, which fails the check of a healthy key.
  const sent = calls[0];
  assert.ok(sent?.url.endsWith('/embeddings'));
  assert.equal(sent?.body?.model, 'x/embed');
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
  const sent = calls[0];
  assert.equal(sent?.method, 'GET');
  assert.ok(sent?.url.endsWith('/auth/key'));
  assert.equal(sent?.auth, SECRET);
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

// Speech and drawing. Speech has a probe of its own: one short synthesis on its endpoint, as a real voice message goes
// out. A drawing request bills a whole picture, so the drawing check reads the provider's free listing of that one model
// and asks whether it has image output. A listing that cannot be read leaves the role unchecked, `unsupported`, and is
// never worded as a refused key.

/** The audio bytes OpenRouter answers a synthesis with. */
const AUDIO: Reply = { status: 200, body: 'ID3-synthetic-audio' };

test('the speech probe sends one short synthesis on the speech endpoint with the voice and the key', async () => {
  // Bug: a chat completion to a speech model fails on a healthy key, or a real voice message's length is billed.
  const { fetch, calls } = fakeFetch(() => AUDIO);
  const result = await checkRole({ ...input, fetch, role: 'speech', model: 'x/voice', voice: 'voice-1' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  const sent = calls[0];
  assert.ok(sent?.url.endsWith('/audio/speech'));
  assert.equal(sent?.auth, SECRET);
  assert.equal(sent?.body?.model, 'x/voice');
  assert.equal(sent?.body?.voice, 'voice-1');
  assert.ok(String(sent?.body?.input).length <= 8, 'a few characters, so a check costs next to nothing');
});

test('a provider that refuses the speech probe is a failed check with its status and without the key', async () => {
  // Bug: a revoked key on the speech role reads as "no probe", so the owner never learns the key is bad.
  const { fetch } = fakeFetch(() => ({ status: 401, body: { error: { message: `Invalid key ${SECRET}` } } }));
  const result = await checkRole({ ...input, fetch, role: 'speech', model: 'x/voice', voice: 'voice-1' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.capability, undefined);
  assert.match(result.error ?? '', /Invalid key/);
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

/**
 * The provider as it lists models: each model's own listing under `/models/<id>/endpoints`, a drawing model and a text
 * model, 404 for any other id, and the list of all models, which holds the text model alone as the real one leaves out
 * a model that only makes pictures. A probe answer for anything else.
 */
function listing(call: Call): Reply {
  const own = (output: string): Reply => ({
    status: 200,
    body: { data: { architecture: { input_modalities: ['text'], output_modalities: [output] }, endpoints: [{}] } },
  });
  if (call.url.endsWith('/models/x/draw/endpoints')) return own('image');
  if (call.url.endsWith('/models/x/text/endpoints')) return own('text');
  if (call.url.endsWith('/endpoints')) return { status: 404, body: { error: { message: 'no such model' } } };
  if (call.url.endsWith('/models'))
    return {
      status: 200,
      body: { data: [{ id: 'x/text', architecture: { input_modalities: ['text'], output_modalities: ['text'] } }] },
    };
  return healthy(call);
}

test('a drawing check passes on a model the listing holds with image output and requests no picture', async () => {
  // Bug: the check sends a generation and bills a whole picture, or refuses a model that draws.
  const { fetch, calls } = fakeFetch(listing);
  const result = await checkRole({ ...input, fetch, role: 'drawing', model: 'x/draw' });
  assert.equal(result.ok, true);
  assert.equal(result.capability, undefined);
  // The list of all models leaves out a model that only makes pictures, so the check reads the model's own listing.
  assert.deepEqual(
    calls.map((call) => [call.method, call.url.slice(BASE_URL.length)]),
    [['GET', '/models/x/draw/endpoints']]
  );
});

test('a drawing check fails with the reason on a model the provider does not list', async () => {
  // Bug: a mistyped model id is saved as the drawing model and every drawing fails later.
  const { fetch } = fakeFetch(listing);
  const result = await checkRole({ ...input, fetch, role: 'drawing', model: 'x/none' });
  assert.equal(result.ok, false);
  assert.equal(result.capability, undefined);
  assert.match(result.error ?? '', /does not list/);
});

test('a drawing check fails with the reason on a model the listing holds with text output only', async () => {
  // Bug: a text model is saved as the drawing model and every drawing fails later.
  const { fetch } = fakeFetch(listing);
  const result = await checkRole({ ...input, fetch, role: 'drawing', model: 'x/text' });
  assert.equal(result.ok, false);
  assert.equal(result.capability, undefined);
  assert.match(result.error ?? '', /no image output/);
});

for (const [name, answer] of [
  ['answers 401', () => ({ status: 401, body: { error: { message: 'no' } } })],
  [
    'throws',
    () => {
      throw new Error('offline');
    },
  ],
] as const) {
  test(`a drawing check leaves the role unchecked when the listing ${name}`, async () => {
    // Bug: a listing the provider did not give refuses a working drawing model.
    const { fetch } = fakeFetch(answer);
    const result = await checkRole({ ...input, fetch, role: 'drawing', model: 'x/draw' });
    assert.equal(result.ok, false);
    assert.equal(result.capability, 'unsupported');
    assert.equal(result.error, null);
  });
}

test('a role with no probe at all is unsupported as well', async () => {
  // Bug: the fallthrough of the check labels every unimplemented role as a failure of its credentials.
  const { fetch, calls } = fakeFetch();
  const result = await checkRole({ ...input, fetch, role: 'nosuch', model: 'x/any' });
  assert.deepEqual(calls, []);
  assert.equal(result.capability, 'unsupported');
  assert.equal(result.error, null);
});
