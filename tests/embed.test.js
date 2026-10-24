// Tests for src/llm/embed.js: the embedding client's request shape, normalisation, retries, the
// two rails and the usage line. No network: fetchImpl is always a fake, the backoff sleep is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmbedder, normalizeVector, EMBED_ROLE } from '../src/llm/embed.js';
import { ROLE_DEFAULTS } from '../src/llm/roles.js';
import { DailyCapError, NotByokError, TokenLimitError, llmCountToday } from '../src/llm/openrouter.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

const DAY = Date.UTC(2026, 9, 14, 12);

function config(overrides = {}) {
  return {
    llm: {
      baseUrl: 'https://openrouter.ai/api/v1/',
      maxRequestTokens: 1000,
      maxRequestsPerDay: 10,
      helperTimeoutMs: 4000,
      retries: 2,
      providerByModel: { 'openai/@embedding': { only: ['openai'] } },
      ...overrides.llm,
    },
    models: { base: { analyzer: 'x/text', embedding: 'openai/text-embedding-3-large', ...overrides.models?.base }, byPurpose: { ...overrides.models?.byPurpose } },
    embed: { dimensions: 4, ...overrides.embed },
  };
}

function fakeState() {
  return { data: {}, markDirty() { this.dirty = (this.dirty ?? 0) + 1; } };
}

function jsonResponse(status, json) {
  return { ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json) };
}

function embeddingsOf(vectors, extra = {}) {
  return jsonResponse(200, {
    id: 'gen-1',
    model: 'openai/text-embedding-3-large',
    provider: 'OpenAI',
    data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
    usage: { prompt_tokens: 7, total_tokens: 7, cost: 0.0001 },
    ...extra,
  });
}

function makeEmbedder(answers, { state = fakeState() } = {}) {
  const sent = [];
  const sleeps = [];
  const queue = [...answers];
  const embedder = createEmbedder({
    apiKey: 'k',
    state,
    now: () => DAY,
    sleepImpl: async (ms) => sleeps.push(ms),
    fetchImpl: async (url, init) => {
      sent.push({ url, init, body: JSON.parse(init.body) });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { embedder, sent, sleeps, state };
}

test('embed: one POST to /embeddings with model, input and dimensions, routed by the embedding role', async () => {
  const { embedder, sent } = makeEmbedder([embeddingsOf([[3, 4, 0, 0], [0, 0, 0, 2]])]);
  const vectors = await embedder.embed(['Ωmega', 'café'], { config: config(), purpose: 'search' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://openrouter.ai/api/v1/embeddings');
  assert.equal(sent[0].init.method, 'POST');
  assert.equal(sent[0].init.headers.Authorization, 'Bearer k');
  assert.deepEqual(sent[0].body, {
    model: 'openai/text-embedding-3-large',
    input: ['Ωmega', 'café'],
    dimensions: 4,
    provider: { only: ['openai'] },
  });
  assert.equal(vectors.length, 2);
  assert.ok(vectors.every((vector) => vector instanceof Float32Array));
  assert.deepEqual([...vectors[0]].map((x) => Math.round(x * 1000) / 1000), [0.6, 0.8, 0, 0]);
  assert.deepEqual([...vectors[1]], [0, 0, 0, 1]);
});

test('embed: a models.byPurpose entry picks the model; the vectors come back in input order', async () => {
  const { embedder, sent } = makeEmbedder([jsonResponse(200, { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] })]);
  const vectors = await embedder.embed(['a', 'b'], { config: config({ models: { byPurpose: { search: 'other/embed' } }, embed: { dimensions: 2 } }), purpose: 'search' });
  assert.equal(sent[0].body.model, 'other/embed');
  assert.equal('provider' in sent[0].body, false, 'no route for that model');
  assert.deepEqual(vectors.map((vector) => [...vector]), [[1, 0], [0, 1]]);
});

test('normalizeVector: unit length; a zero vector stays zero; anything not a finite number list is refused', () => {
  assert.deepEqual([...normalizeVector([0, 0, 5])], [0, 0, 1]);
  assert.deepEqual([...normalizeVector([0, 0])], [0, 0]);
  for (const bad of [null, 'x', [], [1, 'a'], [1, Infinity]]) assert.equal(normalizeVector(bad), null, JSON.stringify(bad));
});

test('embed: dimensions read now from embed.dimensions; an invalid value reads as config.json', async () => {
  const { embedder, sent } = makeEmbedder([embeddingsOf([[1]]), embeddingsOf([[1]])]);
  await embedder.embed(['a'], { config: config({ embed: { dimensions: 256 } }) });
  await embedder.embed(['a'], { config: config({ embed: { dimensions: -3 } }) });
  assert.deepEqual(sent.map((call) => call.body.dimensions), [256, 1024]);
});

test('embed: a 5xx or a network failure is retried after the backoff, up to llm.retries; the request counts once', async () => {
  const { embedder, sent, sleeps, state } = makeEmbedder([jsonResponse(502, { error: 'bad gateway' }), new TypeError('fetch failed'), embeddingsOf([[1, 0]])]);
  const { result, logs } = await withCapturedLogs(() => embedder.embed(['a'], { config: config(), purpose: 'search' }));
  assert.equal(result.length, 1);
  assert.equal(sent.length, 3);
  assert.deepEqual(sleeps, [1500, 3000]);
  assert.equal(llmCountToday(state.data, DAY), 1, 'one request against llm.maxRequestsPerDay');
  assert.deepEqual(logs.filter((l) => l.msg === 'llm: retry').map((l) => [l.role, l.attempt, l.status]), [['embedding', 1, 502], ['embedding', 2, null]]);
});

test('embed: a 4xx is thrown at once; the last retryable error is thrown when the retries run out', async () => {
  const bad = makeEmbedder([jsonResponse(400, { error: { message: 'bad input' } })]);
  await assert.rejects(bad.embedder.embed(['a'], { config: config() }), (err) => err.statusCode === 400);
  assert.equal(bad.sent.length, 1);
  const down = makeEmbedder([jsonResponse(503, {}), jsonResponse(503, {}), jsonResponse(503, {})]);
  await assert.rejects(withCapturedLogs(() => down.embedder.embed(['a'], { config: config() })), (err) => err.statusCode === 503);
  assert.equal(down.sent.length, 3);
});

test('embed: a 200 with an error body or a wrong number of vectors is thrown, never retried', async () => {
  const errored = makeEmbedder([jsonResponse(200, { error: { message: 'nope' } })]);
  await assert.rejects(errored.embedder.embed(['a'], { config: config() }), /OpenRouter error/);
  assert.equal(errored.sent.length, 1);
  const short = makeEmbedder([embeddingsOf([[1, 0]])]);
  await assert.rejects(short.embedder.embed(['a', 'b'], { config: config() }), /embeddings/);
  assert.equal(short.sent.length, 1);
});

test('embed: the daily request cap refuses before anything is sent, on the chat client\'s counter', async () => {
  const state = fakeState();
  state.data.llmDay = '2026-10-14';
  state.data.llmCount = 10;
  const { embedder, sent } = makeEmbedder([embeddingsOf([[1]])], { state });
  await assert.rejects(embedder.embed(['a'], { config: config() }), DailyCapError);
  assert.equal(sent.length, 0);
  const probe = await embedder.embed(['a'], { config: config(), countAgainstDailyCap: false });
  assert.equal(probe.length, 1, 'a probe that is not counted is never refused by the cap');
  assert.equal(state.data.llmCount, 10);
});

test('embed: the token cap refuses an input over llm.maxRequestTokens before anything is counted or sent', async () => {
  const { embedder, sent, state } = makeEmbedder([embeddingsOf([[1]])]);
  await assert.rejects(embedder.embed(['x'.repeat(5000)], { config: config({ llm: { maxRequestTokens: 100 } }) }), TokenLimitError);
  assert.equal(sent.length, 0);
  assert.equal(llmCountToday(state.data, DAY), 0);
});

test('embed: nothing to embed sends nothing; an empty text is an error before any request', async () => {
  const { embedder, sent, state } = makeEmbedder([]);
  assert.deepEqual(await embedder.embed([], { config: config() }), []);
  await assert.rejects(embedder.embed(['a', ''], { config: config() }), /non-empty strings/);
  assert.equal(sent.length, 0);
  assert.equal(llmCountToday(state.data, DAY), 0);
});

test('embed: an unset models.base.embedding goes out on the role default, never on another role\'s model', async () => {
  const { embedder, sent } = makeEmbedder([embeddingsOf([[1, 0, 0, 0]])]);
  await embedder.embed(['a'], { config: config({ models: { base: { analyzer: 'x/text', embedding: null } } }), purpose: 'search' });
  assert.equal(sent[0].body.model, ROLE_DEFAULTS.embedding);
});

test('embed: one llm: usage line with role embedding, counts and cost, never the input text', async () => {
  const { embedder } = makeEmbedder([embeddingsOf([[1, 0]])]);
  const { logs } = await withCapturedLogs(() => embedder.embed(['Ωmega secret'], { config: config(), purpose: 'search', origin: 'status' }));
  const usage = logs.filter((l) => l.msg === 'llm: usage');
  assert.equal(usage.length, 1);
  const { level, msg, time, ts, ...fields } = usage[0];
  assert.deepEqual(fields, {
    role: 'embedding',
    purpose: 'search',
    origin: 'status',
    model: 'openai/text-embedding-3-large',
    provider: 'OpenAI',
    promptTokens: 7,
    cost: 0.0001,
    byok: null,
    id: 'gen-1',
    inputs: 1,
    dimensions: 4,
    ms: 0,
  });
  assert.ok(!JSON.stringify(logs).includes('secret'), 'no input text in any log line');
  assert.equal(EMBED_ROLE, 'embedding');
});

/** The test config with the embedding model's route set to `route` (undefined: no route at all). */
const byokConfig = (route) => config({ llm: { providerByModel: route === undefined ? {} : { 'openai/@embedding': route } } });
const BYOK_ROUTE = { only: ['openai'], allow_fallbacks: false, byok: true };

test('embed: on a byok route, an answer with is_byok false throws NotByokError after the usage line and a not-byok warning, never retried', async () => {
  const answer = embeddingsOf([[1, 0]], { usage: { prompt_tokens: 7, cost: 0.0001, is_byok: false } });
  const { embedder, sent } = makeEmbedder([answer, embeddingsOf([[1, 0]])]);
  const { logs } = await withCapturedLogs(() =>
    assert.rejects(
      embedder.embed(['Ωmega secret'], { config: byokConfig(BYOK_ROUTE), purpose: 'search' }),
      (err) => err instanceof NotByokError && err.message === 'not byok: openai/text-embedding-3-large via OpenAI',
    ),
  );
  assert.equal(sent.length, 1);
  assert.equal(logs.filter((l) => l.msg === 'llm: usage').length, 1);
  const warn = logs.filter((l) => l.msg === 'llm: not byok');
  assert.equal(warn.length, 1);
  assert.equal(warn[0].level, 'warn');
  assert.equal(warn[0].byok, false);
  assert.ok(!JSON.stringify(logs).includes('secret'), 'no input text in any log line');
});

test('embed: without a route marked byok exactly true, or without is_byok false, the answer passes silently', async () => {
  const cases = [
    [undefined, false],
    [{ only: ['openai'] }, false],
    [{ only: ['openai'], byok: false }, false],
    [{ only: ['openai'], byok: 'true' }, false],
    [BYOK_ROUTE, undefined],
    [BYOK_ROUTE, true],
  ];
  for (const [route, isByok] of cases) {
    const usage = { prompt_tokens: 7, cost: 0.0001, ...(isByok === undefined ? {} : { is_byok: isByok }) };
    const { embedder } = makeEmbedder([embeddingsOf([[1, 0]], { usage })]);
    const { result, logs } = await withCapturedLogs(() => embedder.embed(['a'], { config: byokConfig(route) }));
    assert.equal(result.length, 1, JSON.stringify([route, isByok]));
    assert.equal(logs.filter((l) => l.msg === 'llm: not byok').length, 0, JSON.stringify([route, isByok]));
  }
});

test('embed: the body\'s provider never carries byok', async () => {
  const { embedder, sent } = makeEmbedder([embeddingsOf([[1, 0]])]);
  await withCapturedLogs(() => embedder.embed(['a'], { config: byokConfig(BYOK_ROUTE) }));
  assert.deepEqual(sent[0].body.provider, { only: ['openai'], allow_fallbacks: false });
});

test('embed: the attempt is cut at llm.helperTimeoutMs; an external abort is never retried', async () => {
  const { embedder, sent } = makeEmbedder([embeddingsOf([[1]])]);
  await embedder.embed(['a'], { config: config({ llm: { helperTimeoutMs: 5 } }) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent[0].init.signal.aborted, true);

  const controller = new AbortController();
  const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const cut = makeEmbedder([aborted, embeddingsOf([[1]])]);
  controller.abort();
  await assert.rejects(cut.embedder.embed(['a'], { config: config(), signal: controller.signal }));
  assert.equal(cut.sent.length, 0, 'an already aborted call sends nothing');
});
