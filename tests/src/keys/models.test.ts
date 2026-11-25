// Tests for src/keys/models.ts: the models the `model set` dialog offers for a role, read from a fake `/models`.
// The fetch is a fake that records each call; nothing reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { roleModelListing } from '../../../src/keys/models.ts';

const entry = (id: unknown, input: Array<string>, output: Array<string>) => ({
  id,
  architecture: { input_modalities: input, output_modalities: output },
});

const LISTING = [
  entry('text/one', ['text'], ['text']),
  entry('vision/one', ['text', 'image'], ['text']),
  entry('draw/one', ['text'], ['image']),
  entry('vision/two', ['image'], ['text']),
  { id: 'bare/one' },
];

/** A fetch that answers `body` with `status` and records the address and the headers of every call. */
function fakeFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetch = ((url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const BASE = 'https://router.test/api/v1/';

test('roleModelListing: a vision role gets the models that take images and give text, in the listing order', async () => {
  const { fetch, calls } = fakeFetch({ data: LISTING });
  const listing = await roleModelListing({ fetch, baseUrl: BASE, value: 'sk-test' }, 'vision');
  assert.deepEqual(listing, { ok: true, models: ['vision/one', 'vision/two'] });
  assert.equal(calls[0]?.url, 'https://router.test/api/v1/models');
  const firstCall = calls[0];
  assert.equal(firstCall?.headers.Authorization, 'Bearer sk-test');
});

test('roleModelListing: a drawing role is chosen by its image output whatever the model takes in', async () => {
  const { fetch } = fakeFetch({ data: LISTING });
  assert.deepEqual(await roleModelListing({ fetch, baseUrl: BASE, value: 'sk-test' }, 'drawing'), {
    ok: true,
    models: ['draw/one'],
  });
});

test('roleModelListing: a role with no fit gets an empty list without a request', async () => {
  const { fetch, calls } = fakeFetch({ data: LISTING });
  assert.deepEqual(await roleModelListing({ fetch, baseUrl: BASE, value: 'sk-test' }, 'toString'), {
    ok: true,
    models: [],
  });
  assert.equal(calls.length, 0);
});

test('roleModelListing: a refused listing is no listing', async () => {
  const { fetch } = fakeFetch({ data: LISTING }, 401);
  assert.deepEqual(await roleModelListing({ fetch, baseUrl: BASE, value: 'sk-test' }, 'core'), { ok: false });
});

test('roleModelListing: a body without a data list is no listing', async () => {
  const { fetch } = fakeFetch({ models: LISTING });
  assert.deepEqual(await roleModelListing({ fetch, baseUrl: BASE, value: 'sk-test' }, 'core'), { ok: false });
});

test('roleModelListing: a fetch that throws is no listing', async () => {
  const fetch = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof globalThis.fetch;
  assert.deepEqual(await roleModelListing({ fetch, baseUrl: BASE, value: 'sk-test' }, 'core'), { ok: false });
});

test('roleModelListing: an entry that fits without a string id is left out', async () => {
  const { fetch } = fakeFetch({ data: [entry(42, ['text'], ['text']), entry('text/one', ['text'], ['text'])] });
  assert.deepEqual(await roleModelListing({ fetch, baseUrl: BASE, value: 'sk-test' }, 'memory'), {
    ok: true,
    models: ['text/one'],
  });
});
