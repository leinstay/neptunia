// Tests for src/llm/openrouter.js: the two hard safety rails (token cap,
// daily request cap), retry behaviour, calibration feedback and the usage log
// line. No network: fetchImpl is always a fake. Only the few retry tests marked
// below exercise a real retry sleep (~1.5s) -- the backoff sleep in src is not touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createLlm,
  TokenLimitError,
  DailyCapError,
  LLM_DAILY,
  llmCountToday,
  railReason,
  helperRequestOptions,
  hedgeSettings,
  resolveProvider,
  matchRoute,
  openRouterHeaders,
  VIDEO_TOKENS_PER_SECOND_FALLBACK,
  providerLimitOf,
  cacheTtlFor,
  withCacheMarker,
  profilesTtlFor,
  fullPromptTokens,
  currentRoleName,
  REPLY_REQUEST,
  MEMORY_VOICE_REQUEST,
} from '../src/llm/openrouter.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { createLimits } from '../src/llm/limits.js';

function baseConfig(overrides = {}) {
  return {
    llm: {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'test-model',
      temperature: 1,
      maxOutputTokens: 100,
      maxRequestTokens: 1000,
      maxRequestsPerDay: 300,
      timeoutMs: 5000,
      retries: 2,
      ...overrides,
    },
    context: { vision: { tokensPerImage: 1600 } },
  };
}

function fakeState() {
  return { data: {}, markDirty() { this.dirty = (this.dirty ?? 0) + 1; } };
}

function fakeCalibrator() {
  const observed = [];
  return {
    ratio: 1,
    apply: (n) => n,
    observe: (raw, actual) => observed.push([raw, actual]),
    observed,
  };
}

function okResponse(text, usage = { prompt_tokens: 42 }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: text } }], usage }),
  };
}

function errorResponse(status, body = 'error') {
  return { ok: false, status, text: async () => body };
}

test('complete: refuses with TokenLimitError above the cap without calling fetch', async () => {
  let called = false;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestTokens: 50 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => { called = true; return okResponse('x'); },
  });
  await assert.rejects(
    llm.complete([{ role: 'user', content: 'a'.repeat(2000) }]),
    (err) => err instanceof TokenLimitError,
  );
  assert.equal(called, false);
});

test('complete: a rejected-for-size request does not count against the daily cap', async () => {
  const state = fakeState();
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestTokens: 50 }),
    calibrator: fakeCalibrator(),
    state,
    fetchImpl: async () => okResponse('x'),
  });
  await assert.rejects(llm.complete([{ role: 'user', content: 'a'.repeat(2000) }]));
  assert.equal(state.data.llmCount ?? 0, 0);
});

test('complete: DailyCapError once the daily cap is reached, without calling fetch', async () => {
  let calls = 0;
  const state = fakeState();
  const today = new Date().toISOString().slice(0, 10);
  state.data.llmDay = today;
  state.data.llmCount = 1;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestsPerDay: 1 }),
    calibrator: fakeCalibrator(),
    state,
    fetchImpl: async () => { calls += 1; return okResponse('x'); },
  });
  await assert.rejects(
    llm.complete([{ role: 'user', content: 'hi' }]),
    (err) => err instanceof DailyCapError,
  );
  assert.equal(calls, 0);
});

test('complete: the daily counter follows the injected clock and starts again on a new UTC day', async () => {
  const state = fakeState();
  state.data.llmDay = '2026-09-20';
  state.data.llmCount = 1;
  let nowMs = Date.UTC(2026, 8, 20, 23, 59, 0);
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestsPerDay: 1 }),
    calibrator: fakeCalibrator(),
    state,
    fetchImpl: async () => okResponse('x'),
    now: () => nowMs,
  });
  await assert.rejects(llm.complete([{ role: 'user', content: 'hi' }]), (err) => err instanceof DailyCapError);
  nowMs = Date.UTC(2026, 8, 21, 0, 1, 0);
  await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(state.data.llmDay, '2026-09-21');
  assert.equal(state.data.llmCount, 1);
});

test('complete: DailyCapError carries the limit key, the used count and the cap', async () => {
  const state = fakeState();
  state.data.llmDay = new Date().toISOString().slice(0, 10);
  state.data.llmCount = 3;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestsPerDay: 3 }),
    calibrator: fakeCalibrator(),
    state,
    fetchImpl: async () => okResponse('x'),
  });
  await assert.rejects(llm.complete([{ role: 'user', content: 'hi' }]), (err) => {
    assert.ok(err instanceof DailyCapError);
    assert.equal(err.message, 'daily LLM request cap reached (3)');
    assert.equal(err.key, 'llm.maxRequestsPerDay');
    assert.equal(err.used, 3);
    assert.equal(err.cap, 3);
    return true;
  });
});

test('complete: TokenLimitError carries the limit key, the estimate as used and the cap', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestTokens: 50 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => okResponse('x'),
  });
  await assert.rejects(llm.complete([{ role: 'user', content: 'a'.repeat(2000) }]), (err) => {
    assert.ok(err instanceof TokenLimitError);
    assert.equal(err.key, 'llm.maxRequestTokens');
    assert.equal(err.cap, 50);
    assert.ok(Number.isFinite(err.used) && err.used > 50);
    assert.equal(err.message, `request estimated at ${err.used} tokens, cap is 50`);
    return true;
  });
});

test('complete: a cap that is not a finite number counts as 0 -- every request refused, logged once per process', async () => {
  const { logs } = await withCapturedLogs(async () => {
    for (const cap of [undefined, null, Number.NaN, '300', Infinity]) {
      let calls = 0;
      const state = fakeState();
      const llm = createLlm({
        apiKey: 'k',
        getConfig: () => baseConfig({ maxRequestsPerDay: cap }),
        calibrator: fakeCalibrator(),
        state,
        fetchImpl: async () => { calls += 1; return okResponse('x'); },
      });
      await assert.rejects(llm.complete([{ role: 'user', content: 'hi' }]), (err) => {
        assert.ok(err instanceof DailyCapError, String(cap));
        assert.equal(err.cap, 0);
        assert.equal(err.key, 'llm.maxRequestsPerDay');
        return true;
      });
      assert.equal(calls, 0, String(cap));
      assert.equal(state.data.llmCount ?? 0, 0, String(cap));
    }
  });
  const lines = logs.filter((l) => l.msg === 'llm: daily cap is not a number, refusing');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].key, 'llm.maxRequestsPerDay');
});

// --- the read-only side of the daily request rail: capLeft, llmCountToday ---

test('capLeft: the slots left under llm.maxRequestsPerDay today, rolling over at 00:00 UTC, with state.data unchanged', async () => {
  const state = fakeState();
  state.data = { llmDay: '2026-09-20', llmCount: 3, other: { kept: true } };
  const before = structuredClone(state.data);
  let nowMs = Date.UTC(2026, 8, 20, 23, 59, 59);
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestsPerDay: 5 }),
    calibrator: fakeCalibrator(),
    state,
    fetchImpl: async () => okResponse('x'),
    now: () => nowMs,
  });

  assert.equal(llm.capLeft(), 2, 'the injected clock when no time is passed');
  assert.equal(llm.capLeft(Date.UTC(2026, 8, 20, 12, 0, 0)), 2);
  assert.equal(llm.capLeft(Date.UTC(2026, 8, 21, 0, 0, 0)), 5, 'a new UTC day starts from the whole cap');
  nowMs = Date.UTC(2026, 8, 21, 0, 0, 0);
  assert.equal(llm.capLeft(), 5);
  assert.deepEqual(state.data, before, 'reading never rolls the stored day over');
  assert.equal(state.dirty, undefined, 'and never marks the state dirty');

  // The first counted request of the new day is what rolls the pair over.
  await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.deepEqual([state.data.llmDay, state.data.llmCount], ['2026-09-21', 1]);
  assert.equal(llm.capLeft(), 4);
});

test('capLeft: 0 at or past the cap, the cap read live; Infinity while the cap is not a number', async () => {
  const state = fakeState();
  state.data = { llmDay: '2026-09-21', llmCount: 4 };
  const config = baseConfig({ maxRequestsPerDay: 4 });
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => config,
    calibrator: fakeCalibrator(),
    state,
    fetchImpl: async () => okResponse('x'),
    now: () => Date.UTC(2026, 8, 21, 12, 0, 0),
  });
  assert.equal(llm.capLeft(), 0);
  config.llm.maxRequestsPerDay = 3; // lowered live under today's count
  assert.equal(llm.capLeft(), 0, 'never negative');
  config.llm.maxRequestsPerDay = 10; // raised live
  assert.equal(llm.capLeft(), 6);
  config.llm.maxRequestsPerDay = 0;
  assert.equal(llm.capLeft(), 0, 'a cap of 0 leaves nothing');

  // A cap that is not a number is the client's own refusal to make (and to log, once): a
  // read reports no limit instead of answering for it.
  const { logs } = await withCapturedLogs(async () => {
    for (const cap of [undefined, null, Number.NaN, '300', Infinity]) {
      config.llm.maxRequestsPerDay = cap;
      assert.equal(llm.capLeft(), Infinity, String(cap));
    }
  });
  assert.deepEqual(logs, [], 'a read logs nothing');
  assert.deepEqual(state.data, { llmDay: '2026-09-21', llmCount: 4 });

  // A stored count that is not a number reads as no use.
  config.llm.maxRequestsPerDay = 10;
  state.data.llmCount = 'many';
  assert.equal(llm.capLeft(), 10);
});

test('llmCountToday: today\'s counted requests, 0 for a stamp of another day, read only', () => {
  assert.deepEqual(LLM_DAILY, { dayKey: 'llmDay', countKey: 'llmCount' }, 'the state.json fields of the request counter');
  const noon = Date.UTC(2026, 8, 21, 12, 0, 0);
  const data = { llmDay: '2026-09-21', llmCount: 17 };
  assert.equal(llmCountToday(data, noon), 17);
  assert.equal(llmCountToday(data, Date.UTC(2026, 8, 22, 0, 0, 0)), 0, 'yesterday\'s count after 00:00 UTC');
  assert.deepEqual(data, { llmDay: '2026-09-21', llmCount: 17 });
  for (const empty of [undefined, null, {}]) assert.equal(llmCountToday(empty, noon), 0, String(empty));
});

test('llmCountToday: reads what complete counted', async () => {
  const state = fakeState();
  const noon = Date.UTC(2026, 8, 21, 12, 0, 0);
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator: fakeCalibrator(),
    state,
    fetchImpl: async () => okResponse('x'),
    now: () => noon,
  });
  await llm.complete([{ role: 'user', content: 'hi' }]);
  await llm.complete([{ role: 'user', content: 'hi' }]);
  await llm.complete([{ role: 'user', content: 'hi' }], { countAgainstDailyCap: false });
  assert.equal(llmCountToday(state.data, noon), 2);
  assert.equal(llm.capLeft(), 298);
});

// --- railReason: the reason code of a refused or failed request ---

test('railReason: daily-cap for a DailyCapError, token-limit for a TokenLimitError, the fallback for anything else', () => {
  const http = Object.assign(new Error('OpenRouter HTTP 500: x'), { statusCode: 500 });
  const rows = [
    [new DailyCapError('daily LLM request cap reached (3)'), undefined, 'daily-cap'],
    [new TokenLimitError('request estimated at 9 tokens, cap is 5'), undefined, 'token-limit'],
    [http, undefined, 'llm-error'],
    [new TypeError('fetch failed'), undefined, 'llm-error'],
    [Object.assign(new Error('timeout'), { name: 'TimeoutError' }), undefined, 'llm-error'],
    [undefined, undefined, 'llm-error'],
    [null, undefined, 'llm-error'],
    ['daily-cap', undefined, 'llm-error'],
    [{ name: 'DailyCapError' }, undefined, 'llm-error'],
    // A caller with its own code for "anything else" keeps it; the two rails never take it.
    [http, 'llm', 'llm'],
    [new DailyCapError('x'), 'llm', 'daily-cap'],
    [new TokenLimitError('x'), 'llm', 'token-limit'],
  ];
  for (const [err, fallback, expected] of rows) {
    const got = fallback === undefined ? railReason(err) : railReason(err, fallback);
    assert.equal(got, expected, `${err?.constructor?.name ?? String(err)} / ${String(fallback)}`);
  }
});

// --- helperRequestOptions: the one spelling of an in-turn helper request ---

test('helperRequestOptions: counted, never calibrated, on llm.helperTimeoutMs unless the caller says otherwise', () => {
  const config = { llm: { timeoutMs: 300000, helperTimeoutMs: 12000 } };
  assert.deepEqual(helperRequestOptions(config, { role: 'classifier.text', maxOutputTokens: 60, purpose: 'lookup' }), {
    role: 'classifier.text',
    maxOutputTokens: 60,
    countAgainstDailyCap: true,
    skipCalibration: true,
    timeoutMs: 12000, // never the turn-length llm.timeoutMs
    purpose: 'lookup',
    signal: undefined,
    helper: true, // the mark a hedge looks for; never sent
  });

  config.llm.helperTimeoutMs = 7000; // a hot edit between two calls: nothing is remembered
  assert.equal(helperRequestOptions(config, { role: 'classifier.media' }).timeoutMs, 7000);

  // A helper with its own clock passes it, with its abort signal.
  const controller = new AbortController();
  const own = helperRequestOptions(config, { role: 'classifier.text', maxOutputTokens: 500, purpose: 'lookup', signal: controller.signal, timeoutMs: 8000 });
  assert.equal(own.timeoutMs, 8000);
  assert.equal(own.signal, controller.signal);

  // The two rails a helper must never opt out of are not the caller's to set.
  const forced = helperRequestOptions(config, { role: 'classifier.text', countAgainstDailyCap: false, skipCalibration: false, model: 'x/y' });
  assert.deepEqual([forced.countAgainstDailyCap, forced.skipCalibration], [true, true]);
  assert.equal('model' in forced, false, 'the model stays the caller\'s own option');
});

test('code fallbacks: the defaults the code applies when a setting is missing equal config.json', () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  for (const bare of [undefined, null, {}, { llm: null }, { llm: {} }, { llm: { helperTimeoutMs: null } }]) {
    assert.equal(helperRequestOptions(bare, { role: 'classifier.text' }).timeoutMs, shipped.llm.helperTimeoutMs, JSON.stringify(bare));
  }
  assert.equal(VIDEO_TOKENS_PER_SECOND_FALLBACK, shipped.media.video.tokensPerSecond);
  const noCacheBlock = { ...baseConfig(), features: { promptCache: true } };
  assert.equal(cacheTtlFor(noCacheBlock, shipped.llm.cache.roles[0], shipped.llm.cache.models[0] + 'x'), shipped.llm.cache.ttl, 'a missing llm.cache reads as config.json');
});

test('helperRequestOptions: complete takes the set as it is -- counted, uncalibrated, on the helper timeout, purpose logged and never sent', async () => {
  const state = fakeState();
  const calibrator = fakeCalibrator();
  const sent = [];
  const config = baseConfig({ timeoutMs: 100000, helperTimeoutMs: 5 });
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => config,
    calibrator,
    state,
    fetchImpl: async (url, init) => {
      sent.push({ body: JSON.parse(init.body), signal: init.signal });
      return okResponse('yes', { prompt_tokens: 777 });
    },
  });
  const { result, logs } = await withCapturedLogs(() =>
    llm.complete([{ role: 'user', content: 'hi' }], { model: 'small/model', ...helperRequestOptions(config, { role: 'classifier.text', maxOutputTokens: 60, purpose: 'address' }) }),
  );
  assert.equal(result.text, 'yes');
  assert.equal(state.data.llmCount, 1, 'a helper counts against the daily cap');
  assert.deepEqual(calibrator.observed, [], 'and never feeds the calibration');
  assert.deepEqual(Object.keys(sent[0].body).sort(), ['max_tokens', 'messages', 'model', 'temperature']);
  assert.deepEqual([sent[0].body.model, sent[0].body.max_tokens], ['small/model', 60]);
  const [line] = logs.filter((l) => l.msg === 'llm: usage');
  assert.deepEqual([line.role, line.purpose, line.model], ['classifier.text', 'address', 'small/model']);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent[0].signal.aborted, true, 'the request signal is cut at llm.helperTimeoutMs, not at llm.timeoutMs');
});

test('complete: a json.error body after a 200 is thrown and never retried', async () => {
  let calls = 0;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ retries: 2 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ error: { message: 'upstream refused' } }) };
    },
  });
  await assert.rejects(llm.complete([{ role: 'user', content: 'hi' }]), /OpenRouter error/);
  assert.equal(calls, 1);
});

test('complete: an unparsable 200 body is thrown and never retried', async () => {
  let calls = 0;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ retries: 2 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } };
    },
  });
  await assert.rejects(llm.complete([{ role: 'user', content: 'hi' }]), (err) => err instanceof SyntaxError);
  assert.equal(calls, 1);
});

test('complete: a non-retryable 4xx throws immediately with statusCode, fetch called once', async () => {
  let calls = 0;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => { calls += 1; return errorResponse(400, 'bad request'); },
  });
  await assert.rejects(
    llm.complete([{ role: 'user', content: 'hi' }]),
    (err) => err.statusCode === 400,
  );
  assert.equal(calls, 1);
});

test('complete: feeds the calibrator from usage.prompt_tokens on success', async () => {
  const calibrator = fakeCalibrator();
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator,
    state: fakeState(),
    fetchImpl: async () => okResponse('hi', { prompt_tokens: 777 }),
  });
  await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(calibrator.observed.length, 1);
  assert.equal(calibrator.observed[0][1], 777);
});

test('complete: options.skipCalibration true never feeds the calibrator, even with usage.prompt_tokens present', async () => {
  const calibrator = fakeCalibrator();
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator,
    state: fakeState(),
    fetchImpl: async () => okResponse('pong', { prompt_tokens: 777 }),
  });
  await llm.complete([{ role: 'user', content: 'hi' }], { skipCalibration: true });
  assert.equal(calibrator.observed.length, 0);
});

test('complete: a non-retryable HTTP error carries the untrimmed body as .body, for a caller that needs more than the trimmed message', async () => {
  const longBody = JSON.stringify({ error: { message: 'No endpoints found' }, routing_funnel: [{ step: 'BYOK endpoints', endpoints: 0 }] });
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => errorResponse(404, longBody),
  });
  await assert.rejects(
    llm.complete([{ role: 'user', content: 'hi' }]),
    (err) => err.statusCode === 404 && err.body === longBody,
  );
});

test('complete: does not call calibrator.observe when usage.prompt_tokens is absent', async () => {
  const calibrator = fakeCalibrator();
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator,
    state: fakeState(),
    fetchImpl: async () => okResponse('hi', {}),
  });
  await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(calibrator.observed.length, 0);
});

test('complete: an empty/non-string model content falls back to an empty string', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => okResponse(null),
  });
  const result = await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(result.text, '');
});

test('complete: a trailing slash on baseUrl is tolerated, no double slash in the URL', async () => {
  let seenUrl = null;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ baseUrl: 'https://example.com/v1/' }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url) => {
      seenUrl = url;
      return okResponse('hi');
    },
  });
  await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(seenUrl, 'https://example.com/v1/chat/completions');
});

test('complete: countAgainstDailyCap: false neither counts against nor is refused by the daily cap', async () => {
  const state = fakeState();
  const today = new Date().toISOString().slice(0, 10);
  state.data.llmDay = today;
  state.data.llmCount = 1;
  let calls = 0;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestsPerDay: 1 }), // already at/over cap
    calibrator: fakeCalibrator(),
    state,
    fetchImpl: async () => { calls += 1; return okResponse('hi'); },
  });

  const result = await llm.complete([{ role: 'user', content: 'hi' }], { countAgainstDailyCap: false });

  assert.equal(result.text, 'hi');
  assert.equal(calls, 1);
  assert.equal(state.data.llmCount, 1, 'the counter is untouched by a call that opts out of the daily cap');
});

test('complete: countAgainstDailyCap: false still enforces the per-request token cap', async () => {
  let called = false;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestTokens: 50 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => { called = true; return okResponse('x'); },
  });
  await assert.rejects(
    llm.complete([{ role: 'user', content: 'a'.repeat(2000) }], { countAgainstDailyCap: false }),
    (err) => err instanceof TokenLimitError,
  );
  assert.equal(called, false);
});

test('complete: options.maxRequestTokens overrides the global cap for one call only', async () => {
  let called = false;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestTokens: 50 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => { called = true; return okResponse('x'); },
  });
  const result = await llm.complete([{ role: 'user', content: 'a'.repeat(200) }], { maxRequestTokens: 1000 });
  assert.equal(called, true);
  assert.equal(result.text, 'x');
});

test('complete: options.maxRequestTokens can also tighten the cap for one call', async () => {
  let called = false;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestTokens: 1000 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => { called = true; return okResponse('x'); },
  });
  await assert.rejects(
    llm.complete([{ role: 'user', content: 'a'.repeat(2000) }], { maxRequestTokens: 50 }),
    (err) => err instanceof TokenLimitError,
  );
  assert.equal(called, false);
});

test('complete: defaults to llm.timeoutMs for the request signal when options.timeoutMs is absent', async () => {
  let seenSignal;
  let abortedAtSend;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ timeoutMs: 5 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url, init) => {
      seenSignal = init.signal;
      // Recorded at send time, so the check does not depend on how the success path awaits afterwards.
      abortedAtSend = init.signal.aborted;
      return okResponse('hi');
    },
  });
  const result = await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(result.text, 'hi');
  assert.equal(abortedAtSend, false, 'the request must not go out on an already aborted signal');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seenSignal.aborted, true, 'without options.timeoutMs, the short llm.timeoutMs must abort the request signal');

  // Second phase: with a long llm.timeoutMs and no options.signal, a successful call must leave the request
  // signal live (the body is read after fetch resolves, so an early abort would break every real response).
  let liveSignal;
  const longLlm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ timeoutMs: 100000 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url, init) => {
      liveSignal = init.signal;
      return okResponse('hi');
    },
  });
  const longResult = await longLlm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(longResult.text, 'hi');
  assert.equal(liveSignal.aborted, false, 'a successful call leaves the request signal live; only the timeout aborts it');
});

test('complete: omits the provider field when llm.provider is a non-object (e.g. a stray string)', async () => {
  let seenBody = null;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ provider: 'anthropic' }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url, init) => {
      seenBody = JSON.parse(init.body);
      return okResponse('hi');
    },
  });
  await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal('provider' in seenBody, false);
});

test('complete: options.provider is sent even when llm.provider is null', async () => {
  let seenBody = null;
  const pinned = { order: ['google-ai-studio'], allow_fallbacks: false };
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ provider: null }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url, init) => {
      seenBody = JSON.parse(init.body);
      return okResponse('hi');
    },
  });
  await llm.complete([{ role: 'user', content: 'hi' }], { provider: pinned });
  assert.deepEqual(seenBody.provider, pinned);
});

test('complete: a non-object options.provider (array, null, string) falls back to llm.provider', async () => {
  const bodies = [];
  const configured = { ignore: ['amazon-bedrock'] };
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ provider: configured }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return okResponse('hi');
    },
  });
  await llm.complete([{ role: 'user', content: 'hi' }], { provider: ['google-ai-studio'] });
  await llm.complete([{ role: 'user', content: 'hi' }], { provider: null });
  await llm.complete([{ role: 'user', content: 'hi' }], { provider: 'google-ai-studio' });
  await llm.complete([{ role: 'user', content: 'hi' }]);
  for (const body of bodies) assert.deepEqual(body.provider, configured);
});

test('complete: options.videoSeconds raises the estimate by videoSeconds * media.video.tokensPerSecond', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => ({ ...baseConfig({ maxRequestTokens: 50000 }), media: { video: { tokensPerSecond: 300 } } }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => okResponse('hi'),
  });
  const messages = [{ role: 'user', content: 'hi' }];
  const plain = await llm.complete(messages);
  const withVideo = await llm.complete(messages, { videoSeconds: 60 });
  assert.equal(withVideo.estimated - plain.estimated, 18000);
});

test('complete: options.videoSeconds falls back to the built-in rate when media.video is absent', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestTokens: 50000 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => okResponse('hi'),
  });
  const messages = [{ role: 'user', content: 'hi' }];
  const plain = await llm.complete(messages);
  const withVideo = await llm.complete(messages, { videoSeconds: 10 });
  assert.equal(withVideo.estimated - plain.estimated, 10 * VIDEO_TOKENS_PER_SECOND_FALLBACK);
});

test('complete: options.videoSeconds counts against the token cap (just below passes, just above refuses)', async () => {
  const messages = [{ role: 'user', content: 'hi' }];
  // raw text estimate: overhead 6 + ceil(2/3.5)=1 -> 7; plus 60 s * 300 = 18000 -> 18007
  const make = (cap) => createLlm({
    apiKey: 'k',
    getConfig: () => ({ ...baseConfig({ maxRequestTokens: cap }), media: { video: { tokensPerSecond: 300 } } }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => okResponse('hi'),
  });
  const ok = await make(18007).complete(messages, { videoSeconds: 60 });
  assert.equal(ok.estimated, 18007);
  await assert.rejects(
    make(18006).complete(messages, { videoSeconds: 60 }),
    (err) => err instanceof TokenLimitError,
  );
});

test('complete: the calibrator is applied to the text estimate plus the video estimate', async () => {
  const calibrator = { ...fakeCalibrator(), apply: (n) => n * 2 };
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => ({ ...baseConfig({ maxRequestTokens: 100000 }), media: { video: { tokensPerSecond: 300 } } }),
    calibrator,
    state: fakeState(),
    fetchImpl: async () => okResponse('hi'),
  });
  const result = await llm.complete([{ role: 'user', content: 'hi' }], { videoSeconds: 60 });
  assert.equal(result.estimated, (7 + 18000) * 2);
});

test('complete: a non-finite or negative options.videoSeconds leaves the estimate unchanged', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => ({ ...baseConfig({ maxRequestTokens: 50000 }), media: { video: { tokensPerSecond: 300 } } }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => okResponse('hi'),
  });
  const messages = [{ role: 'user', content: 'hi' }];
  const plain = await llm.complete(messages);
  for (const videoSeconds of [NaN, Infinity, -5, '60', undefined]) {
    const result = await llm.complete(messages, { videoSeconds });
    assert.equal(result.estimated, plain.estimated, `videoSeconds=${String(videoSeconds)}`);
  }
});

test('complete: options.videoTokensPerSecond replaces media.video.tokensPerSecond for this one call', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => ({ ...baseConfig({ maxRequestTokens: 50000 }), media: { video: { tokensPerSecond: 300 } } }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => okResponse('hi'),
  });
  const messages = [{ role: 'user', content: 'hi' }];
  const plain = await llm.complete(messages);
  const agentic = await llm.complete(messages, { videoSeconds: 3289, videoTokensPerSecond: 10 });
  assert.equal(agentic.estimated - plain.estimated, 32890);
  const fractional = await llm.complete(messages, { videoSeconds: 3, videoTokensPerSecond: 0.5 });
  assert.equal(fractional.estimated - plain.estimated, 2);
  const next = await llm.complete(messages, { videoSeconds: 60 });
  assert.equal(next.estimated - plain.estimated, 18000, 'the override never sticks to later calls');
});

test('complete: a non-finite or non-positive options.videoTokensPerSecond falls back to media.video.tokensPerSecond', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => ({ ...baseConfig({ maxRequestTokens: 50000 }), media: { video: { tokensPerSecond: 300 } } }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => okResponse('hi'),
  });
  const messages = [{ role: 'user', content: 'hi' }];
  const plain = await llm.complete(messages);
  for (const videoTokensPerSecond of [NaN, Infinity, -Infinity, 0, -10, '10', null, undefined, {}]) {
    const result = await llm.complete(messages, { videoSeconds: 60, videoTokensPerSecond });
    assert.equal(result.estimated - plain.estimated, 18000, `videoTokensPerSecond=${String(videoTokensPerSecond)}`);
  }
});

// options.signal -- an external AbortController cancels the in-flight
// request (for /nep warmup stop), and is never retried afterwards.
test('complete: options.signal aborts the in-flight fetch and rejects without retrying', async () => {
  let calls = 0;
  let seenSignal;
  const controller = new AbortController();
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ retries: 2 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: (url, init) => {
      calls += 1;
      seenSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });
    },
  });

  const promise = llm.complete([{ role: 'user', content: 'hi' }], { signal: controller.signal });
  controller.abort();

  await assert.rejects(promise, (err) => err.name === 'AbortError');
  assert.equal(seenSignal.aborted, true, 'the signal handed to fetch must reflect the external abort');
  assert.equal(calls, 1, 'a deliberate external abort must never be retried');
});

test('complete: options.signal already aborted before the call is never sent to fetch', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ retries: 2 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => { calls += 1; return okResponse('x'); },
  });

  await assert.rejects(llm.complete([{ role: 'user', content: 'hi' }], { signal: controller.signal }));
  assert.equal(calls, 0);
});

// Only FOUR tests exercise the real retry backoff sleep (~1.5s at attempt 1): a gateway error, a
// timeout, the retried 429 kinds side by side and a rate limit followed by a daily quota (below).
test('complete: retries once on a 503 then succeeds, logging the retried attempt', async () => {
  let calls = 0;
  let clock = Date.UTC(2026, 8, 21, 12, 0, 0);
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ retries: 1 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => {
      calls += 1;
      clock += 400; // each attempt takes this long on the injected clock
      if (calls === 1) return errorResponse(503, 'temporarily unavailable');
      return okResponse('recovered');
    },
    now: () => clock,
  });
  const { result, logs } = await withCapturedLogs(() => llm.complete([{ role: 'user', content: 'hi' }]));
  assert.equal(result.text, 'recovered');
  assert.equal(calls, 2);
  assert.deepEqual(usageLines(logs).map((l) => l.ms), [800], 'one usage line, timed from the first attempt: the failed one is inside it');
  const retries = logs.filter((l) => l.msg === 'llm: retry');
  assert.equal(retries.length, 1);
  assert.equal(retries[0].attempt, 1);
  assert.equal(retries[0].status, 503);
  assert.equal(retries[0].name, 'Error');
  assert.ok(!JSON.stringify(logs).includes('temporarily unavailable'), 'the provider body is never logged');
  assert.equal('limitSource' in retries[0], false, 'a plain-text body adds no limit source');
  assert.equal('provider' in retries[0], false, 'a plain-text body adds no provider');
});

test('complete: a timed-out attempt is retried and logged with its error name', async () => {
  let calls = 0;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ retries: 1 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      return okResponse('recovered');
    },
  });
  const { result, logs } = await withCapturedLogs(() => llm.complete([{ role: 'user', content: 'hi' }]));
  assert.equal(result.text, 'recovered');
  assert.equal(calls, 2);
  const retries = logs.filter((l) => l.msg === 'llm: retry');
  assert.deepEqual(retries.map((l) => [l.attempt, l.status, l.name]), [[1, null, 'TimeoutError']]);
  assert.equal('limitSource' in retries[0] || 'provider' in retries[0], false, 'no body, no limit fields');
});

test('complete: the last failed attempt is thrown, not logged as a retry', async () => {
  let calls = 0;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ retries: 0 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => { calls += 1; return errorResponse(503, 'temporarily unavailable'); },
  });
  const { logs } = await withCapturedLogs(() => assert.rejects(llm.complete([{ role: 'user', content: 'hi' }]), (err) => err.statusCode === 503));
  assert.equal(calls, 1);
  assert.equal(logs.filter((l) => l.msg === 'llm: retry').length, 0);
});

// --- a provider's 429: which limit it names, and no retry on a daily quota ---

/** The provider's own text when its account ran out of the day's token quota. */
const DAILY_RAW = 'Too many tokens per day, please wait before trying again.';

/** A 429 body in OpenRouter's provider-error shape, the limit on the provider account (`raw` omitted when undefined). */
function upstreamLimitBody(raw, provider = 'Amazon Bedrock') {
  const metadata = { provider_name: provider, limit_source: 'upstream_provider_account', is_byok: true };
  if (raw !== undefined) metadata.raw = raw;
  return JSON.stringify({ error: { message: 'Provider returned error', code: 429, metadata } });
}

/** OpenRouter's own 429: no provider metadata, even when its text names a day. */
const OPENROUTER_429 = JSON.stringify({ error: { message: 'Rate limit exceeded: too many requests per day', code: 429 } });

/** An error shaped as `complete()` throws it for a non-ok answer. */
function httpError(status, body) {
  return Object.assign(new Error(`OpenRouter HTTP ${status}`), { statusCode: status, body });
}

const NO_LIMIT = { limitSource: null, provider: null, kind: null };

test('providerLimitOf: a 429 naming upstream_provider_account and a per-day limit is kind daily', () => {
  assert.deepEqual(providerLimitOf(httpError(429, upstreamLimitBody(DAILY_RAW))), {
    status: 429,
    limitSource: 'upstream_provider_account',
    provider: 'Amazon Bedrock',
    kind: 'daily',
  });
  for (const raw of ['Daily token quota exceeded for this account.', JSON.stringify({ message: DAILY_RAW })]) {
    assert.equal(providerLimitOf(httpError(429, upstreamLimitBody(raw))).kind, 'daily', raw);
  }
});

test('providerLimitOf: a text naming both a day and a throttle is kind daily', () => {
  // Each also reads as a short-window throttle ("too many requests", "too many tokens"):
  // the quota of the day wins, so the order of the two checks is pinned here.
  for (const raw of [
    'Too many requests per day, please wait before trying again.',
    'Rate exceeded: daily token quota, too many tokens.',
    DAILY_RAW,
  ]) {
    assert.equal(providerLimitOf(httpError(429, upstreamLimitBody(raw))).kind, 'daily', raw);
  }
});

test('providerLimitOf: a 429 saying too many requests is kind rate', () => {
  for (const raw of [
    'Too many requests, please wait before trying again.',
    'Too many tokens, please wait before trying again.',
    'Rate exceeded: 5 requests per minute.',
  ]) {
    assert.deepEqual(
      providerLimitOf(httpError(429, upstreamLimitBody(raw))),
      { status: 429, limitSource: 'upstream_provider_account', provider: 'Amazon Bedrock', kind: 'rate' },
      raw,
    );
  }
});

test('providerLimitOf: upstream_provider_account without a raw text is kind unknown', () => {
  assert.deepEqual(providerLimitOf(httpError(429, upstreamLimitBody(undefined, 'Fournisseur Éclair'))), {
    status: 429,
    limitSource: 'upstream_provider_account',
    provider: 'Fournisseur Éclair',
    kind: 'unknown',
  });
  for (const raw of ['', null, 42, 'Le fournisseur est momentanément indisponible.']) {
    assert.equal(providerLimitOf(httpError(429, upstreamLimitBody(raw))).kind, 'unknown', String(raw));
  }
});

test('providerLimitOf: another status, an OpenRouter 429, no body or a body that is not JSON give kind null', () => {
  // The same provider body on another status: its fields are read, no kind.
  assert.deepEqual(providerLimitOf(httpError(503, upstreamLimitBody(DAILY_RAW))), {
    status: 503,
    limitSource: 'upstream_provider_account',
    provider: 'Amazon Bedrock',
    kind: null,
  });
  // OpenRouter's own 429, and a 429 whose limit sits anywhere but the provider account.
  assert.deepEqual(providerLimitOf(httpError(429, OPENROUTER_429)), { status: 429, ...NO_LIMIT });
  const elsewhere = JSON.stringify({ error: { code: 429, metadata: { limit_source: 'upstream', raw: DAILY_RAW } } });
  assert.deepEqual(providerLimitOf(httpError(429, elsewhere)), { status: 429, ...NO_LIMIT, limitSource: 'upstream' });
  // No body, a body that is not JSON, JSON of another shape.
  for (const body of [undefined, '', DAILY_RAW, 'null', '[]', JSON.stringify({ error: { metadata: 'x' } })]) {
    assert.deepEqual(providerLimitOf(httpError(429, body)), { status: 429, ...NO_LIMIT }, String(body));
  }
  // Not an HTTP answer at all: no numeric statusCode.
  for (const err of [undefined, null, new Error('fetch failed'), new DailyCapError('cap'), httpError('429', upstreamLimitBody(DAILY_RAW)), httpError(Number.NaN, '')]) {
    assert.equal(providerLimitOf(err), null);
  }
});

test('complete: a daily provider quota 429 is thrown after one attempt and logs llm: provider limit', async () => {
  let calls = 0;
  const state = fakeState();
  const body = upstreamLimitBody(DAILY_RAW);
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ retries: 2 }),
    calibrator: fakeCalibrator(),
    state,
    fetchImpl: async () => { calls += 1; return errorResponse(429, body); },
  });
  const { logs } = await withCapturedLogs(() =>
    assert.rejects(llm.complete([{ role: 'user', content: 'hi' }], { role: 'voice' }), (err) => {
      assert.equal(err.statusCode, 429, 'the turn runner still sees a 429');
      assert.equal(err.body, body, 'the untrimmed body stays on the error');
      assert.ok(err.message.startsWith('OpenRouter HTTP 429: '));
      return true;
    }),
  );
  assert.equal(calls, 1, 'a daily quota is not retried');
  assert.equal(state.data.llmCount, 1, 'one request counted');
  assert.equal(logs.filter((l) => l.msg === 'llm: retry').length, 0);
  const limits = logs.filter((l) => l.msg === 'llm: provider limit');
  assert.equal(limits.length, 1);
  const { level, time, msg, ...fields } = limits[0];
  assert.equal(level, 'warn');
  assert.equal(typeof time, 'string');
  assert.equal(msg, 'llm: provider limit');
  assert.deepEqual(fields, {
    role: 'voice',
    model: 'test-model',
    status: 429,
    limitSource: 'upstream_provider_account',
    provider: 'Amazon Bedrock',
    kind: 'daily',
    retried: false,
  });
  assert.ok(!JSON.stringify(logs).includes('per day'), 'the provider raw text is never logged');
});

test('complete: a rate 429, an unknown upstream 429 and an OpenRouter 429 are still retried llm.retries times', async () => {
  // The three run side by side, so the one real backoff sleep is shared.
  const bodies = {
    rate: upstreamLimitBody('Too many requests, please wait before trying again.'),
    unknown: upstreamLimitBody(undefined, 'Fournisseur Éclair'),
    openrouter: OPENROUTER_429,
  };
  const calls = { rate: 0, unknown: 0, openrouter: 0 };
  const llmFor = (name) => createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ retries: 1 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => { calls[name] += 1; return errorResponse(429, bodies[name]); },
  });
  const { logs } = await withCapturedLogs(() =>
    Promise.all(
      Object.keys(bodies).map((name) =>
        assert.rejects(
          llmFor(name).complete([{ role: 'user', content: 'hi' }], { role: 'voice' }),
          (err) => err.statusCode === 429 && err.body === bodies[name],
        ),
      ),
    ),
  );
  assert.deepEqual(calls, { rate: 2, unknown: 2, openrouter: 2 }, 'one attempt plus llm.retries');
  assert.equal(logs.filter((l) => l.msg === 'llm: provider limit').length, 0);
  const retries = logs
    .filter((l) => l.msg === 'llm: retry')
    .map(({ level, time, msg, ...fields }) => fields)
    .sort((a, b) => (a.kind ?? '').localeCompare(b.kind ?? ''));
  assert.deepEqual(retries, [
    { attempt: 1, status: 429, name: 'Error' },
    { attempt: 1, status: 429, name: 'Error', limitSource: 'upstream_provider_account', provider: 'Amazon Bedrock', kind: 'rate' },
    { attempt: 1, status: 429, name: 'Error', limitSource: 'upstream_provider_account', provider: 'Fournisseur Éclair', kind: 'unknown' },
  ]);
});

test('complete: llm: retry carries kind when the body names one, never the raw text', async () => {
  const rateRaw = 'Too many tokens, please wait before trying again.';
  const bodies = [upstreamLimitBody(rateRaw), upstreamLimitBody(DAILY_RAW)];
  let calls = 0;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ retries: 2 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => { calls += 1; return errorResponse(429, bodies[calls - 1]); },
  });
  const { logs } = await withCapturedLogs(() =>
    assert.rejects(
      llm.complete([{ role: 'user', content: 'hi' }], { role: 'voice' }),
      (err) => err.statusCode === 429 && err.body === bodies[1],
    ),
  );
  assert.equal(calls, 2, 'the rate limit was retried, the daily quota after it was not');
  const retries = logs.filter((l) => l.msg === 'llm: retry').map(({ level, time, msg, ...fields }) => fields);
  assert.deepEqual(retries, [
    { attempt: 1, status: 429, name: 'Error', limitSource: 'upstream_provider_account', provider: 'Amazon Bedrock', kind: 'rate' },
  ]);
  assert.deepEqual(logs.filter((l) => l.msg === 'llm: provider limit').map((l) => l.kind), ['daily']);
  const text = JSON.stringify(logs);
  for (const raw of [rateRaw, DAILY_RAW, 'please wait']) assert.ok(!text.includes(raw), raw);
});

// --- one `llm: usage` line per answered request, whatever its role ---

/** The `llm: usage` lines of `logs`, each reduced to its own fields (level/time/msg checked and dropped), `ms` included. */
function usageLines(logs) {
  return logs
    .filter((l) => l.msg === 'llm: usage')
    .map(({ level, time, msg, ...fields }) => {
      assert.equal(level, 'info');
      assert.equal(typeof time, 'string');
      assert.equal(msg, 'llm: usage');
      return fields;
    });
}

/**
 * `usageLines` without `ms`: the duration is wall time on the real clock, so here it is only
 * checked to be a whole number of milliseconds >= 0 and dropped. The tests that inject a clock
 * pin its value through `usageLines`.
 */
function usageFields(logs) {
  return usageLines(logs).map(({ ms, ...fields }) => {
    assert.ok(Number.isInteger(ms) && ms >= 0, `ms is a whole count, got ${String(ms)}`);
    return fields;
  });
}

function jsonResponse(json) {
  return { ok: true, status: 200, json: async () => json };
}

const NO_USAGE = {
  purpose: null,
  origin: null,
  provider: null,
  promptTokens: null,
  completionTokens: null,
  reasoningTokens: null,
  cachedTokens: null,
  cacheWriteTokens: null,
  cache: 'off',
  cost: null,
  upstreamCost: null,
  byok: null,
  id: null,
};

test('complete: an answered request logs exactly one llm: usage line filled from the response', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => jsonResponse({
      id: 'gen-1700000000-abc',
      provider: 'Google AI Studio',
      choices: [{ message: { content: 'the answer itself' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 80,
        total_tokens: 1280,
        prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 150 },
        completion_tokens_details: { reasoning_tokens: 30 },
        cost: 0.0042,
        is_byok: true,
        cost_details: { upstream_inference_cost: 0.0038 },
      },
    }),
  });
  const { result, logs } = await withCapturedLogs(() =>
    llm.complete([{ role: 'user', content: 'the prompt itself' }], { role: 'analyzer', model: 'google/gemini-x' }),
  );
  assert.equal(result.text, 'the answer itself');
  assert.equal(result.provider, 'Google AI Studio');
  assert.deepEqual(usageFields(logs), [{
    role: 'analyzer',
    purpose: null, // none was named for this request
    origin: null,
    model: 'google/gemini-x',
    provider: 'Google AI Studio',
    promptTokens: 1200,
    completionTokens: 80,
    reasoningTokens: 30,
    cachedTokens: 1000,
    cacheWriteTokens: 150,
    cache: 'off', // no marker was sent: the counts stay, the code says the bot did not ask for caching
    cost: 0.0042,
    upstreamCost: 0.0038,
    byok: true,
    id: 'gen-1700000000-abc',
  }]);
  const text = JSON.stringify(logs);
  assert.ok(!text.includes('the prompt itself') && !text.includes('the answer itself'), 'no prompt or answer text');
});

test('complete: a response without usage logs the usage line with nulls and still answers', async () => {
  for (const extra of [{}, { usage: null }, { usage: { prompt_tokens_details: null, completion_tokens_details: null, cost_details: null } }]) {
    const llm = createLlm({
      apiKey: 'k',
      getConfig: () => baseConfig(),
      calibrator: fakeCalibrator(),
      state: fakeState(),
      fetchImpl: async () => jsonResponse({ choices: [{ message: { content: 'hi' } }], ...extra }),
    });
    const { result, logs } = await withCapturedLogs(() => llm.complete([{ role: 'user', content: 'hi' }]));
    assert.equal(result.text, 'hi', JSON.stringify(extra));
    assert.deepEqual(usageFields(logs), [{ role: null, model: 'test-model', ...NO_USAGE }], JSON.stringify(extra));
  }
});

test('complete: a refused, failed or json.error request logs no usage line', async () => {
  const make = (fetchImpl, cfg = {}) =>
    createLlm({ apiKey: 'k', getConfig: () => baseConfig(cfg), calibrator: fakeCalibrator(), state: fakeState(), fetchImpl });
  const { logs } = await withCapturedLogs(async () => {
    await assert.rejects(make(async () => okResponse('x'), { maxRequestTokens: 1 }).complete([{ role: 'user', content: 'hi' }]));
    await assert.rejects(make(async () => errorResponse(400, 'bad request')).complete([{ role: 'user', content: 'hi' }]));
    await assert.rejects(make(async () => jsonResponse({ error: { message: 'refused' } })).complete([{ role: 'user', content: 'hi' }]));
  });
  assert.deepEqual(usageFields(logs), []);
});

test('complete: llm: usage carries the request\'s duration, its purpose and its origin; neither option is sent', async () => {
  let clock = Date.UTC(2026, 8, 21, 12, 0, 0);
  let answerMs = 1000;
  const bodies = [];
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ provider: { only: ['some-provider'] } }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url, init) => {
      bodies.push(init.body);
      clock += answerMs; // the provider takes this long to answer ...
      return {
        ok: true,
        status: 200,
        json: async () => {
          clock += 234; // ... and the body this long to arrive
          return { choices: [{ message: { content: 'the answer itself' } }], usage: { prompt_tokens: 42 } };
        },
      };
    },
    now: () => clock,
  });
  const ask = (options) => llm.complete([{ role: 'user', content: 'the prompt itself' }], options);
  const { logs } = await withCapturedLogs(async () => {
    await ask({ role: 'classifier.text', purpose: 'rewatch' });
    await ask({ role: 'voice', origin: 'mentor', countAgainstDailyCap: false });
    await ask({ role: 'voice' });
    await ask({ purpose: 7, origin: { text: 'not a code' } });
    answerMs = -5000; // the clock is stepped back while the request is out: never a negative duration
    await ask({ role: 'voice', purpose: 'lookup' });
  });
  assert.deepEqual(
    usageLines(logs).map(({ role, purpose, origin, ms }) => ({ role, purpose, origin, ms })),
    [
      { role: 'classifier.text', purpose: 'rewatch', origin: null, ms: 1234 },
      { role: 'voice', purpose: null, origin: 'mentor', ms: 1234 },
      { role: 'voice', purpose: null, origin: null, ms: 1234 },
      { role: null, purpose: null, origin: null, ms: 1234 },
      { role: 'voice', purpose: 'lookup', origin: null, ms: 0 },
    ],
  );
  assert.equal(bodies.length, 5);
  for (const body of bodies) {
    assert.deepEqual(Object.keys(JSON.parse(body)).sort(), ['max_tokens', 'messages', 'model', 'provider', 'temperature'], 'no purpose, no origin, no role');
    for (const word of ['rewatch', 'lookup', 'mentor', 'purpose', 'origin']) assert.ok(!body.includes(word), `${word} is logged only`);
  }
  const text = JSON.stringify(logs);
  assert.ok(!text.includes('the prompt itself') && !text.includes('the answer itself'), 'counts and codes only');
});

test('complete: options.reasoning (a plain object) is sent verbatim as body.reasoning; anything else omits it', async () => {
  const bodies = [];
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return okResponse('hi');
    },
  });
  await llm.complete([{ role: 'user', content: 'hi' }], { reasoning: { enabled: false } });
  await llm.complete([{ role: 'user', content: 'hi' }]);
  await llm.complete([{ role: 'user', content: 'hi' }], { reasoning: null });
  await llm.complete([{ role: 'user', content: 'hi' }], { reasoning: 'off' });
  await llm.complete([{ role: 'user', content: 'hi' }], { reasoning: ['x'] });
  assert.deepEqual(bodies[0].reasoning, { enabled: false });
  for (const body of bodies.slice(1)) assert.equal('reasoning' in body, false);
});

// --- provider routing per model family (llm.providerByModel) ---

const BEDROCK = { only: ['amazon-bedrock'], allow_fallbacks: false };
const VERTEX = { only: ['google-vertex'] };

test('resolveProvider: the longest matching prefix is chosen, regardless of key order', () => {
  const exact = { only: ['anthropic'] };
  for (const byModel of [
    { 'anthropic/': BEDROCK, 'anthropic/claude-opus-4.6': exact },
    { 'anthropic/claude-opus-4.6': exact, 'anthropic/': BEDROCK },
  ]) {
    assert.equal(resolveProvider('anthropic/claude-opus-4.6', { byModel }), exact);
    assert.equal(resolveProvider('anthropic/claude-sonnet-4.6', { byModel }), BEDROCK);
  }
});

test('resolveProvider: a non-object entry is ignored and a shorter valid prefix still matches', () => {
  const byModel = { 'anthropic/': BEDROCK, 'anthropic/claude-opus-4.6': ['amazon-bedrock'], 'anthropic/claude': null, 'anthropic/c': 'x' };
  assert.equal(resolveProvider('anthropic/claude-opus-4.6', { byModel }), BEDROCK);
  assert.equal(resolveProvider('anthropic/claude-opus-4.6', { byModel: { 'anthropic/': 'amazon-bedrock' }, fallback: VERTEX }), VERTEX);
});

function capturingLlm(getConfig) {
  const bodies = [];
  const llm = createLlm({
    apiKey: 'k',
    getConfig,
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return okResponse('hi');
    },
  });
  return { llm, bodies };
}

test('complete: precedence options.provider > llm.providerByModel (longest prefix) > llm.provider > none', async () => {
  const exact = { only: ['anthropic'] };
  const fallback = { ignore: ['some-provider'] };
  const pinned = { order: ['google-ai-studio'], allow_fallbacks: false };
  let cfg = baseConfig({
    model: 'anthropic/claude-opus-4.6',
    provider: fallback,
    providerByModel: { 'anthropic/': BEDROCK, 'anthropic/claude-opus-4.6': exact, 'google/': VERTEX },
  });
  const { llm, bodies } = capturingLlm(() => cfg);
  const msgs = [{ role: 'user', content: 'hi' }];
  await llm.complete(msgs, { provider: pinned });
  await llm.complete(msgs);
  await llm.complete(msgs, { model: 'anthropic/claude-haiku-4.5' });
  await llm.complete(msgs, { model: 'google/gemini-3.8-flash', provider: null });
  await llm.complete(msgs, { model: 'openai/gpt-x' });
  cfg = baseConfig({ model: 'openai/gpt-x', provider: null, providerByModel: { 'anthropic/': BEDROCK } });
  await llm.complete(msgs);
  assert.deepEqual(bodies[0].provider, pinned);
  assert.deepEqual(bodies[1].provider, exact);
  assert.deepEqual(bodies[2].provider, BEDROCK);
  assert.deepEqual(bodies[3].provider, VERTEX);
  assert.deepEqual(bodies[4].provider, fallback);
  assert.equal('provider' in bodies[5], false);
});

test('complete: llm.providerByModel is read fresh on every call (hot-reloadable)', async () => {
  let providerByModel = { 'anthropic/': BEDROCK };
  const { llm, bodies } = capturingLlm(() => baseConfig({ model: 'anthropic/claude-opus-4.6', providerByModel }));
  const msgs = [{ role: 'user', content: 'hi' }];
  await llm.complete(msgs);
  providerByModel = { 'anthropic/': { only: ['anthropic'] } };
  await llm.complete(msgs);
  providerByModel = {};
  await llm.complete(msgs);
  assert.deepEqual(bodies[0].provider, BEDROCK);
  assert.deepEqual(bodies[1].provider, { only: ['anthropic'] });
  assert.equal('provider' in bodies[2], false);
});

// --- role-aware routes (`<prefix>@<role>` keys in llm.providerByModel) ---

const STUDIO = { only: ['google-ai-studio'], allow_fallbacks: false };

test('resolveProvider: a role key beats a role-less key, even when the role-less prefix is longer', () => {
  const byModel = { 'google/gemini-3.8-flash': VERTEX, 'google/@classifier.video': STUDIO };
  assert.equal(resolveProvider('google/gemini-3.8-flash', { byModel, role: 'classifier.video' }), STUDIO);
  assert.equal(resolveProvider('google/gemini-3.8-flash', { byModel, role: 'voice' }), VERTEX);
});

test('resolveProvider: a key for another role never applies; the fallback does', () => {
  const fallback = { ignore: ['some-provider'] };
  const byModel = { 'google/@classifier.video': STUDIO };
  assert.equal(resolveProvider('google/gemini-3.8-flash', { byModel, role: 'voice', fallback }), fallback);
  assert.equal(resolveProvider('google/gemini-3.8-flash', { byModel, role: 'voice' }), undefined);
});

test('resolveProvider: an empty prefix with a role matches every model for that role', () => {
  const byModel = { '@mentor': STUDIO, 'google/': VERTEX };
  assert.equal(resolveProvider('google/gemini-3.8-flash', { byModel, role: 'mentor' }), STUDIO);
  assert.equal(resolveProvider('openai/gpt-x', { byModel, role: 'mentor' }), STUDIO);
});

test('matchRoute: names the matching key and its role, or null', () => {
  const byModel = { 'google/': VERTEX, 'google/@classifier.video': STUDIO };
  assert.deepEqual(matchRoute('google/gemini-3.8-flash', byModel, 'classifier.video'), {
    key: 'google/@classifier.video', prefix: 'google/', role: 'classifier.video', value: STUDIO,
  });
  assert.deepEqual(matchRoute('google/gemini-3.8-flash', byModel, 'voice'), { key: 'google/', prefix: 'google/', role: null, value: VERTEX });
  assert.equal(matchRoute('openai/gpt-x', byModel, 'voice'), null);
  // A key splits at its last @: the role is what follows it, the prefix may hold an @ of its own.
  assert.deepEqual(matchRoute('a@b/model-x', { 'a@b@voice': STUDIO }, 'voice'), { key: 'a@b@voice', prefix: 'a@b', role: 'voice', value: STUDIO });
});

test('complete: options.role selects the role key; a call without a role uses the role-less key', async () => {
  const fallback = { ignore: ['some-provider'] };
  const { llm, bodies } = capturingLlm(() => baseConfig({
    model: 'google/gemini-3.8-flash',
    provider: fallback,
    providerByModel: { 'google/gemini-3.8-flash': VERTEX, 'google/@classifier.video': STUDIO },
  }));
  const msgs = [{ role: 'user', content: 'hi' }];
  await llm.complete(msgs, { role: 'classifier.video' });
  await llm.complete(msgs, { role: 'voice' });
  await llm.complete(msgs);
  await llm.complete(msgs, { role: 'classifier.video', provider: { order: ['x'] } });
  await llm.complete(msgs, { role: 'voice', model: 'openai/gpt-x' });
  assert.deepEqual(bodies[0].provider, STUDIO);
  assert.deepEqual(bodies[1].provider, VERTEX);
  assert.deepEqual(bodies[2].provider, VERTEX);
  assert.deepEqual(bodies[3].provider, { order: ['x'] });
  assert.deepEqual(bodies[4].provider, fallback);
  assert.equal('role' in bodies[0], false, 'the role is never sent to OpenRouter');
});

// --- prompt caching: the marker on the system message, the full prompt count, the usage code ---

/** config.json's `llm.cache` (no `models`: the code's fallback, `['anthropic/']`, applies). */
const CACHE = { ttl: '1h', roles: ['voice'], promptIncludesCached: true };

/** A model id of the family `llm.cache.models` admits by default. */
const LISTED_MODEL = 'anthropic/claude-test-4';
/** A model id outside it. */
const UNLISTED_MODEL = 'openai/gpt-test-5';

/**
 * A config with `features.promptCache` (on by default here), `llm.cache` as given and a voice
 * model of the listed family (`LISTED_MODEL`) unless `model` says otherwise.
 */
function cachingConfig({ promptCache = true, cache = CACHE, ...llm } = {}) {
  return { ...baseConfig({ maxRequestTokens: 50000, model: LISTED_MODEL, ...llm, cache }), features: { promptCache } };
}

const SYSTEM_TEXT = 'Tu es la persona du salon : réponds brièvement, sans en faire trop.';
const USER_TEXT = '<chat>\nΚαλημέρα σε όλους\n</chat>';
const MARK_1H = { type: 'ephemeral', ttl: '1h' };
const MARK_5M = { type: 'ephemeral' };

/** A reply-shaped request: one string system message, one string user message (fresh each call). */
function replyMessages() {
  return [
    { role: 'system', content: SYSTEM_TEXT },
    { role: 'user', content: USER_TEXT },
  ];
}

/** The parts of `messages` that carry a `cache_control`. */
function markedParts(messages) {
  return messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => 'cache_control' in p);
}

/**
 * The real client over a fetch that keeps every sent body as the exact string, answering with
 * `usage` (an object, or a function of the 0-based call number).
 */
function cachingLlm(getConfig, { usage = { prompt_tokens: 42 }, calibrator = fakeCalibrator() } = {}) {
  const sent = [];
  const llm = createLlm({
    apiKey: 'k',
    getConfig,
    calibrator,
    state: fakeState(),
    fetchImpl: async (url, init) => {
      sent.push(init.body);
      const answer = typeof usage === 'function' ? usage(sent.length - 1) : usage;
      return okResponse('hi', answer);
    },
  });
  return { llm, sent, bodies: () => sent.map((s) => JSON.parse(s)) };
}

test('cacheTtlFor: no marker unless features.promptCache is exactly true', () => {
  assert.equal(cacheTtlFor(cachingConfig(), 'voice', LISTED_MODEL), '1h');
  for (const promptCache of [false, undefined, null, 'true', 1, {}]) {
    assert.equal(cacheTtlFor({ ...cachingConfig(), features: { promptCache } }, 'voice', LISTED_MODEL), null, String(promptCache));
  }
  for (const config of [undefined, null, {}, { features: {} }, baseConfig({ cache: CACHE })]) {
    assert.equal(cacheTtlFor(config, 'voice', LISTED_MODEL), null, JSON.stringify(config));
  }
});

test('cacheTtlFor: a role outside llm.cache.roles gets none; a non-array roles reads as voice only', () => {
  for (const role of ['analyzer', 'classifier.text', 'mentor', undefined, null, 7]) {
    assert.equal(cacheTtlFor(cachingConfig(), role, LISTED_MODEL), null, String(role));
  }
  assert.equal(cacheTtlFor(cachingConfig({ cache: { ...CACHE, roles: ['voice', 'analyzer'] } }), 'analyzer', LISTED_MODEL), '1h');
  assert.equal(cacheTtlFor(cachingConfig({ cache: { ...CACHE, roles: [] } }), 'voice', LISTED_MODEL), null, 'an empty list marks nothing');
  for (const roles of [undefined, null, 'analyzer', { analyzer: true }]) {
    const config = cachingConfig({ cache: { ...CACHE, roles } });
    assert.equal(cacheTtlFor(config, 'voice', LISTED_MODEL), '1h', JSON.stringify(roles));
    assert.equal(cacheTtlFor(config, 'analyzer', LISTED_MODEL), null, JSON.stringify(roles));
  }
});

test('cacheTtlFor: a model outside llm.cache.models gets no marker; a non-array models reads as anthropic/ only', () => {
  // the fallback: Anthropic's ids only, whatever the switch and the role say
  for (const model of [UNLISTED_MODEL, 'google/gemini-test', 'Anthropic/claude-test-4', 'claude-test-4', '', undefined, null, 7]) {
    assert.equal(cacheTtlFor(cachingConfig(), 'voice', model), null, String(model));
  }
  for (const models of [undefined, null, 'openai/', { 'openai/': true }]) {
    const config = cachingConfig({ cache: { ...CACHE, models } });
    assert.equal(cacheTtlFor(config, 'voice', LISTED_MODEL), '1h', JSON.stringify(models));
    assert.equal(cacheTtlFor(config, 'voice', UNLISTED_MODEL), null, JSON.stringify(models));
  }
  // a listed prefix admits its family; an empty list marks nothing; a non-string entry matches nothing
  const both = cachingConfig({ cache: { ...CACHE, models: ['anthropic/', 'openai/'] } });
  assert.equal(cacheTtlFor(both, 'voice', UNLISTED_MODEL), '1h');
  assert.equal(cacheTtlFor(both, 'voice', 'google/gemini-test'), null);
  assert.equal(cacheTtlFor(cachingConfig({ cache: { ...CACHE, models: [] } }), 'voice', LISTED_MODEL), null);
  assert.equal(cacheTtlFor(cachingConfig({ cache: { ...CACHE, models: [null, 7, { a: 1 }] } }), 'voice', LISTED_MODEL), null);
  // the role gate still applies to a listed model
  assert.equal(cacheTtlFor(cachingConfig(), 'analyzer', LISTED_MODEL), null);
});

test('cacheTtlFor: an unknown ttl reads as 1h; force true and false override the policy', () => {
  assert.equal(cacheTtlFor(cachingConfig({ cache: { ...CACHE, ttl: '5m' } }), 'voice', LISTED_MODEL), '5m');
  for (const ttl of [undefined, null, '1h', '10m', '5M', 300]) {
    assert.equal(cacheTtlFor(cachingConfig({ cache: { ...CACHE, ttl } }), 'voice', LISTED_MODEL), '1h', String(ttl));
  }
  // true marks whatever the switch, the role list and the model list say (the cache probe sends it with the switch off)
  assert.equal(cacheTtlFor(baseConfig(), 'mentor', 'test-model', true), '1h');
  assert.equal(cacheTtlFor({ llm: { cache: { ttl: '5m' } } }, undefined, undefined, true), '5m');
  assert.equal(cacheTtlFor(cachingConfig({ promptCache: false }), 'voice', LISTED_MODEL, true), '1h');
  assert.equal(cacheTtlFor(cachingConfig({ cache: { ...CACHE, models: [] } }), 'voice', UNLISTED_MODEL, true), '1h');
  // false forbids it on a listed role and model with the switch on
  assert.equal(cacheTtlFor(cachingConfig(), 'voice', LISTED_MODEL, false), null);
  // anything else leaves the policy in charge
  for (const force of [undefined, null, 'true', 1]) {
    assert.equal(cacheTtlFor(cachingConfig(), 'voice', LISTED_MODEL, force), '1h', String(force));
    assert.equal(cacheTtlFor(cachingConfig(), 'analyzer', LISTED_MODEL, force), null, String(force));
    assert.equal(cacheTtlFor(cachingConfig(), 'voice', UNLISTED_MODEL, force), null, String(force));
  }
});

test('fullPromptTokens: prompt_tokens as reported by default; plus cached and cache-write tokens when llm.cache.promptIncludesCached is false', () => {
  const usage = { prompt_tokens: 1200, prompt_tokens_details: { cached_tokens: 8500, cache_write_tokens: 300 } };
  const includes = [
    undefined,
    {},
    baseConfig(),
    cachingConfig(),
    cachingConfig({ cache: { ...CACHE, promptIncludesCached: undefined } }),
    cachingConfig({ cache: { ...CACHE, promptIncludesCached: 'no' } }),
  ];
  for (const config of includes) assert.equal(fullPromptTokens(usage, config, true), 1200, JSON.stringify(config));
  const net = cachingConfig({ cache: { ...CACHE, promptIncludesCached: false } });
  assert.equal(fullPromptTokens(usage, net, true), 10000);
  assert.equal(fullPromptTokens({ prompt_tokens: 1200 }, net, true), 1200, 'no details add nothing');
  assert.equal(
    fullPromptTokens({ prompt_tokens: 1200, prompt_tokens_details: { cached_tokens: 'many', cache_write_tokens: -5 } }, net, true),
    1200,
    'a detail that is not a count adds nothing',
  );
  assert.equal(fullPromptTokens({ prompt_tokens: 0, prompt_tokens_details: { cached_tokens: 900 } }, net, true), 900);
});

test('fullPromptTokens: an unmarked request keeps prompt_tokens as reported even under promptIncludesCached false', () => {
  // A provider that caches on its own (no marker sent) already counts its cached tokens inside
  // prompt_tokens: adding them back would count them twice.
  const usage = { prompt_tokens: 20000, prompt_tokens_details: { cached_tokens: 5000, cache_write_tokens: 300 } };
  const net = cachingConfig({ cache: { ...CACHE, promptIncludesCached: false } });
  for (const marked of [false, undefined, null, 'true', 1]) {
    assert.equal(fullPromptTokens(usage, net, marked), 20000, String(marked));
  }
  assert.equal(fullPromptTokens(usage, net, true), 25300, 'only a marked request is read by the probed route');
});

test('fullPromptTokens: no reported prompt count gives null', () => {
  const net = cachingConfig({ cache: { ...CACHE, promptIncludesCached: false } });
  for (const usage of [undefined, null, 5, {}, { prompt_tokens: 0 }, { prompt_tokens: 'many' }, { prompt_tokens: Number.NaN }, { prompt_tokens: -3 }, { prompt_tokens: Infinity }]) {
    assert.equal(fullPromptTokens(usage, cachingConfig(), true), null, JSON.stringify(usage));
  }
  assert.equal(fullPromptTokens({ prompt_tokens_details: { cached_tokens: 900 } }, net, true), null, 'details without a prompt count are no count');
  assert.equal(fullPromptTokens({ prompt_tokens: 0 }, net, true), null);
  assert.equal(fullPromptTokens({ prompt_tokens: 0, prompt_tokens_details: { cached_tokens: 900 } }, net, false), null, 'unmarked: nothing is added back');
});

test('withCacheMarker: a string system message becomes one text part with the same text and the marker', () => {
  const messages = replyMessages();
  const sent = withCacheMarker(messages, '1h');
  assert.deepEqual(sent, [
    { role: 'system', content: [{ type: 'text', text: SYSTEM_TEXT, cache_control: MARK_1H }] },
    { role: 'user', content: USER_TEXT },
  ]);
  assert.equal(sent[1], messages[1], 'the user message is passed on as it is');
});

test('withCacheMarker: an array system content gets the marker on its last text part', () => {
  const picture = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'première partie' }, { type: 'text', text: 'dernière partie' }, picture] },
    { role: 'user', content: USER_TEXT },
  ];
  const sent = withCacheMarker(messages, '1h');
  assert.deepEqual(sent[0].content, [
    { type: 'text', text: 'première partie' },
    { type: 'text', text: 'dernière partie', cache_control: MARK_1H },
    picture,
  ]);
  assert.equal(sent[1], messages[1]);
});

test('withCacheMarker: a request without a system message is unchanged', () => {
  const plain = [{ role: 'user', content: 'Γεια σου' }];
  assert.deepEqual(withCacheMarker(plain, '1h'), [{ role: 'user', content: 'Γεια σου' }]);
  assert.deepEqual(withCacheMarker(plain, '5m'), [{ role: 'user', content: 'Γεια σου' }]);
  // an empty system text gets no marker either: an empty block carrying a marker would be refused
  const empty = [{ role: 'system', content: '' }, { role: 'user', content: 'Γεια σου' }];
  assert.deepEqual(withCacheMarker(empty, '1h'), [{ role: 'system', content: '' }, { role: 'user', content: 'Γεια σου' }]);
  const noText = [{ role: 'system', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }];
  assert.deepEqual(markedParts(withCacheMarker(noText, '1h')), []);
});

test("withCacheMarker: the caller's messages and parts are never mutated", () => {
  const messages = [
    { role: 'system', content: SYSTEM_TEXT },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'bloc stable', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: USER_TEXT },
        { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
      ],
    },
  ];
  const before = structuredClone(messages);
  const first = withCacheMarker(messages, '5m');
  withCacheMarker(messages, '1h');
  withCacheMarker(messages, null);
  assert.deepEqual(messages, before);
  // two markers of one result are separate objects: a later change to one never reaches the other
  const [systemMark, userMark] = markedParts(first).map((p) => p.cache_control);
  assert.notEqual(systemMark, userMark);
});

test('withCacheMarker: without a ttl every builder-placed cache_control is stripped', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: SYSTEM_TEXT, cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    { role: 'user', content: [{ type: 'text', text: 'bloc stable', cache_control: { type: 'ephemeral' } }, { type: 'text', text: USER_TEXT }] },
  ];
  for (const ttl of [null, undefined, '2h']) {
    assert.deepEqual(withCacheMarker(messages, ttl), [
      { role: 'system', content: [{ type: 'text', text: SYSTEM_TEXT }] },
      { role: 'user', content: [{ type: 'text', text: 'bloc stable' }, { type: 'text', text: USER_TEXT }] },
    ], String(ttl));
  }
  // nothing to strip: the very same messages come back, a string system content stays a string
  const plain = replyMessages();
  assert.equal(withCacheMarker(plain, null), plain);
});

test('withCacheMarker: a builder-placed marker takes the configured ttl', () => {
  const messages = [
    { role: 'system', content: SYSTEM_TEXT },
    { role: 'user', content: [{ type: 'text', text: 'bloc stable', cache_control: { type: 'ephemeral', ttl: '1h' } }, { type: 'text', text: USER_TEXT }] },
  ];
  const sent = withCacheMarker(messages, '5m');
  assert.deepEqual(sent[0].content, [{ type: 'text', text: SYSTEM_TEXT, cache_control: MARK_5M }]);
  assert.deepEqual(sent[1].content, [{ type: 'text', text: 'bloc stable', cache_control: MARK_5M }, { type: 'text', text: USER_TEXT }]);
});

test('withCacheMarker: no more than four markers are sent', () => {
  const letters = ['α', 'β', 'γ', 'δ', 'ε'];
  const messages = [
    { role: 'system', content: SYSTEM_TEXT },
    { role: 'user', content: letters.map((text) => ({ type: 'text', text, cache_control: { type: 'ephemeral' } })) },
  ];
  const sent = withCacheMarker(messages, '5m');
  assert.equal(markedParts(sent).length, 4);
  assert.deepEqual(sent[0].content[0].cache_control, MARK_5M, 'the system marker comes first in message order');
  assert.deepEqual(sent[1].content.map((p) => 'cache_control' in p), [true, true, true, false, false]);
  assert.deepEqual(sent[1].content.map((p) => p.text), letters, 'the text is kept on every part');
  // without a system message the first four builder markers survive
  assert.deepEqual(withCacheMarker([messages[1]], '1h')[0].content.map((p) => 'cache_control' in p), [true, true, true, true, false]);
});

// --- cache segments: the reply's stable user prefix and its profiles --------------------

/** A reply whose user message is three text parts (stable, profiles, tail) and a picture, as buildRequest sends it. */
function segmentedMessages() {
  return [
    { role: 'system', content: SYSTEM_TEXT },
    {
      role: 'user',
      content: [
        { type: 'text', text: '<self_facts>\n- aime le thé\n</self_facts>\n\n', cacheSegment: 'stable' },
        { type: 'text', text: '<people>\n## Zoé\n</people>\n\n', cacheSegment: 'profiles' },
        { type: 'text', text: USER_TEXT },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    },
  ];
}

/** Whether any part of `messages` still carries a `cacheSegment`. */
function anySegment(messages) {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => 'cacheSegment' in p));
}

test('profilesTtlFor: 1h as it is, null or false for no marker, anything else 5m', () => {
  assert.equal(profilesTtlFor({ llm: { cache: { profilesTtl: '1h' } } }), '1h');
  for (const off of [null, false]) assert.equal(profilesTtlFor({ llm: { cache: { profilesTtl: off } } }), null, String(off));
  for (const value of ['5m', undefined, '2h', 5, true, '']) {
    assert.equal(profilesTtlFor({ llm: { cache: { profilesTtl: value } } }), '5m', String(value));
  }
  for (const config of [undefined, null, {}, { llm: {} }]) assert.equal(profilesTtlFor(config), '5m', JSON.stringify(config));
});

test('withCacheMarker: cacheSegment stable takes the request ttl, profiles its own, and the tag is never sent', () => {
  const messages = segmentedMessages();
  const before = structuredClone(messages);
  const sent = withCacheMarker(messages, '1h', '5m');
  assert.deepEqual(sent[0].content, [{ type: 'text', text: SYSTEM_TEXT, cache_control: MARK_1H }]);
  assert.deepEqual(sent[1].content, [
    { type: 'text', text: '<self_facts>\n- aime le thé\n</self_facts>\n\n', cache_control: MARK_1H },
    { type: 'text', text: '<people>\n## Zoé\n</people>\n\n', cache_control: MARK_5M },
    { type: 'text', text: USER_TEXT },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ]);
  assert.equal(sent[1].content[2], messages[1].content[2], 'an untagged part is passed on as it is');
  assert.equal(anySegment(sent), false);
  assert.deepEqual(messages, before, 'the caller keeps its tags');
  const hourly = withCacheMarker(segmentedMessages(), '1h', '1h');
  assert.deepEqual(markedParts(hourly).map((p) => p.cache_control), [MARK_1H, MARK_1H, MARK_1H]);
});

test('withCacheMarker: a profiles ttl never outlasts a 5m request ttl; null leaves the profiles unmarked', () => {
  const short = withCacheMarker(segmentedMessages(), '5m', '1h');
  assert.deepEqual(markedParts(short).map((p) => p.cache_control), [MARK_5M, MARK_5M, MARK_5M]);
  for (const profilesTtl of [null, undefined]) {
    const sent = withCacheMarker(segmentedMessages(), '1h', profilesTtl);
    assert.deepEqual(markedParts(sent).map((p) => p.text), [SYSTEM_TEXT, '<self_facts>\n- aime le thé\n</self_facts>\n\n'], String(profilesTtl));
    assert.equal(anySegment(sent), false);
  }
});

test('withCacheMarker: without a ttl, or with an unknown segment, the tag is stripped and no marker placed', () => {
  for (const ttl of [null, undefined, '2h']) {
    const sent = withCacheMarker(segmentedMessages(), ttl, '5m');
    assert.deepEqual(markedParts(sent), [], String(ttl));
    assert.equal(anySegment(sent), false, String(ttl));
    assert.equal(sent[0].content, SYSTEM_TEXT, 'the system message stays a string');
    assert.deepEqual(sent[1].content.map((p) => p.text ?? null), segmentedMessages()[1].content.map((p) => p.text ?? null));
  }
  const odd = [{ role: 'user', content: [{ type: 'text', text: 'α', cacheSegment: 'tail' }, { type: 'text', text: 'β', cacheSegment: '__proto__' }] }];
  assert.deepEqual(withCacheMarker(odd, '1h', '5m'), [{ role: 'user', content: [{ type: 'text', text: 'α' }, { type: 'text', text: 'β' }] }]);
});

test('withCacheMarker: system, stable and profiles are three of the four markers; a fifth is dropped', () => {
  const messages = segmentedMessages();
  messages[1].content.push({ type: 'text', text: 'γ', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'δ', cache_control: { type: 'ephemeral' } });
  const sent = withCacheMarker(messages, '1h', '5m');
  assert.equal(markedParts(sent).length, 4);
  assert.deepEqual(sent[1].content.map((p) => 'cache_control' in p), [true, true, false, false, true, false]);
});

test('complete: a segmented reply is sent with the system, stable and profiles markers, never the tag; off or unlisted, with neither', async () => {
  let config = cachingConfig({ cache: { ...CACHE, profilesTtl: '5m' } });
  const { llm, sent, bodies } = cachingLlm(() => config);
  await llm.complete(segmentedMessages(), { role: 'voice' });
  config = cachingConfig({ cache: { ...CACHE, profilesTtl: null } });
  await llm.complete(segmentedMessages(), { role: 'voice' });
  config = cachingConfig({ promptCache: false });
  await llm.complete(segmentedMessages(), { role: 'voice' });
  config = cachingConfig({ model: UNLISTED_MODEL });
  await llm.complete(segmentedMessages(), { role: 'voice' });
  config = cachingConfig();
  await llm.complete(segmentedMessages(), { role: 'analyzer' });
  await llm.complete(segmentedMessages(), { role: 'voice' });
  const [on, noProfiles, off, unlisted, otherRole, defaulted] = bodies();
  assert.deepEqual(markedParts(on.messages).map((p) => p.cache_control), [MARK_1H, MARK_1H, MARK_5M]);
  assert.deepEqual(markedParts(noProfiles.messages).map((p) => p.cache_control), [MARK_1H, MARK_1H]);
  for (const body of [off, unlisted, otherRole]) assert.deepEqual(markedParts(body.messages), []);
  for (const raw of sent) assert.equal(raw.includes('cacheSegment'), false);
  assert.deepEqual(markedParts(defaulted.messages).map((p) => p.cache_control), [MARK_1H, MARK_1H, MARK_5M], 'a missing llm.cache.profilesTtl reads as 5m');
});

test('complete: the estimate and the token cap count every text part of the user message', async () => {
  const part = 'α'.repeat(800);
  const messages = [
    { role: 'system', content: SYSTEM_TEXT },
    {
      role: 'user',
      content: [
        { type: 'text', text: part, cacheSegment: 'stable' },
        { type: 'text', text: part, cacheSegment: 'profiles' },
        { type: 'text', text: part },
      ],
    },
  ];
  const { llm } = cachingLlm(() => cachingConfig({ maxRequestTokens: 1000 }));
  await assert.rejects(llm.complete(messages, { role: 'voice' }), (err) => err instanceof TokenLimitError && err.used > 1000);
  const { llm: roomy } = cachingLlm(() => cachingConfig({ maxRequestTokens: 5000 }));
  const answered = await roomy.complete(messages, { role: 'voice' });
  const joined = await roomy.complete([messages[0], { role: 'user', content: part.repeat(3) }], { role: 'voice' });
  assert.equal(answered.estimated, joined.estimated);
});

test('complete: with promptCache on, a reply request carries the marker on the system part and the user message is sent unchanged', async () => {
  let config = cachingConfig();
  const { llm, bodies } = cachingLlm(() => config);
  await llm.complete(replyMessages(), { role: 'voice' });
  config = cachingConfig({ cache: { ...CACHE, ttl: '5m' } });
  await llm.complete(replyMessages(), { role: 'voice' });
  const [hour, minutes] = bodies();
  assert.deepEqual(hour.messages, [
    { role: 'system', content: [{ type: 'text', text: SYSTEM_TEXT, cache_control: MARK_1H }] },
    { role: 'user', content: USER_TEXT },
  ]);
  assert.deepEqual(minutes.messages[0].content, [{ type: 'text', text: SYSTEM_TEXT, cache_control: MARK_5M }]);
  assert.deepEqual(minutes.messages[1], { role: 'user', content: USER_TEXT });
  for (const body of [hour, minutes]) {
    assert.equal('cache_control' in body, false, 'no top-level marker: it would put the breakpoint after the whole prompt');
    assert.equal(markedParts(body.messages).length, 1);
  }
});

test("complete: with promptCache off or the role not listed the body is byte-identical to today's", async () => {
  const messages = [
    { role: 'system', content: SYSTEM_TEXT },
    { role: 'user', content: [{ type: 'text', text: USER_TEXT }, { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] },
  ];
  const today = (model) => JSON.stringify({ model, messages, temperature: 1, max_tokens: 100 });
  const configs = [
    baseConfig({ maxRequestTokens: 50000 }),
    cachingConfig({ promptCache: false }),
    { ...cachingConfig(), features: {} },
    { ...cachingConfig(), features: { promptCache: 'true' } },
  ];
  for (const config of configs) {
    const { llm, sent } = cachingLlm(() => config);
    for (const role of ['voice', 'analyzer', 'classifier.text', 'mentor', undefined]) await llm.complete(messages, { role });
    for (const body of sent) assert.equal(body, today(config.llm.model));
  }
  const { llm, sent } = cachingLlm(() => cachingConfig());
  for (const role of ['analyzer', 'classifier.text', 'classifier.media', 'mentor', undefined]) await llm.complete(messages, { role });
  for (const body of sent) assert.equal(body, today(LISTED_MODEL));
});

test('complete: a reply request on a non-listed model is byte-identical with promptCache on', async () => {
  const messages = replyMessages();
  const today = (model) => JSON.stringify({ model, messages, temperature: 1, max_tokens: 100 });
  // the configured voice model hot-switched to another family, or another model passed for one call
  let config = cachingConfig({ model: UNLISTED_MODEL });
  const { llm, sent } = cachingLlm(() => config);
  await llm.complete(messages, { role: 'voice' });
  config = cachingConfig();
  await llm.complete(messages, { role: 'voice', model: UNLISTED_MODEL });
  config = cachingConfig({ model: UNLISTED_MODEL, cache: { ...CACHE, models: ['anthropic/'] } });
  await llm.complete(messages, { role: 'voice' });
  assert.deepEqual(sent, [today(UNLISTED_MODEL), today(UNLISTED_MODEL), today(UNLISTED_MODEL)]);
  // a listed family marks the same request, and a list naming the other family marks it too
  await llm.complete(messages, { role: 'voice', model: LISTED_MODEL });
  config = cachingConfig({ model: UNLISTED_MODEL, cache: { ...CACHE, models: ['openai/'] } });
  await llm.complete(messages, { role: 'voice' });
  assert.deepEqual(sent.slice(3).map((body) => markedParts(JSON.parse(body).messages).length), [1, 1]);
});

test('complete: options.cache false forbids the marker and true forces it', async () => {
  let config = cachingConfig();
  const { llm, bodies } = cachingLlm(() => config);
  await llm.complete(replyMessages(), { role: 'voice', cache: false });
  // no features.promptCache at all, and a model outside llm.cache.models: the force wins over both
  config = baseConfig({ maxRequestTokens: 50000, cache: { ...CACHE, ttl: '5m' } });
  await llm.complete(replyMessages(), { role: 'classifier.text', cache: true });
  await llm.complete(replyMessages(), { role: 'voice' });
  const [forbidden, forced, policy] = bodies();
  assert.deepEqual(forbidden.messages, replyMessages());
  assert.deepEqual(forced.messages[0].content, [{ type: 'text', text: SYSTEM_TEXT, cache_control: MARK_5M }]);
  assert.deepEqual(policy.messages, replyMessages(), 'the force is for one call only');
});

test('complete: the cache policy is read from the live config on every call', async () => {
  let config = cachingConfig({ promptCache: false });
  const { llm, bodies } = cachingLlm(() => config);
  await llm.complete(replyMessages(), { role: 'voice' });
  config = cachingConfig();
  await llm.complete(replyMessages(), { role: 'voice' });
  config = cachingConfig({ cache: { ...CACHE, roles: ['analyzer'] } });
  await llm.complete(replyMessages(), { role: 'voice' });
  assert.deepEqual(bodies().map((b) => markedParts(b.messages).length), [0, 1, 0]);
});

test('complete: the estimate and the token cap check are the same with and without a marker', async () => {
  const applied = [];
  const calibrator = { ...fakeCalibrator(), apply: (n) => { applied.push(n); return n; } };
  let config = cachingConfig({ promptCache: false });
  const { llm, sent } = cachingLlm(() => config, { calibrator });
  const plain = await llm.complete(replyMessages(), { role: 'voice' });
  config = cachingConfig();
  const marked = await llm.complete(replyMessages(), { role: 'voice' });
  assert.equal(markedParts(JSON.parse(sent[1]).messages).length, 1, 'the second request did carry the marker');
  assert.equal(marked.estimated, plain.estimated);
  assert.deepEqual(applied, [plain.estimated, plain.estimated], 'the estimator saw the same raw count');
  // the cap at exactly the estimate lets both through; one below refuses both before any fetch
  for (const promptCache of [false, true]) {
    config = cachingConfig({ promptCache, maxRequestTokens: plain.estimated });
    await llm.complete(replyMessages(), { role: 'voice' });
    config = cachingConfig({ promptCache, maxRequestTokens: plain.estimated - 1 });
    await assert.rejects(llm.complete(replyMessages(), { role: 'voice' }), (err) => {
      assert.ok(err instanceof TokenLimitError);
      assert.equal(err.used, plain.estimated);
      return true;
    });
  }
  assert.equal(sent.length, 4, 'only the requests under the cap were sent');
});

test('complete: llm: usage carries cache read, write, none or off from the usage fields', async () => {
  const usages = {
    read: { prompt_tokens: 9300, prompt_tokens_details: { cached_tokens: 8900, cache_write_tokens: 0 } },
    write: { prompt_tokens: 9300, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 8900 } },
    both: { prompt_tokens: 9300, prompt_tokens_details: { cached_tokens: 8900, cache_write_tokens: 200 } },
    none: { prompt_tokens: 9300, prompt_tokens_details: { cached_tokens: 0 } },
    bare: { prompt_tokens: 9300 },
  };
  const order = Object.keys(usages);
  let config = cachingConfig();
  const { llm } = cachingLlm(() => config, { usage: (call) => usages[order[call]] ?? usages.read });
  const { logs } = await withCapturedLogs(async () => {
    for (let i = 0; i < order.length; i += 1) await llm.complete(replyMessages(), { role: 'voice' });
    await llm.complete(replyMessages(), { role: 'classifier.text' }); // a read reported, no marker sent
    await llm.complete([{ role: 'user', content: 'Γεια σου' }], { role: 'voice' }); // nothing to mark
    config = cachingConfig({ promptCache: false });
    await llm.complete(replyMessages(), { role: 'voice' });
  });
  const lines = usageFields(logs);
  assert.deepEqual(lines.map((l) => l.cache), ['read', 'write', 'read', 'none', 'none', 'off', 'off', 'off']);
  assert.deepEqual(lines.map((l) => [l.cachedTokens, l.cacheWriteTokens]).slice(0, 2), [[8900, 0], [0, 8900]]);
  assert.equal(lines[5].cachedTokens, 8900, 'the counts are logged whether or not a marker was sent');
  const text = JSON.stringify(logs);
  assert.ok(!text.includes('persona du salon') && !text.includes('Καλημέρα'), 'counts and codes only, never prompt text');
});

test('complete: the calibrator observes the full prompt count when the usage reports cached tokens', async () => {
  // Under both readings of llm.cache.promptIncludesCached: as reported (true, the default) or
  // net of the cache (false: the cached and written tokens are added back).
  const usage = { prompt_tokens: 600, prompt_tokens_details: { cached_tokens: 8500, cache_write_tokens: 200 } };
  const cases = [
    [CACHE, 600],
    [{ ttl: '1h', roles: ['voice'] }, 600],
    [{ ...CACHE, promptIncludesCached: false }, 9300],
  ];
  for (const [cache, counted] of cases) {
    const calibrator = fakeCalibrator();
    const { llm } = cachingLlm(() => cachingConfig({ cache }), { usage, calibrator });
    const result = await llm.complete(replyMessages(), { role: 'voice' });
    assert.deepEqual(calibrator.observed, [[result.estimated, counted]], JSON.stringify(cache));
    assert.equal(result.promptTokens, counted, 'the caller gets the same full count');
  }
  // skipCalibration still feeds nothing, and still returns the full count
  const calibrator = fakeCalibrator();
  const { llm } = cachingLlm(() => cachingConfig({ cache: { ...CACHE, promptIncludesCached: false } }), { usage, calibrator });
  const skipped = await llm.complete(replyMessages(), { role: 'voice', skipCalibration: true });
  assert.deepEqual(calibrator.observed, []);
  assert.equal(skipped.promptTokens, 9300);
  // no usage count: null
  const { llm: bare } = cachingLlm(() => cachingConfig(), { usage: {} });
  assert.equal((await bare.complete(replyMessages(), { role: 'voice' })).promptTokens, null);
});

test('complete: an unmarked request reporting cached tokens feeds prompt_tokens unchanged under promptIncludesCached false', async () => {
  // An analyzer on a provider that caches on its own: no marker sent, cached tokens already inside prompt_tokens.
  const usage = { prompt_tokens: 20000, prompt_tokens_details: { cached_tokens: 5000, cache_write_tokens: 0 } };
  const net = { ...CACHE, promptIncludesCached: false };
  const cases = [
    [cachingConfig({ cache: net }), { role: 'analyzer' }],
    [cachingConfig({ cache: net, model: UNLISTED_MODEL }), { role: 'voice' }],
    [cachingConfig({ cache: net }), { role: 'voice', cache: false }],
    [cachingConfig({ cache: net, promptCache: false }), { role: 'voice' }],
  ];
  for (const [config, options] of cases) {
    const calibrator = fakeCalibrator();
    const { llm, sent } = cachingLlm(() => config, { usage, calibrator });
    const result = await llm.complete(replyMessages(), options);
    assert.ok(!sent[0].includes('cache_control'), JSON.stringify(options));
    assert.deepEqual(calibrator.observed, [[result.estimated, 20000]], JSON.stringify(options));
    assert.equal(result.promptTokens, 20000);
  }
  // the same answer to a marked request is read as net of the cache
  const calibrator = fakeCalibrator();
  const { llm } = cachingLlm(() => cachingConfig({ cache: net }), { usage, calibrator });
  const marked = await llm.complete(replyMessages(), { role: 'voice' });
  assert.deepEqual(calibrator.observed, [[marked.estimated, 25000]]);
});

test('complete: the token-cap warning uses the same full prompt count', async () => {
  const usage = { prompt_tokens: 800, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 0 } };
  const warned = async (promptIncludesCached) => {
    const { llm } = cachingLlm(() => cachingConfig({ maxRequestTokens: 1000, cache: { ...CACHE, promptIncludesCached } }), { usage });
    const { logs } = await withCapturedLogs(() => llm.complete(replyMessages(), { role: 'voice' }));
    return logs.filter((l) => l.msg === 'llm: provider counted more prompt tokens than the cap').length;
  };
  assert.equal(await warned(true), 0, '800 as reported is under the cap of 1000');
  assert.equal(await warned(false), 1, '800 + 600 counted back is over it');
});

// --- shared transport helpers (also used by src/llm/images.js) ---

test('openRouterHeaders: bearer key, JSON body and the neutral X-Title', () => {
  assert.deepEqual(openRouterHeaders('k1'), {
    Authorization: 'Bearer k1',
    'Content-Type': 'application/json',
    'X-Title': 'neptunia-bot',
  });
});

// ---------------------------------------------------------------------------
// modelEndpoints: the free listing GET of /nep ping image
// ---------------------------------------------------------------------------

test('modelEndpoints: one GET of the listing with the key and a timeout; nothing counted, nothing calibrated', async () => {
  const calls = [];
  const state = fakeState();
  const calibrator = fakeCalibrator();
  const body = { data: { architecture: { output_modalities: ['image'] }, endpoints: [{}] } };
  const llm = createLlm({
    apiKey: 'k-test',
    getConfig: () => baseConfig({ baseUrl: 'https://openrouter.ai/api/v1/' }),
    calibrator,
    state,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => body };
    },
  });

  const result = await llm.modelEndpoints('openai/gpt-image-x', { timeoutMs: 1234 });

  assert.deepEqual(result, { ok: true, status: 200, json: body });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/models/openai/gpt-image-x/endpoints');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k-test');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.deepEqual(state.data, {}, 'the daily counter is untouched');
  assert.equal(state.dirty, undefined);
  assert.deepEqual(calibrator.observed, []);
});

test('modelEndpoints: a non-2xx answer has no json, an unparsable body reads as null, a network failure throws', async () => {
  const make = (fetchImpl) =>
    createLlm({ apiKey: 'k', getConfig: () => baseConfig(), calibrator: fakeCalibrator(), state: fakeState(), fetchImpl });

  const missing = make(async () => ({ ok: false, status: 404, json: async () => ({ error: 'x' }) }));
  assert.deepEqual(await missing.modelEndpoints('a/b'), { ok: false, status: 404, json: null });

  const garbled = make(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }));
  assert.deepEqual(await garbled.modelEndpoints('a/b'), { ok: true, status: 200, json: null });

  const down = make(async () => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(() => down.modelEndpoints('a/b'), TypeError);
});

// Restored by the lead: truncation detection, text-free logs and the cache marker's roles are real behaviour.
test('complete: passes through choices[0].finish_reason as finishReason, undefined when the provider omits it', async () => {
  for (const [label, response, expected] of [
    ['length', {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'cut off' }, finish_reason: 'length' }], usage: {} }),
    }, 'length'],
    ['omitted', okResponse('hi'), undefined], // okResponse's choices carry no finish_reason
  ]) {
    const llm = createLlm({
      apiKey: 'k',
      getConfig: () => baseConfig(),
      calibrator: fakeCalibrator(),
      state: fakeState(),
      fetchImpl: async () => response,
    });
    const result = await llm.complete([{ role: 'user', content: 'hi' }]);
    assert.equal(result.finishReason, expected, label);
  }
});

test('complete: the usage line keeps numbers, booleans and ids only; a value of another type is null', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => jsonResponse({
      id: { text: 'not an id' },
      provider: ['not a name'],
      choices: [{ message: { content: 'hi' } }],
      usage: {
        prompt_tokens: 'many',
        completion_tokens: null,
        prompt_tokens_details: { cached_tokens: 'some', cache_write_tokens: [1] },
        completion_tokens_details: 'none',
        cost: '0.1',
        is_byok: 'yes',
        cost_details: { upstream_inference_cost: { value: 1 } },
      },
    }),
  });
  const { logs } = await withCapturedLogs(() => llm.complete([{ role: 'user', content: 'hi' }], { role: 7 }));
  assert.deepEqual(usageFields(logs), [{ role: null, model: 'test-model', ...NO_USAGE }]);
});

test('complete: a classifier.text request carries no marker even with promptCache on', async () => {
  const { llm, sent } = cachingLlm(() => cachingConfig());
  for (const role of ['classifier.text', 'analyzer', 'mentor', undefined]) {
    await llm.complete(replyMessages(), { role });
  }
  assert.equal(sent.length, 4);
  for (const body of sent) {
    assert.deepEqual(JSON.parse(body).messages, replyMessages());
    assert.ok(!body.includes('cache_control'));
  }
});

// --- hedged helper requests (llm.hedge): a second attempt after a short wait, the first answer wins ---
// The clock and the hedge's timers are injected; the transport answers when a test says so.
// Each test sets the hedge it needs in its own config.

const HEDGE = { roles: ['classifier.text'], afterMs: 2500, timeoutMs: 8000, longTimeoutMs: 20000 };

/** Lets every settled promise run its handlers (no wall-clock wait). */
const drain = () => new Promise((resolve) => setImmediate(resolve));

/** A clock with timers that fire only when the test advances it. */
function fakeClock(start = Date.UTC(2026, 9, 5, 12, 0, 0)) {
  let nowMs = start;
  let seq = 0;
  const timers = [];
  return {
    now: () => nowMs,
    setTimer: (fn, ms) => {
      const timer = { at: nowMs + ms, fn, seq: seq++ };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const at = timers.indexOf(timer);
      if (at !== -1) timers.splice(at, 1);
    },
    pending: () => timers.length,
    async advance(ms) {
      const target = nowMs + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        if (!timers.length || timers[0].at > target) break;
        const timer = timers.shift();
        nowMs = timer.at;
        timer.fn();
        await drain();
      }
      nowMs = target;
      await drain();
    },
  };
}

/**
 * A transport whose every request waits for the test: `calls[i].answer(response)` or
 * `calls[i].fail(err)`. An aborted request rejects with its signal's reason, unless
 * `honourAbort` is false (a provider that answers anyway).
 */
function deferredTransport({ honourAbort = true } = {}) {
  const calls = [];
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    calls.push({ body: init.body, signal: init.signal, answer: resolve, fail: reject });
    if (!honourAbort) return;
    if (init.signal.aborted) reject(init.signal.reason);
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  return { calls, fetchImpl };
}

/** A client on a fake clock and a deferred transport; `hedge: 'none'` leaves the llm.hedge group out. */
function hedgedLlm({ hedge = HEDGE, llm = {}, transport = deferredTransport(), state = fakeState() } = {}) {
  const clock = fakeClock();
  const config = baseConfig({ helperTimeoutMs: 600000, ...llm });
  if (hedge !== 'none') config.llm.hedge = hedge;
  const client = createLlm({
    apiKey: 'k',
    getConfig: () => config,
    calibrator: fakeCalibrator(),
    state,
    fetchImpl: transport.fetchImpl,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  // A helper's request, as every in-turn helper spells it.
  const ask = ({ role = 'classifier.text', signal, long, extra = {} } = {}) =>
    client.complete([{ role: 'user', content: 'Ναι ή όχι;' }], {
      model: 'small/model',
      ...helperRequestOptions(config, { role, maxOutputTokens: 5, purpose: 'address', signal, long }),
      ...extra,
    });
  return { ask, clock, state, calls: transport.calls };
}

/** Watches a promise without awaiting it: `status` is pending, resolved or rejected. */
function watch(promise) {
  const seen = { status: 'pending', value: undefined };
  promise.then(
    (value) => Object.assign(seen, { status: 'resolved', value }),
    (value) => Object.assign(seen, { status: 'rejected', value }),
  );
  return seen;
}

/** The fields of the log lines named `msg`, level and time dropped. */
function linesOf(logs, msg) {
  return logs.filter((l) => l.msg === msg).map(({ level, time, msg: _msg, ...fields }) => fields);
}

test('hedge: an attempt answering before afterMs is the only one sent', async () => {
  const { ask, clock, calls, state } = hedgedLlm();
  const { result, logs } = await withCapturedLogs(async () => {
    const pending = ask();
    await drain();
    assert.equal(calls.length, 1);
    await clock.advance(HEDGE.afterMs - 1);
    calls[0].answer(okResponse('ναι'));
    const answered = await pending;
    await clock.advance(HEDGE.timeoutMs);
    return answered;
  });
  assert.equal(result.text, 'ναι');
  assert.equal(calls.length, 1, 'no second attempt');
  assert.equal(state.data.llmCount, 1);
  assert.equal(clock.pending(), 0, 'the hedge leaves no timer behind');
  assert.deepEqual(linesOf(logs, 'llm: hedge'), []);
  const [usage] = linesOf(logs, 'llm: usage');
  assert.deepEqual([usage.hedged, usage.attempt, usage.ms], [false, 1, HEDGE.afterMs - 1]);
});

test('hedge: a slow first attempt gets a second at afterMs with the same body; the faster wins, the other is aborted', async () => {
  for (const winner of [1, 2]) {
    const { ask, clock, calls, state } = hedgedLlm();
    const { result, logs } = await withCapturedLogs(async () => {
      const pending = ask();
      await clock.advance(HEDGE.afterMs - 1);
      assert.equal(calls.length, 1);
      await clock.advance(1);
      assert.equal(calls.length, 2, 'the second attempt goes out at afterMs');
      await clock.advance(300);
      calls[winner - 1].answer(okResponse(`attempt ${winner}`, { prompt_tokens: 12 }));
      return pending;
    });
    assert.equal(result.text, `attempt ${winner}`);
    assert.equal(calls[1].body, calls[0].body, 'the same request twice');
    assert.equal(calls[winner - 1].signal.aborted, false, 'the winner is left alone');
    assert.equal(calls[2 - winner].signal.aborted, true, 'the loser is aborted');
    assert.equal(state.data.llmCount, 2, 'both attempts were sent and counted');
    assert.deepEqual(linesOf(logs, 'llm: hedge'), [{ role: 'classifier.text', purpose: 'address', model: 'small/model', afterMs: HEDGE.afterMs }]);
    const usage = linesOf(logs, 'llm: usage');
    assert.equal(usage.length, 1, 'one answer, one usage line');
    assert.deepEqual([usage[0].hedged, usage[0].attempt, usage[0].ms], [true, winner, HEDGE.afterMs + 300], 'ms from the first attempt\'s start');
    assert.equal(clock.pending(), 0);
  }
});

test('hedge: the loser\'s late answer or failure is swallowed -- no rejection, no log line', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const lateOutcomes = [
      (call) => call.fail(new TypeError('fetch failed')),
      (call) => call.answer(errorResponse(503)),
      (call) => call.answer(okResponse('trop tard')),
    ];
    for (const late of lateOutcomes) {
      const { ask, clock, calls } = hedgedLlm({ transport: deferredTransport({ honourAbort: false }) });
      const { result, logs } = await withCapturedLogs(async () => {
        const pending = ask();
        await clock.advance(HEDGE.afterMs);
        calls[0].answer(okResponse('premier'));
        const answered = await pending;
        late(calls[1]);
        await clock.advance(HEDGE.timeoutMs);
        return answered;
      });
      assert.equal(result.text, 'premier');
      assert.equal(linesOf(logs, 'llm: usage').length, 1);
      assert.deepEqual(linesOf(logs, 'llm: retry'), []);
    }
    await drain();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test('hedge: a retryable failure waits for the other attempt; both failing throw once, the answered error over a network one', async () => {
  const { ask, clock, calls } = hedgedLlm();
  const { logs } = await withCapturedLogs(async () => {
    const seen = watch(ask());
    await clock.advance(HEDGE.afterMs);
    calls[0].fail(new TypeError('fetch failed'));
    await drain();
    assert.equal(seen.status, 'pending', 'the second attempt is still out');
    calls[1].answer(errorResponse(503, 'unavailable'));
    await drain();
    assert.equal(seen.status, 'rejected');
    assert.equal(seen.value.statusCode, 503);
    await clock.advance(HEDGE.timeoutMs);
  });
  assert.equal(calls.length, 2, 'never retried past the two attempts');
  assert.deepEqual(linesOf(logs, 'llm: retry'), []);
  assert.deepEqual(linesOf(logs, 'llm: usage'), []);
});

test('hedge: a retryable failure of the first attempt sends the second at once; a non-retryable one is thrown alone', async () => {
  const early = hedgedLlm();
  const seen = watch(early.ask());
  await early.clock.advance(300);
  early.calls[0].answer(errorResponse(502));
  await drain();
  assert.equal(early.calls.length, 2, 'the hedge is the call\'s retry');
  early.calls[1].answer(okResponse('ok'));
  await drain();
  assert.equal(seen.value.text, 'ok');

  const final = hedgedLlm();
  const refused = watch(final.ask());
  await drain();
  final.calls[0].answer(errorResponse(400, 'bad request'));
  await drain();
  assert.equal(refused.status, 'rejected');
  assert.equal(refused.value.statusCode, 400);
  await final.clock.advance(HEDGE.timeoutMs);
  assert.equal(final.calls.length, 1);
});

test('hedge: at timeoutMs both attempts are aborted and a timeout is thrown, without a retry', async () => {
  const { ask, clock, calls } = hedgedLlm();
  const seen = watch(ask());
  await clock.advance(HEDGE.timeoutMs - 1);
  assert.equal(seen.status, 'pending');
  await clock.advance(1);
  assert.equal(seen.status, 'rejected');
  assert.equal(seen.value.name, 'TimeoutError');
  assert.deepEqual(calls.map((call) => call.signal.aborted), [true, true]);
  await clock.advance(HEDGE.timeoutMs * 2);
  assert.equal(calls.length, 2);
  assert.equal(clock.pending(), 0);
});

test('hedge: the daily counter counts the second attempt only when it is sent, and never sends it without room', async () => {
  const roomy = hedgedLlm({ llm: { maxRequestsPerDay: 2 } });
  const both = watch(roomy.ask());
  await drain();
  assert.equal(roomy.state.data.llmCount, 1, 'the first attempt is counted when it is sent');
  await roomy.clock.advance(HEDGE.afterMs);
  assert.equal(roomy.calls.length, 2);
  assert.equal(roomy.state.data.llmCount, 2, 'and the second when it is sent');
  roomy.calls[1].answer(okResponse('ok'));
  await drain();
  assert.equal(both.value.text, 'ok');

  // One slot left: the first attempt takes it, the second is never sent.
  const tight = hedgedLlm({ llm: { maxRequestsPerDay: 1 } });
  const { result, logs } = await withCapturedLogs(async () => {
    const pending = tight.ask();
    await tight.clock.advance(HEDGE.afterMs + 1000);
    assert.equal(tight.calls.length, 1);
    tight.calls[0].answer(okResponse('ok'));
    return pending;
  });
  assert.equal(result.text, 'ok');
  assert.equal(tight.state.data.llmCount, 1);
  assert.deepEqual(linesOf(logs, 'llm: hedge'), []);
  const [usage] = linesOf(logs, 'llm: usage');
  assert.deepEqual([usage.hedged, usage.attempt], [false, 1]);

  // ... and when that first attempt then fails, the refusal is what the caller sees.
  const refused = hedgedLlm({ llm: { maxRequestsPerDay: 1 } });
  const seen = watch(refused.ask());
  await refused.clock.advance(HEDGE.afterMs);
  refused.calls[0].fail(new TypeError('fetch failed'));
  await drain();
  assert.ok(seen.value instanceof DailyCapError);
  assert.equal(railReason(seen.value), 'daily-cap');
  assert.equal(refused.calls.length, 1);
});

test('hedge: a provider\'s quota of the day is thrown at once, never hedged around', async () => {
  const { ask, clock, calls } = hedgedLlm();
  const body = upstreamLimitBody(DAILY_RAW);
  const { logs } = await withCapturedLogs(async () => {
    const seen = watch(ask());
    await drain();
    calls[0].answer(errorResponse(429, body));
    await drain();
    assert.equal(seen.value.statusCode, 429);
    assert.equal(seen.value.body, body);
    await clock.advance(HEDGE.timeoutMs);
  });
  assert.equal(calls.length, 1);
  assert.equal(linesOf(logs, 'llm: provider limit').length, 1);
});

test('hedge: the caller\'s signal aborts both attempts', async () => {
  const { ask, clock, calls } = hedgedLlm();
  const controller = new AbortController();
  const seen = watch(ask({ signal: controller.signal }));
  await clock.advance(HEDGE.afterMs);
  assert.equal(calls.length, 2);
  controller.abort();
  await drain();
  assert.equal(seen.status, 'rejected');
  assert.deepEqual(calls.map((call) => call.signal.aborted), [true, true]);
  await clock.advance(HEDGE.timeoutMs);
  assert.equal(calls.length, 2);
  assert.equal(clock.pending(), 0);
});

test('hedge: no helper mark, a role not listed, afterMs 0 or no llm.hedge object -- one attempt, today\'s usage line', async () => {
  const cases = [
    { name: 'no helper mark', extra: { helper: undefined } },
    { name: 'role not listed', role: 'classifier.media' },
    { name: 'afterMs 0', hedge: { ...HEDGE, afterMs: 0 } },
    { name: 'no group', hedge: 'none' },
    { name: 'group not an object', hedge: true },
  ];
  for (const { name, role, extra, hedge } of cases) {
    const { ask, clock, calls } = hedgedLlm({ hedge });
    const { result, logs } = await withCapturedLogs(async () => {
      const pending = ask({ role, extra });
      await clock.advance(HEDGE.timeoutMs * 2);
      assert.equal(calls.length, 1, name);
      calls[0].answer(okResponse('ok'));
      return pending;
    });
    assert.equal(result.text, 'ok', name);
    const [usage] = linesOf(logs, 'llm: usage');
    assert.equal('hedged' in usage || 'attempt' in usage, false, name);
    assert.deepEqual(linesOf(logs, 'llm: hedge'), [], name);
  }
});

test('hedgeSettings: null without an llm.hedge object; inside the group a missing or invalid key reads as config.json', () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  for (const config of [undefined, null, {}, { llm: {} }, { llm: { hedge: null } }, { llm: { hedge: [] } }]) {
    assert.equal(hedgeSettings(config), null, JSON.stringify(config));
  }
  for (const hedge of [{}, { roles: 'classifier.text', afterMs: -1, timeoutMs: 0 }, { afterMs: '1', timeoutMs: Infinity, longTimeoutMs: -5 }]) {
    assert.deepEqual(hedgeSettings({ llm: { hedge } }), shipped.llm.hedge, JSON.stringify(hedge));
  }
  assert.deepEqual(hedgeSettings({ llm: { hedge: { roles: [], afterMs: 0 } } }), { ...shipped.llm.hedge, roles: [], afterMs: 0 });
});

test('helperRequestOptions: long true marks the set, anything else leaves the key out', () => {
  const config = { llm: { helperTimeoutMs: 12000 } };
  assert.equal(helperRequestOptions(config, { role: 'classifier.text', long: true }).long, true);
  for (const long of [undefined, false, 1, 'yes']) {
    assert.equal('long' in helperRequestOptions(config, { role: 'classifier.text', long }), false, String(long));
  }
});

test('hedge: a set marked long is limited by longTimeoutMs, still hedged at afterMs; neither mark is sent', async () => {
  const hedge = { ...HEDGE, timeoutMs: 4000, longTimeoutMs: 9000 };
  const { ask, clock, calls } = hedgedLlm({ hedge });
  const { logs } = await withCapturedLogs(async () => {
    const seen = watch(ask({ long: true }));
    await clock.advance(hedge.afterMs);
    assert.equal(calls.length, 2, 'hedged at afterMs as ever');
    await clock.advance(hedge.timeoutMs);
    assert.equal(seen.status, 'pending', 'not cut at timeoutMs');
    await clock.advance(hedge.longTimeoutMs - hedge.timeoutMs - hedge.afterMs - 1);
    assert.equal(seen.status, 'pending');
    await clock.advance(1);
    assert.equal(seen.status, 'rejected');
    assert.equal(seen.value.name, 'TimeoutError');
  });
  assert.equal(calls.length, 2, 'no retry past the two attempts');
  assert.deepEqual(calls.map((call) => call.signal.aborted), [true, true]);
  assert.deepEqual(linesOf(logs, 'llm: retry'), []);
  for (const call of calls) {
    assert.deepEqual(Object.keys(JSON.parse(call.body)).sort(), ['max_tokens', 'messages', 'model', 'temperature']);
  }

  // The caller's own signal still aborts both attempts of a long call.
  const own = hedgedLlm({ hedge });
  const controller = new AbortController();
  const aborted = watch(own.ask({ long: true, signal: controller.signal }));
  await own.clock.advance(hedge.afterMs);
  controller.abort();
  await drain();
  assert.equal(aborted.status, 'rejected');
  assert.deepEqual(own.calls.map((call) => call.signal.aborted), [true, true]);
  assert.equal(own.clock.pending(), 0);
});

// --- an explicit hedge (`options.hedge`): the reply of a turn with a bar ---

/** The hedge a reply request carries in the tests below: attempt 2 at 500 ms, all cut at 5 s. */
const REPLY_HEDGE = { afterMs: 500, timeoutMs: 5000 };

/**
 * The real client on a fake clock and a deferred transport, with the prompt cache on for the
 * voice role; `llm` overrides keys of the llm group. `ask(extra)` sends a reply-shaped request
 * (REPLY_REQUEST, no helper mark) with `extra` added to its options.
 */
function replyLlm({ llm = {}, transport = deferredTransport(), state = fakeState() } = {}) {
  const clock = fakeClock();
  const config = cachingConfig({ timeoutMs: REPLY_HEDGE.timeoutMs, ...llm });
  const client = createLlm({
    apiKey: 'k',
    getConfig: () => config,
    calibrator: fakeCalibrator(),
    state,
    fetchImpl: transport.fetchImpl,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const ask = (extra = {}) => client.complete(replyMessages(), { ...REPLY_REQUEST, timeoutMs: REPLY_HEDGE.timeoutMs, ...extra });
  return { ask, clock, state, calls: transport.calls };
}

test('hedge: an explicit options.hedge hedges a non-helper request at its afterMs; the first answer wins, both bodies cached alike', async () => {
  const { ask, clock, calls, state } = replyLlm();
  const { result, logs } = await withCapturedLogs(async () => {
    const pending = ask({ hedge: { ...REPLY_HEDGE } });
    await clock.advance(REPLY_HEDGE.afterMs - 1);
    assert.equal(calls.length, 1);
    await clock.advance(1);
    assert.equal(calls.length, 2, 'the second attempt goes out at afterMs');
    await clock.advance(200);
    calls[1].answer(okResponse('second'));
    return pending;
  });
  assert.equal(result.text, 'second');
  assert.equal(calls[0].signal.aborted, true, 'the slower attempt is aborted');
  assert.equal(calls[1].signal.aborted, false);
  assert.equal(calls[1].body, calls[0].body, 'the same request twice');
  assert.equal(markedParts(JSON.parse(calls[0].body).messages).length, 1, 'the cache marker is on both attempts');
  assert.deepEqual(Object.keys(JSON.parse(calls[0].body)).sort(), ['max_tokens', 'messages', 'model', 'temperature']);
  assert.equal(state.data.llmCount, 2, 'both attempts counted');
  assert.deepEqual(linesOf(logs, 'llm: hedge'), [{ role: 'voice', purpose: 'reply', model: LISTED_MODEL, afterMs: REPLY_HEDGE.afterMs }]);
  const [usage] = linesOf(logs, 'llm: usage');
  assert.deepEqual([usage.hedged, usage.attempt, usage.ms], [true, 2, REPLY_HEDGE.afterMs + 200]);
  assert.equal(clock.pending(), 0);
});

test('hedge: a non-helper request without a valid explicit hedge is sent once, even on a role llm.hedge lists', async () => {
  const cases = [
    { name: 'no hedge', extra: {} },
    { name: 'afterMs 0', extra: { hedge: { ...REPLY_HEDGE, afterMs: 0 } } },
    { name: 'afterMs not a number', extra: { hedge: { ...REPLY_HEDGE, afterMs: '500' } } },
    { name: 'no timeoutMs', extra: { hedge: { afterMs: REPLY_HEDGE.afterMs } } },
    { name: 'not an object', extra: { hedge: REPLY_HEDGE.afterMs } },
  ];
  for (const { name, extra } of cases) {
    const { ask, clock, calls } = replyLlm({ llm: { hedge: { ...HEDGE, roles: ['voice'], afterMs: 100 } } });
    const { result, logs } = await withCapturedLogs(async () => {
      const pending = ask(extra);
      await clock.advance(REPLY_HEDGE.timeoutMs - 1);
      assert.equal(calls.length, 1, name);
      calls[0].answer(okResponse('ok'));
      return pending;
    });
    assert.equal(result.text, 'ok', name);
    assert.deepEqual(linesOf(logs, 'llm: hedge'), [], name);
    const [usage] = linesOf(logs, 'llm: usage');
    assert.equal('hedged' in usage || 'attempt' in usage, false, name);
  }
});

test('hedge: an explicit hedge keeps the rails -- the token cap before any attempt, the daily cap on attempt 2, its timeoutMs on the whole call', async () => {
  const capped = replyLlm({ llm: { maxRequestTokens: 5 } });
  await assert.rejects(capped.ask({ hedge: { ...REPLY_HEDGE } }), TokenLimitError);
  assert.equal(capped.calls.length, 0);

  const tight = replyLlm({ llm: { maxRequestsPerDay: 1 } });
  const { logs } = await withCapturedLogs(async () => {
    const pending = tight.ask({ hedge: { ...REPLY_HEDGE } });
    await tight.clock.advance(REPLY_HEDGE.afterMs + 1000);
    assert.equal(tight.calls.length, 1, 'no room under the daily cap: attempt 2 is never sent');
    tight.calls[0].answer(okResponse('ok'));
    assert.equal((await pending).text, 'ok');
  });
  assert.equal(tight.state.data.llmCount, 1);
  assert.deepEqual(linesOf(logs, 'llm: hedge'), []);

  const stalled = replyLlm();
  const seen = watch(stalled.ask({ hedge: { ...REPLY_HEDGE } }));
  await stalled.clock.advance(REPLY_HEDGE.timeoutMs - 1);
  assert.equal(seen.status, 'pending');
  await stalled.clock.advance(1);
  assert.equal(seen.value.name, 'TimeoutError');
  assert.deepEqual(stalled.calls.map((call) => call.signal.aborted), [true, true]);
  assert.equal(stalled.clock.pending(), 0);
});

// --- one speaking model: the reply and the memory wording share the role `voice` ---

test('REPLY_REQUEST and MEMORY_VOICE_REQUEST: both go out as role voice, told apart by purpose on the usage line only', async () => {
  const { llm, sent } = cachingLlm(() => cachingConfig({ promptCache: false }));
  const { logs } = await withCapturedLogs(async () => {
    await llm.complete(replyMessages(), { ...REPLY_REQUEST });
    await llm.complete(replyMessages(), { ...MEMORY_VOICE_REQUEST });
  });
  assert.deepEqual(usageLines(logs).map(({ role, purpose }) => ({ role, purpose })), [
    { role: 'voice', purpose: 'reply' },
    { role: 'voice', purpose: 'memory-voice' },
  ]);
  for (const body of sent) {
    for (const word of ['purpose', 'memory-voice', '"reply"']) assert.ok(!body.includes(word), `${word} is never sent`);
  }
});

test('complete: with the cache on, the reply is marked and the memory wording on the same role and model is not', async () => {
  for (const roles of [['voice'], ['talk']]) {
    const { llm, bodies } = cachingLlm(() => cachingConfig({ cache: { ...CACHE, roles } }));
    await withCapturedLogs(async () => {
      await llm.complete(replyMessages(), { ...REPLY_REQUEST });
      await llm.complete(replyMessages(), { ...MEMORY_VOICE_REQUEST });
    });
    const [reply, memory] = bodies();
    assert.equal(markedParts(reply.messages).length, 1, `the reply is marked: ${roles}`);
    assert.equal(markedParts(memory.messages).length, 0, `the memory wording is not: ${roles}`);
    assert.equal(memory.messages[0].content, SYSTEM_TEXT, 'sent exactly as without caching');
  }
});

test('cacheTtlFor: llm.cache.roles listing the old name talk still marks the voice role, and only it', () => {
  const config = cachingConfig({ cache: { ...CACHE, roles: ['talk'] } });
  assert.equal(cacheTtlFor(config, 'voice', LISTED_MODEL), '1h');
  assert.equal(cacheTtlFor(config, 'talk', LISTED_MODEL), null, 'a request never carries the old name');
  assert.equal(cacheTtlFor(config, 'analyzer', LISTED_MODEL), null);
});

test('complete: a "<prefix>@talk" route key still routes the reply; no request role talk is accepted', async () => {
  const { llm, bodies } = capturingLlm(() => baseConfig({
    model: 'anthropic/claude-test-4',
    providerByModel: { 'anthropic/@talk': BEDROCK, 'anthropic/': { only: ['anthropic'] } },
  }));
  const msgs = [{ role: 'user', content: 'hi' }];
  await withCapturedLogs(async () => {
    await llm.complete(msgs, { ...REPLY_REQUEST });
    await llm.complete(msgs, { ...MEMORY_VOICE_REQUEST });
    await llm.complete(msgs, { role: 'analyzer' });
    await llm.complete(msgs, { role: 'talk' });
  });
  assert.deepEqual(bodies.map((b) => b.provider), [BEDROCK, BEDROCK, { only: ['anthropic'] }, { only: ['anthropic'] }]);
  const route = await withCapturedLogs(() => matchRoute('anthropic/claude-test-4', { 'anthropic/@talk': BEDROCK }, 'voice'));
  assert.deepEqual(route.result, { key: 'anthropic/@talk', prefix: 'anthropic/', role: 'voice', value: BEDROCK });
});

test('hedgeSettings: llm.hedge.roles listing talk reads as voice', async () => {
  const { result } = await withCapturedLogs(() => hedgeSettings({ llm: { hedge: { roles: ['talk', 'classifier.text'] } } }));
  assert.deepEqual(result.roles, ['voice', 'classifier.text']);
});

test('currentRoleName: talk reads as voice and says so once per process; any other value passes through', async () => {
  // A fresh instance of the module: its report-once flag is not touched by the tests above.
  const fresh = await import(`../src/llm/openrouter.js?retired-role=${Date.now()}`);
  const { result, logs } = await withCapturedLogs(() => [
    fresh.currentRoleName('talk'),
    fresh.currentRoleName('talk'),
    fresh.currentRoleName('voice'),
    fresh.currentRoleName('analyzer'),
    fresh.currentRoleName(undefined),
    fresh.currentRoleName(7),
    fresh.matchRoute('x/model', { 'x/@talk': BEDROCK }, 'voice')?.role,
    fresh.cacheTtlFor({ features: { promptCache: true }, llm: { cache: { roles: ['talk'] } } }, 'voice', 'anthropic/m'),
  ]);
  assert.deepEqual(result, ['voice', 'voice', 'voice', 'analyzer', undefined, 7, 'voice', '1h']);
  assert.equal(logs.filter((line) => line.msg === 'config: role talk is now voice').length, 1);
  assert.equal(currentRoleName('mentor'), 'mentor');
});

// --- a choice-level provider error inside a 200 ---

const CONTEXT_ERROR_ANSWER = {
  id: 'gen-err',
  provider: 'Google',
  choices: [{
    finish_reason: 'error',
    native_finish_reason: 'INVALID_ARGUMENT',
    error: {
      code: 400,
      message: 'The input token count exceeds the maximum number of tokens allowed 1048576.',
      metadata: { error_type: 'context_length_exceeded' },
    },
    message: { role: 'assistant', content: null },
  }],
  usage: { prompt_tokens: 0, completion_tokens: 0 },
};

test('complete: a 200 with a choice-level error rejects with the provider message, once, without a usage line', async () => {
  let calls = 0;
  const calibrator = fakeCalibrator();
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator,
    state: fakeState(),
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(CONTEXT_ERROR_ANSWER);
    },
  });
  const { result: err, logs } = await withCapturedLogs(() =>
    llm.complete([{ role: 'user', content: 'the prompt itself' }], { role: 'classifier.video', purpose: 'video', model: 'google/gemini-x' })
      .then(() => assert.fail('expected a rejection'), (e) => e),
  );
  assert.ok(err instanceof Error);
  assert.equal(err.message, 'The input token count exceeds the maximum number of tokens allowed 1048576.');
  assert.equal(err.statusCode, 400);
  assert.equal(err.errorType, 'context_length_exceeded');
  assert.equal(err.nativeFinishReason, 'INVALID_ARGUMENT');
  assert.equal(railReason(err), 'llm-error');
  assert.equal(calls, 1, 'never retried');
  assert.deepEqual(calibrator.observed, []);
  assert.deepEqual(linesOf(logs, 'llm: usage'), []);
  assert.deepEqual(linesOf(logs, 'llm: retry'), []);
  const warned = logs.filter((l) => l.msg === 'llm: provider error');
  assert.equal(warned.length, 1);
  const { level, time, msg, ms, ...fields } = warned[0];
  assert.equal(level, 'warn');
  assert.ok(Number.isInteger(ms) && ms >= 0);
  assert.deepEqual(fields, {
    role: 'classifier.video',
    purpose: 'video',
    model: 'google/gemini-x',
    status: 400,
    errorType: 'context_length_exceeded',
    nativeFinishReason: 'INVALID_ARGUMENT',
  });
  assert.ok(!JSON.stringify(warned[0]).includes('the prompt itself'));
});

test('complete: finish_reason error without an error object rejects with the finish reason, no status', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => jsonResponse({ choices: [{ finish_reason: 'error', message: { content: null } }] }),
  });
  const { result: err } = await withCapturedLogs(() =>
    llm.complete([{ role: 'user', content: 'x' }]).then(() => assert.fail('expected a rejection'), (e) => e),
  );
  assert.equal(err.message, 'error');
  assert.equal(err.statusCode, undefined);
  assert.equal(err.errorType, null);
  assert.equal(err.nativeFinishReason, null);
});

test('complete: an ordinary answer with finish_reason stop is unaffected by the choice-error check', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'fine' } }], usage: { prompt_tokens: 5 } }),
  });
  const { result, logs } = await withCapturedLogs(() => llm.complete([{ role: 'user', content: 'x' }]));
  assert.equal(result.text, 'fine');
  assert.equal(result.finishReason, 'stop');
  assert.equal(linesOf(logs, 'llm: usage').length, 1);
  assert.deepEqual(linesOf(logs, 'llm: provider error'), []);
});

test('hedge: a choice-level error of the winning attempt is thrown, not hedged again', async () => {
  const { ask, clock, calls } = hedgedLlm();
  const { logs } = await withCapturedLogs(async () => {
    const seen = watch(ask());
    await drain();
    calls[0].answer(jsonResponse(CONTEXT_ERROR_ANSWER));
    await drain();
    assert.equal(seen.status, 'rejected');
    assert.equal(seen.value.statusCode, 400);
    await clock.advance(HEDGE.timeoutMs);
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(linesOf(logs, 'llm: usage'), []);
  assert.equal(linesOf(logs, 'llm: provider error').length, 1);
});

test('openrouter: estimate-off and output-cap are reported to the collector', async () => {
  let usage = null;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ safetyMargin: 0.9, maxOutputTokens: 100 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => okResponse('x', usage),
  });
  const messages = [{ role: 'user', content: 'λέξη '.repeat(80) }];

  // The provider counted twice the estimate and the completion reached the request's max.
  let limits = createLimits();
  const probe = await llm.complete(messages, { limits: createLimits() });
  usage = { prompt_tokens: probe.estimated * 2, completion_tokens: 100 };
  const first = await llm.complete(messages, { purpose: 'reply', limits });
  assert.deepEqual(limits.list(), [
    { kind: 'estimate-off', where: 'reply', lost: first.estimated, detail: `${first.estimated}->${first.estimated * 2}` },
    { kind: 'output-cap', where: 'completion', lost: null },
  ]);

  // Within the margin (10 %), and a completion under its own max: nothing to report.
  limits = createLimits();
  usage = { prompt_tokens: Math.floor(first.estimated * 1.1), completion_tokens: 40 };
  await llm.complete(messages, { purpose: 'reply', maxOutputTokens: 50, limits });
  assert.deepEqual(limits.list(), []);

  // The request's own max counts, not llm.maxOutputTokens.
  usage = { prompt_tokens: first.estimated, completion_tokens: 50 };
  await llm.complete(messages, { maxOutputTokens: 50, limits });
  assert.deepEqual(limits.list(), [{ kind: 'output-cap', where: 'completion', lost: null }]);

  // No collector: nothing breaks.
  await llm.complete(messages);
});
