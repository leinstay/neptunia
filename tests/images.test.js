// Tests for src/llm/images.js: the request body per model family, the image
// rails (instance and per-member daily caps), retries, error reasons and the
// quota view. No network: fetchImpl is always a fake. Only ONE test exercises
// the real retry backoff sleep (~1.5s), as in the chat client's tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createImageGen,
  familyOf,
  ImageGenError,
  ImageCapError,
  UnsupportedImageModelError,
} from '../src/llm/images.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-28T12:00:00Z');

function baseConfig(overrides = {}) {
  return {
    llm: { baseUrl: 'https://openrouter.ai/api/v1/' },
    image: {
      model: 'openai/test-image',
      maxPerDay: 50,
      maxPerUserPerDay: 50,
      outputFormat: 'png',
      aspectRatio: 'auto',
      timeoutMs: 5000,
      retries: 1,
      provider: null,
      openai: { quality: 'medium', background: 'auto', moderation: 'low' },
      google: { resolution: '1K' },
      ...overrides,
    },
  };
}

function fakeState(data = {}) {
  return { data, dirty: 0, markDirty() { this.dirty += 1; } };
}

const PIXELS = Buffer.from('fake picture bytes');

function okResponse(json = { data: [{ b64_json: PIXELS.toString('base64'), media_type: 'image/png' }], usage: { total_tokens: 10, cost: 0.04 } }) {
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
}

function errorResponse(status, text = '{"error":{"message":"upstream failed"}}') {
  return { ok: false, status, text: async () => text, json: async () => JSON.parse(text) };
}

/** A fetch fake that records every call and plays `responses` in order (the last one repeats). */
function fakeFetch(...responses) {
  const calls = [];
  async function impl(url, init) {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  }
  impl.calls = calls;
  return impl;
}

function makeGen({ config = baseConfig(), state = fakeState(), fetchImpl = fakeFetch(okResponse()), now = () => NOW } = {}) {
  const gen = createImageGen({ apiKey: 'test-key', getConfig: () => config, state, fetchImpl, now });
  return { gen, state, fetchImpl };
}

test('images: OpenAI body carries quality, background, output_format, aspect_ratio and nested moderation', async () => {
  const { gen, fetchImpl } = makeGen();
  await gen.generate({ prompt: 'a small boat' });
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init, body } = fetchImpl.calls[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/images');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer test-key');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.ok(init.signal, 'a per-attempt timeout signal is attached');
  assert.deepEqual(body, {
    model: 'openai/test-image',
    prompt: 'a small boat',
    output_format: 'png',
    aspect_ratio: 'auto',
    quality: 'medium',
    background: 'auto',
    provider: { options: { openai: { moderation: 'low' } } },
  });
  assert.equal('n' in body, false);
});

test('images: Google body carries resolution and omits aspect_ratio on auto', async () => {
  const { gen, fetchImpl } = makeGen({ config: baseConfig({ model: 'google/test-image' }) });
  await gen.generate({ prompt: 'a small boat' });
  assert.deepEqual(fetchImpl.calls[0].body, {
    model: 'google/test-image',
    prompt: 'a small boat',
    output_format: 'png',
    resolution: '1K',
  });
});

test('images: null values omit their fields', async () => {
  const config = baseConfig({ outputFormat: null, aspectRatio: null, openai: { quality: null, background: null, moderation: null } });
  const { gen, fetchImpl } = makeGen({ config });
  await gen.generate({ prompt: 'a small boat' });
  assert.deepEqual(fetchImpl.calls[0].body, { model: 'openai/test-image', prompt: 'a small boat' });
});

test('images: image.provider is merged and OpenAI moderation is nested into it', async () => {
  const provider = { order: ['openai'], options: { openai: { moderation: 'auto', user: 'x' } } };
  const config = baseConfig({ provider });
  const { gen, fetchImpl } = makeGen({ config });
  await gen.generate({ prompt: 'a small boat' });
  assert.deepEqual(fetchImpl.calls[0].body.provider, {
    order: ['openai'],
    options: { openai: { moderation: 'low', user: 'x' } },
  });
  assert.equal(provider.options.openai.moderation, 'auto', 'the config object is not mutated');
});

test('images: reference becomes input_references', async () => {
  const { gen, fetchImpl } = makeGen();
  const reference = 'data:image/png;base64,AAAA';
  await gen.generate({ prompt: 'a small boat', reference });
  assert.deepEqual(fetchImpl.calls[0].body.input_references, [{ type: 'image_url', image_url: { url: reference } }]);
});

test('images: unsupported model prefix is refused without a request', async () => {
  const state = fakeState();
  const { gen, fetchImpl } = makeGen({ config: baseConfig({ model: 'acme/painter' }), state });
  await assert.rejects(gen.generate({ prompt: 'a small boat', userId: 'u1' }), UnsupportedImageModelError);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(state.data.imageCount ?? 0, 0);
  assert.equal(state.data.imageUsers?.counts?.u1 ?? 0, 0);
  assert.equal(state.dirty, 0);
});

test('images: response b64_json becomes a Buffer with media_type and cost', async () => {
  const json = { data: [{ b64_json: PIXELS.toString('base64'), media_type: 'image/webp' }], usage: { total_tokens: 7, cost: 0.02 } };
  const { gen } = makeGen({ fetchImpl: fakeFetch(okResponse(json)) });
  const result = await gen.generate({ prompt: 'a small boat' });
  assert.ok(Buffer.isBuffer(result.buffer));
  assert.deepEqual(result.buffer, PIXELS);
  assert.equal(result.mediaType, 'image/webp');
  assert.equal(result.cost, 0.02);
  assert.deepEqual(result.usage, { total_tokens: 7, cost: 0.02 });
  assert.equal(result.model, 'openai/test-image');
  assert.equal(typeof result.seconds, 'number');
});

test('images: media type falls back to the output format and cost to null', async () => {
  const json = { data: [{ b64_json: PIXELS.toString('base64') }] };
  const { gen } = makeGen({ config: baseConfig({ outputFormat: 'jpeg' }), fetchImpl: fakeFetch(okResponse(json)) });
  const result = await gen.generate({ prompt: 'a small boat' });
  assert.equal(result.mediaType, 'image/jpeg');
  assert.equal(result.cost, null);
  assert.equal(result.usage, null);
});

test('images: missing image data is an ImageGenError with reason empty', async () => {
  const { gen } = makeGen({ fetchImpl: fakeFetch(okResponse({ data: [] })) });
  await assert.rejects(gen.generate({ prompt: 'a small boat' }), (err) => {
    assert.ok(err instanceof ImageGenError);
    assert.equal(err.reason, 'empty');
    return true;
  });
});

test('images: daily cap refuses before the request and persists imageDay/imageCount', async () => {
  const state = fakeState();
  const { gen, fetchImpl } = makeGen({ config: baseConfig({ maxPerDay: 2 }), state });
  await gen.generate({ prompt: 'one' });
  await gen.generate({ prompt: 'two' });
  assert.equal(state.data.imageDay, '2026-09-28');
  assert.equal(state.data.imageCount, 2);
  assert.equal(state.dirty, 2);
  await assert.rejects(gen.generate({ prompt: 'three' }), (err) => {
    assert.ok(err instanceof ImageCapError);
    assert.equal(err.reason, 'daily');
    return true;
  });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(state.data.imageCount, 2);
});

test('images: a cap that is not a finite number counts as 0 -- refused before any request, quota spent', async () => {
  for (const cap of [undefined, null, Number.NaN, '5']) {
    const daily = makeGen({ config: baseConfig({ maxPerDay: cap }) });
    await assert.rejects(daily.gen.generate({ prompt: 'one' }), (err) => {
      assert.ok(err instanceof ImageCapError, String(cap));
      assert.equal(err.reason, 'daily');
      assert.equal(err.cap, 0);
      return true;
    });
    assert.equal(daily.fetchImpl.calls.length, 0, String(cap));
    assert.equal(daily.state.data.imageCount ?? 0, 0);
    assert.equal(daily.gen.quota().spent, true);
    assert.equal(daily.gen.quota().cap, 0);

    const member = makeGen({ config: baseConfig({ maxPerUserPerDay: cap }) });
    await assert.rejects(member.gen.generate({ prompt: 'one', userId: 'u1' }), (err) => {
      assert.ok(err instanceof ImageCapError, String(cap));
      assert.equal(err.reason, 'userDaily');
      assert.equal(err.cap, 0);
      return true;
    });
    assert.equal(member.fetchImpl.calls.length, 0, String(cap));
    assert.equal(member.gen.quota({ userId: 'u1' }).userSpent, true);
    assert.equal(member.gen.quota({ userId: 'u1' }).userCap, 0);
  }
});

test('images: a failed request still counts', async () => {
  const state = fakeState();
  const { gen } = makeGen({ config: baseConfig({ retries: 0 }), state, fetchImpl: fakeFetch(errorResponse(400)) });
  await assert.rejects(gen.generate({ prompt: 'one', userId: 'u1' }), ImageGenError);
  assert.equal(state.data.imageCount, 1);
  assert.equal(state.data.imageUsers.counts.u1, 1);
});

test('images: per-member cap refuses with reason userDaily and userId null skips it', async () => {
  const state = fakeState();
  const { gen, fetchImpl } = makeGen({ config: baseConfig({ maxPerUserPerDay: 1 }), state });
  await gen.generate({ prompt: 'one', userId: 'u1' });
  assert.deepEqual(state.data.imageUsers, { day: '2026-09-28', counts: { u1: 1 } });
  await assert.rejects(gen.generate({ prompt: 'two', userId: 'u1' }), (err) => {
    assert.ok(err instanceof ImageCapError);
    assert.equal(err.reason, 'userDaily');
    return true;
  });
  assert.equal(state.data.imageCount, 1, 'a refused request costs nothing');
  await gen.generate({ prompt: 'three', userId: 'u2' });
  await gen.generate({ prompt: 'four' });
  await gen.generate({ prompt: 'five', userId: null });
  assert.equal(fetchImpl.calls.length, 4);
  assert.equal(state.data.imageCount, 4);
  assert.deepEqual(state.data.imageUsers.counts, { u1: 1, u2: 1 });
});

test('images: ImageCapError carries the limit key, the used count and the cap', async () => {
  const state = fakeState();
  const { gen } = makeGen({ config: baseConfig({ maxPerDay: 2, maxPerUserPerDay: 1 }), state });
  await gen.generate({ prompt: 'one', userId: 'u1' });
  await assert.rejects(gen.generate({ prompt: 'two', userId: 'u1' }), (err) => {
    assert.ok(err instanceof ImageCapError);
    assert.equal(err.message, 'daily per-member image cap reached (1)');
    assert.equal(err.key, 'image.maxPerUserPerDay');
    assert.equal(err.used, 1);
    assert.equal(err.cap, 1);
    return true;
  });
  await gen.generate({ prompt: 'three', userId: 'u2' });
  await assert.rejects(gen.generate({ prompt: 'four', userId: 'u3' }), (err) => {
    assert.ok(err instanceof ImageCapError);
    assert.equal(err.message, 'daily image cap reached (2)');
    assert.equal(err.key, 'image.maxPerDay');
    assert.equal(err.used, 2);
    assert.equal(err.cap, 2);
    return true;
  });
});

test('images: counters roll over on a new day', async () => {
  const state = fakeState({
    imageDay: '2026-09-27',
    imageCount: 50,
    imageUsers: { day: '2026-09-27', counts: { u1: 50 } },
  });
  let clock = NOW - DAY_MS;
  const { gen, fetchImpl } = makeGen({ state, now: () => clock });
  await assert.rejects(gen.generate({ prompt: 'yesterday', userId: 'u1' }), ImageCapError);
  clock = NOW;
  await gen.generate({ prompt: 'today', userId: 'u1' });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(state.data.imageDay, '2026-09-28');
  assert.equal(state.data.imageCount, 1);
  assert.deepEqual(state.data.imageUsers, { day: '2026-09-28', counts: { u1: 1 } });
});

// The one test that waits for the real backoff (~1.5s before attempt 1).
test('images: 502 is retried up to image.retries then fails with reason error', async () => {
  const state = fakeState();
  const { gen, fetchImpl } = makeGen({ config: baseConfig({ retries: 1 }), state, fetchImpl: fakeFetch(errorResponse(502)) });
  await assert.rejects(gen.generate({ prompt: 'a small boat' }), (err) => {
    assert.ok(err instanceof ImageGenError);
    assert.equal(err.reason, 'error');
    assert.equal(err.statusCode, 502);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(state.data.imageCount, 1, 'one generate call counts once, retries included');
});

test('images: a negative or non-numeric image.retries still sends exactly one request and fails with reason error', async () => {
  for (const retries of [-1, 'x']) {
    const { gen, fetchImpl } = makeGen({ config: baseConfig({ retries }), fetchImpl: fakeFetch(errorResponse(502)) });
    await assert.rejects(gen.generate({ prompt: 'a small boat' }), (err) => {
      assert.ok(err instanceof ImageGenError, `retries ${retries}: an ImageGenError, not a TypeError`);
      assert.equal(err.reason, 'error');
      assert.equal(err.statusCode, 502);
      return true;
    });
    assert.equal(fetchImpl.calls.length, 1, `retries ${retries}: one request`);
  }
});

test('images: moderation-looking 400 is not retried and has reason moderation', async () => {
  const body = '{"error":{"code":"moderation_blocked","message":"Your request was rejected by the safety system."}}';
  const { gen, fetchImpl } = makeGen({ config: baseConfig({ retries: 3 }), fetchImpl: fakeFetch(errorResponse(400, body)) });
  await assert.rejects(gen.generate({ prompt: 'a small boat' }), (err) => {
    assert.ok(err instanceof ImageGenError);
    assert.equal(err.reason, 'moderation');
    assert.equal(err.statusCode, 400);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);
});

test('images: a plain 400 is not retried and has reason error', async () => {
  const { gen, fetchImpl } = makeGen({ config: baseConfig({ retries: 3 }), fetchImpl: fakeFetch(errorResponse(400, '{"error":{"message":"bad size"}}')) });
  await assert.rejects(gen.generate({ prompt: 'a small boat' }), (err) => {
    assert.equal(err.reason, 'error');
    assert.equal(err.statusCode, 400);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);
});

test('images: abort is reported as timeout', async () => {
  const abort = new Error('This operation was aborted');
  abort.name = 'AbortError';
  const { gen, fetchImpl } = makeGen({ config: baseConfig({ retries: 1 }), fetchImpl: fakeFetch(abort) });
  await assert.rejects(gen.generate({ prompt: 'a small boat' }), (err) => {
    assert.ok(err instanceof ImageGenError);
    assert.equal(err.reason, 'timeout');
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1, 'a timed-out generation is not retried');
});

test('images: quota reports used, cap and spent flags', async () => {
  const state = fakeState();
  const { gen } = makeGen({ config: baseConfig({ maxPerDay: 3, maxPerUserPerDay: 1 }), state });
  assert.deepEqual(gen.quota(), { used: 0, cap: 3, userUsed: 0, userCap: 1, spent: false, userSpent: false });
  await gen.generate({ prompt: 'one', userId: 'u1' });
  await gen.generate({ prompt: 'two' });
  assert.deepEqual(gen.quota({ userId: 'u1' }), { used: 2, cap: 3, userUsed: 1, userCap: 1, spent: false, userSpent: true });
  assert.deepEqual(gen.quota({ userId: 'u2' }), { used: 2, cap: 3, userUsed: 0, userCap: 1, spent: false, userSpent: false });
  await gen.generate({ prompt: 'three' });
  assert.equal(gen.quota().spent, true);
});

test('images: quota ignores yesterday\'s counters without resetting them', () => {
  const state = fakeState({ imageDay: '2026-09-27', imageCount: 9, imageUsers: { day: '2026-09-27', counts: { u1: 9 } } });
  const { gen } = makeGen({ state });
  assert.deepEqual(gen.quota({ userId: 'u1' }), { used: 0, cap: 50, userUsed: 0, userCap: 50, spent: false, userSpent: false });
  assert.equal(state.data.imageCount, 9);
  assert.equal(state.dirty, 0);
});

test('images: quota reads a stored count that is not a finite number >= 0 as 0, for the instance and for a member', () => {
  for (const bad of ['many', -4, NaN, Infinity, {}]) {
    const data = { imageDay: '2026-09-28', imageCount: bad, imageUsers: { day: '2026-09-28', counts: { u1: bad } } };
    const state = fakeState(structuredClone(data));
    const { gen } = makeGen({ state });
    assert.deepEqual(gen.quota({ userId: 'u1' }), { used: 0, cap: 50, userUsed: 0, userCap: 50, spent: false, userSpent: false }, String(bad));
    assert.deepEqual(state.data, data, `a read leaves the stored value alone (${String(bad)})`);
    assert.equal(state.dirty, 0);
  }
  // A member table that is not a table at all is read as no use, never thrown on.
  for (const imageUsers of [null, 'x', { day: '2026-09-28' }, { day: '2026-09-28', counts: 'x' }]) {
    const { gen } = makeGen({ state: fakeState({ imageDay: '2026-09-28', imageCount: 2, imageUsers }) });
    assert.deepEqual(gen.quota({ userId: 'u1' }), { used: 2, cap: 50, userUsed: 0, userCap: 50, spent: false, userSpent: false }, JSON.stringify(imageUsers));
  }
});

test('images: familyOf maps prefixes', () => {
  assert.equal(familyOf('openai/gpt-image-2.5-flare'), 'openai');
  assert.equal(familyOf('google/some-image-model'), 'google');
  assert.equal(familyOf('acme/painter'), null);
  assert.equal(familyOf(''), null);
  assert.equal(familyOf(null), null);
  const { gen } = makeGen();
  assert.equal(gen.familyOf('google/x'), 'google');
});

// --- provider routing per model family (llm.providerByModel) ---

test('images: llm.providerByModel (longest prefix) wins over image.provider, with moderation merged over it', async () => {
  const config = baseConfig({ provider: { ignore: ['some-provider'] } });
  config.llm.providerByModel = {
    'openai/': { only: ['azure'] },
    'openai/test-image': { only: ['openai'], allow_fallbacks: false },
  };
  const { gen, fetchImpl } = makeGen({ config });
  await gen.generate({ prompt: 'a small boat' });
  assert.deepEqual(fetchImpl.calls[0].body.provider, {
    only: ['openai'],
    allow_fallbacks: false,
    options: { openai: { moderation: 'low' } },
  });
  assert.deepEqual(config.llm.providerByModel['openai/test-image'], { only: ['openai'], allow_fallbacks: false }, 'the config object is not mutated');
});

test('images: a model with no valid by-model entry falls back to image.provider, then to nothing', async () => {
  const config = baseConfig({ model: 'google/test-image', provider: { order: ['google-vertex'] } });
  config.llm.providerByModel = { 'openai/': { only: ['openai'] }, 'google/test-image': 'google-vertex' };
  const { gen, fetchImpl } = makeGen({ config });
  await gen.generate({ prompt: 'a small boat' });
  assert.deepEqual(fetchImpl.calls[0].body.provider, { order: ['google-vertex'] });
  config.image.provider = null;
  await gen.generate({ prompt: 'a small boat' });
  assert.equal('provider' in fetchImpl.calls[1].body, false);
});

test('images: llm.providerByModel is read fresh on every generation', async () => {
  const config = baseConfig({ model: 'google/test-image' });
  const { gen, fetchImpl } = makeGen({ config });
  await gen.generate({ prompt: 'a small boat' });
  config.llm.providerByModel = { 'google/': { only: ['google-vertex'] } };
  await gen.generate({ prompt: 'a small boat' });
  assert.equal('provider' in fetchImpl.calls[0].body, false);
  assert.deepEqual(fetchImpl.calls[1].body.provider, { only: ['google-vertex'] });
});

test('images: a generation routes as the image role; an @image key beats a longer role-less one, other roles never apply', async () => {
  const config = baseConfig({ model: 'google/test-image', provider: { ignore: ['some-provider'] } });
  config.llm.providerByModel = {
    'google/test-image': { only: ['google-vertex'] },
    'google/@image': { only: ['google-ai-studio'], allow_fallbacks: false },
    'google/test-image@voice': { only: ['other'] },
  };
  const { gen, fetchImpl } = makeGen({ config });
  await gen.generate({ prompt: 'a small boat' });
  assert.deepEqual(fetchImpl.calls[0].body.provider, { only: ['google-ai-studio'], allow_fallbacks: false });
  delete config.llm.providerByModel['google/@image'];
  await gen.generate({ prompt: 'a small boat' });
  assert.deepEqual(fetchImpl.calls[1].body.provider, { only: ['google-vertex'] });
  config.llm.providerByModel = { 'google/@voice': { only: ['other'] } };
  await gen.generate({ prompt: 'a small boat' });
  assert.deepEqual(fetchImpl.calls[2].body.provider, { ignore: ['some-provider'] });
});
