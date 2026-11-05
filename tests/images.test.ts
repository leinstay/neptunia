// Tests for src/llm/images.ts: the request body per model family, retries and
// error reasons (PR 7d: the daily caps and the quota view are gone). No network: fetchImpl is always a fake. Only ONE test exercises
// the real retry backoff sleep (~1.5s), as in the chat client's tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImageGen, familyOf, ImageGenError, UnsupportedImageModelError } from '../src/llm/images.ts';
import { NotByokError } from '../src/llm/openrouter.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import type { Untyped } from '../src/tools/types.ts';
import { wrongly } from './fixtures/loose-types.ts';

const NOW = Date.parse('2026-09-28T12:00:00Z');

function baseConfig({ model = 'openai/test-image', ...overrides } = {}) {
  return {
    llm: { baseUrl: 'https://openrouter.ai/api/v1/' },
    models: { base: { drawing: model } },
    // PR 7d: the daily caps are gone and the output format, aspect ratio and background are constants (png, auto, auto).
    image: {
      timeoutMs: 5000,
      retries: 1,
      provider: null,
      openai: { quality: 'medium', moderation: 'low' },
      google: { resolution: '1K' },
      ...overrides,
    },
  };
}

function fakeState(data: Record<string, Untyped> = {}) {
  return {
    data,
    dirty: 0,
    markDirty() {
      this.dirty += 1;
    },
  };
}

const PIXELS = Buffer.from('fake picture bytes');

function okResponse(
  json = {
    data: [{ b64_json: PIXELS.toString('base64'), media_type: 'image/png' }],
    usage: { total_tokens: 10, cost: 0.04 },
  }
) {
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
}

function errorResponse(status: number, text = '{"error":{"message":"upstream failed"}}') {
  return { ok: false, status, text: async () => text, json: async () => JSON.parse(text) };
}

type FetchCall = {
  url: string;
  init: { method: string; headers: Record<string, string>; signal?: unknown; body: string };
  body: Record<string, Untyped>;
};

/** A fetch fake that records every call and plays `responses` in order (the last one repeats). */
function fakeFetch(...responses: Array<unknown>) {
  const calls: Array<FetchCall> = [];
  async function impl(url: string, init: FetchCall['init']): Promise<unknown> {
    calls.push({ url, init, body: wrongly<Record<string, Untyped>>(JSON.parse(init.body)) });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  }
  return Object.assign(impl, { calls });
}

function makeGen({
  config = baseConfig(),
  state = fakeState(),
  fetchImpl = fakeFetch(okResponse()),
  now = () => NOW,
}: {
  config?: Untyped;
  state?: ReturnType<typeof fakeState>;
  fetchImpl?: ReturnType<typeof fakeFetch>;
  now?: () => number;
} = {}) {
  const gen = createImageGen(wrongly({ apiKey: 'test-key', getConfig: () => config, state, fetchImpl, now }));
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
  const config = baseConfig(wrongly({ openai: { quality: null, moderation: null } }));
  const { gen, fetchImpl } = makeGen({ config });
  await gen.generate({ prompt: 'a small boat' });
  // PR 7d: the format, ratio and background are constants, so only the settings set to null are omitted.
  assert.deepEqual(fetchImpl.calls[0].body, {
    model: 'openai/test-image',
    prompt: 'a small boat',
    output_format: 'png',
    aspect_ratio: 'auto',
    background: 'auto',
  });
});

test('images: image.provider is merged and OpenAI moderation is nested into it', async () => {
  const provider = { order: ['openai'], options: { openai: { moderation: 'auto', user: 'x' } } };
  const config = baseConfig(wrongly({ provider }));
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
  await assert.rejects(gen.generate(wrongly({ prompt: 'a small boat', accountId: 'u1' })), UnsupportedImageModelError);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(state.data.imageCount ?? 0, 0);
  assert.equal(state.data.imageUsers?.counts?.u1 ?? 0, 0);
  assert.equal(state.dirty, 0);
});

test('images: response b64_json becomes a Buffer with media_type and cost', async () => {
  const json = {
    data: [{ b64_json: PIXELS.toString('base64'), media_type: 'image/webp' }],
    usage: { total_tokens: 7, cost: 0.02 },
  };
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
  const json: Untyped = { data: [{ b64_json: PIXELS.toString('base64') }] };
  const { gen } = makeGen({ fetchImpl: fakeFetch(okResponse(json)) });
  const result = await gen.generate({ prompt: 'a small boat' });
  // PR 7d: the output format is the constant png.
  assert.equal(result.mediaType, 'image/png');
  assert.equal(result.cost, null);
  assert.equal(result.usage, null);
});

test('images: missing image data is an ImageGenError with reason empty', async () => {
  const { gen } = makeGen({ fetchImpl: fakeFetch(okResponse(wrongly({ data: [] }))) });
  await assert.rejects(gen.generate({ prompt: 'a small boat' }), (err) => {
    assert.ok(err instanceof ImageGenError);
    assert.equal(err.reason, 'empty');
    return true;
  });
});

test('images: 502 is retried up to image.retries then fails with reason error', async () => {
  const state = fakeState();
  const { gen, fetchImpl } = makeGen({
    config: baseConfig(wrongly({ retries: 1 })),
    state,
    fetchImpl: fakeFetch(errorResponse(502)),
  });
  await assert.rejects(gen.generate({ prompt: 'a small boat' }), (err) => {
    assert.ok(err instanceof ImageGenError);
    assert.equal(err.reason, 'error');
    assert.equal(err.statusCode, 502);
    return true;
  });
  // PR 7d: nothing counts a picture a day, so the count assertion went with the cap.
  assert.equal(fetchImpl.calls.length, 2);
});

test('images: a negative or non-numeric image.retries still sends exactly one request and fails with reason error', async () => {
  for (const retries of [-1, 'x']) {
    const { gen, fetchImpl } = makeGen({
      config: baseConfig(wrongly({ retries })),
      fetchImpl: fakeFetch(errorResponse(502)),
    });
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
  const { gen, fetchImpl } = makeGen({
    config: baseConfig(wrongly({ retries: 3 })),
    fetchImpl: fakeFetch(errorResponse(400, body)),
  });
  await assert.rejects(gen.generate({ prompt: 'a small boat' }), (err) => {
    assert.ok(err instanceof ImageGenError);
    assert.equal(err.reason, 'moderation');
    assert.equal(err.statusCode, 400);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);
});

test('images: a plain 400 is not retried and has reason error', async () => {
  const { gen, fetchImpl } = makeGen({
    config: baseConfig(wrongly({ retries: 3 })),
    fetchImpl: fakeFetch(errorResponse(400, '{"error":{"message":"bad size"}}')),
  });
  await assert.rejects(gen.generate({ prompt: 'a small boat' }), (err: Record<string, Untyped>) => {
    assert.equal(err.reason, 'error');
    assert.equal(err.statusCode, 400);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);
});

test('images: abort is reported as timeout', async () => {
  const abort = new Error('This operation was aborted');
  abort.name = 'AbortError';
  const { gen, fetchImpl } = makeGen({ config: baseConfig(wrongly({ retries: 1 })), fetchImpl: fakeFetch(abort) });
  await assert.rejects(gen.generate({ prompt: 'a small boat' }), (err) => {
    assert.ok(err instanceof ImageGenError);
    assert.equal(err.reason, 'timeout');
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1, 'a timed-out generation is not retried');
});

// PR 7d: the daily caps of plan section 4.5 are gone with their counters and the quota view, so the tests of the
// caps, the counters and quota() went with them.
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
  const config: Record<string, Untyped> = baseConfig(wrongly({ provider: { ignore: ['some-provider'] } }));
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
  assert.deepEqual(
    config.llm.providerByModel['openai/test-image'],
    { only: ['openai'], allow_fallbacks: false },
    'the config object is not mutated'
  );
});

test('images: a model with no valid by-model entry falls back to image.provider, then to nothing', async () => {
  const config: Record<string, Untyped> = baseConfig(
    wrongly({ model: 'google/test-image', provider: { order: ['google-vertex'] } })
  );
  config.llm.providerByModel = { 'openai/': { only: ['openai'] }, 'google/test-image': 'google-vertex' };
  const { gen, fetchImpl } = makeGen({ config });
  await gen.generate({ prompt: 'a small boat' });
  assert.deepEqual(fetchImpl.calls[0].body.provider, { order: ['google-vertex'] });
  config.image.provider = null;
  await gen.generate({ prompt: 'a small boat' });
  assert.equal('provider' in fetchImpl.calls[1].body, false);
});

test('images: llm.providerByModel is read fresh on every generation', async () => {
  const config: Record<string, Untyped> = baseConfig({ model: 'google/test-image' });
  const { gen, fetchImpl } = makeGen({ config });
  await gen.generate({ prompt: 'a small boat' });
  config.llm.providerByModel = { 'google/': { only: ['google-vertex'] } };
  await gen.generate({ prompt: 'a small boat' });
  assert.equal('provider' in fetchImpl.calls[0].body, false);
  assert.deepEqual(fetchImpl.calls[1].body.provider, { only: ['google-vertex'] });
});

test('images: a generation routes as the drawing role; an @drawing key beats a longer role-less one, other roles never apply', async () => {
  const config: Record<string, Untyped> = baseConfig(
    wrongly({ model: 'google/test-image', provider: { ignore: ['some-provider'] } })
  );
  config.llm.providerByModel = {
    'google/test-image': { only: ['google-vertex'] },
    'google/@drawing': { only: ['google-ai-studio'], allow_fallbacks: false },
    'google/test-image@core': { only: ['other'] },
  };
  const { gen, fetchImpl } = makeGen({ config });
  await gen.generate({ prompt: 'a small boat' });
  assert.deepEqual(fetchImpl.calls[0].body.provider, { only: ['google-ai-studio'], allow_fallbacks: false });
  delete config.llm.providerByModel['google/@drawing'];
  await gen.generate({ prompt: 'a small boat' });
  assert.deepEqual(fetchImpl.calls[1].body.provider, { only: ['google-vertex'] });
  config.llm.providerByModel = { 'google/@core': { only: ['other'] } };
  await gen.generate({ prompt: 'a small boat' });
  assert.deepEqual(fetchImpl.calls[2].body.provider, { ignore: ['some-provider'] });
});

// --- byok routes: a picture OpenRouter served from its own capacity on a `byok: true` route ---

/** An OK answer whose usage says `is_byok` (undefined: no such field), served by `OpenAI`. */
function byokResponse(isByok: Untyped) {
  return okResponse(
    wrongly({
      provider: 'OpenAI',
      data: [{ b64_json: PIXELS.toString('base64'), media_type: 'image/png' }],
      usage: { total_tokens: 10, cost: 0.04, ...(isByok === undefined ? {} : { is_byok: isByok }) },
    })
  );
}

test("images: the body's provider never carries byok; the config route keeps it", async () => {
  const config: Record<string, Untyped> = baseConfig();
  config.llm.providerByModel = { 'openai/@drawing': { only: ['openai'], allow_fallbacks: false, byok: true } };
  const { gen, fetchImpl } = makeGen({ config, fetchImpl: fakeFetch(byokResponse(true)) });
  await withCapturedLogs(() => gen.generate({ prompt: 'a small boat' }));
  assert.deepEqual(fetchImpl.calls[0].body.provider, {
    only: ['openai'],
    allow_fallbacks: false,
    options: { openai: { moderation: 'low' } },
  });
  assert.equal(config.llm.providerByModel['openai/@drawing'].byok, true, 'the config object is not mutated');
});

test('images: a byok route with is_byok false fails with reason error after a not-byok warning, never retried', async () => {
  const config: Record<string, Untyped> = baseConfig();
  config.llm.providerByModel = { 'openai/': { only: ['openai'], byok: true } };
  const { gen, fetchImpl } = makeGen({ config, fetchImpl: fakeFetch(byokResponse(false), okResponse()) });
  const { logs } = await withCapturedLogs(() =>
    assert.rejects(
      gen.generate({ prompt: 'the prompt itself' }),
      (err) =>
        err instanceof ImageGenError &&
        err.reason === 'error' &&
        err.cause instanceof NotByokError &&
        err.message === 'not byok: openai/test-image via OpenAI'
    )
  );
  assert.equal(fetchImpl.calls.length, 1, 'billed already: nothing is retried');
  const warn = logs.filter((l) => l.msg === 'llm: not byok');
  assert.equal(warn.length, 1);
  assert.equal(warn[0].role, 'drawing');
  assert.equal(warn[0].provider, 'OpenAI');
  assert.equal(logs.filter((l) => l.msg === 'images: failed').length, 1, 'the ordinary error path');
  assert.ok(!JSON.stringify(logs).includes('the prompt itself'), 'no prompt text in any log line');
});

test('images: without a route marked byok exactly true, or without is_byok false, the picture passes silently', async () => {
  const cases = [
    [undefined, false],
    [{ only: ['openai'] }, false],
    [{ only: ['openai'], byok: 'true' }, false],
    [{ only: ['openai'], byok: true }, undefined],
    [{ only: ['openai'], byok: true }, true],
  ];
  for (const [route, isByok] of cases) {
    const config: Record<string, Untyped> = baseConfig();
    if (route) config.llm.providerByModel = { 'openai/': route };
    const { gen } = makeGen({ config, fetchImpl: fakeFetch(byokResponse(isByok)) });
    const { result, logs } = await withCapturedLogs(() => gen.generate({ prompt: 'a small boat' }));
    assert.ok(Buffer.isBuffer(result.buffer), JSON.stringify([route, isByok]));
    assert.equal(logs.filter((l) => l.msg === 'llm: not byok').length, 0, JSON.stringify([route, isByok]));
  }
});

// PR 7d: the daily caps of plan section 4.5 are gone. A local layer not yet cut may still set them; nothing reads them.
test('images: a hundred drawings in one day, by one member, are all made, a stale daily cap in the config included', async () => {
  const { gen, fetchImpl } = makeGen({ config: baseConfig(wrongly({ maxPerDay: 2, maxPerUserPerDay: 1 })) });
  for (let n = 0; n < 100; n += 1) await gen.generate(wrongly({ prompt: `picture ${n}`, accountId: 'u1' }));
  assert.equal(fetchImpl.calls.length, 100);
});
