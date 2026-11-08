// The body src/llm/openrouter.ts#complete sends for an analyzer request with a strict schema under the production
// settings of 2026-11-08 (the analyzer cached, `anthropic/` and `openai/` in `llm.cache.models`, a hedge, a BYOK route
// per model), and the line and the error it gives when the provider refuses it. No network: the transport is a fake
// that keeps each body. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleRequestOptions } from '../src/llm/openrouter.ts';
import type { CompleteOptions } from '../src/llm/openrouter.ts';
import { createLlm } from './fixtures/llm.ts';
import type { Err, Rec } from './fixtures/llm.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';

const SOL = 'openai/gpt-6.1-sol';
const SONNET = 'anthropic/claude-sonnet-5.5';

const settings = () => ({
  models: { base: { core: 'anthropic/claude-opus-4.6', analyzer: SOL } },
  llm: {
    baseUrl: 'https://openrouter.test/api/v1',
    maxOutputTokens: 10000,
    maxRequestTokens: 100000,
    maxRequestsPerDay: 300,
    timeoutMs: 5000,
    analyzerTimeoutMs: 5000,
    retries: 0,
    cache: { roles: ['core', 'analyzer', 'extractor'], models: ['anthropic/', 'openai/'] },
    hedge: { afterMs: 5000, timeoutMs: 12000 },
    providerByModel: {
      'anthropic/': { only: ['amazon-bedrock'], allow_fallbacks: false, byok: true },
      'openai/gpt-6': { only: ['amazon-bedrock'], allow_fallbacks: false, byok: true },
      'anthropic/claude-sonnet-5.5@analyzer': { only: ['anthropic'], allow_fallbacks: false, byok: true },
    },
  },
});

const SCHEMA = {
  type: 'object',
  properties: {
    pick: { type: 'string', enum: ['none', 'gif', 'emoji', 'replace'] },
    name: { type: ['string', 'null'], enum: ['g1', 'smile', null] },
  },
  required: ['pick', 'name'],
  additionalProperties: false,
};

const MESSAGES = [
  { role: 'system', content: 'Pick a reaction.' },
  { role: 'user', content: 'chat-line-marker-7f3a' },
];

type Answer = { ok: boolean; status: number; json?: () => Promise<unknown>; text?: () => Promise<string> };

const answered: Answer = {
  ok: true,
  status: 200,
  json: () =>
    Promise.resolve({ choices: [{ message: { content: '{"pick":"none","name":null}' } }], usage: { is_byok: true } }),
};

/** A client over a transport that gives `answer` and keeps each body it was sent, as sent. */
function rig(answer: Answer) {
  const bodies: Array<string> = [];
  const client = createLlm({
    apiKey: 'k',
    env: {},
    getConfig: settings,
    calibrator: { apply: (n: number) => n, observe: () => undefined },
    state: { data: {}, markDirty() {} },
    fetchImpl: (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return Promise.resolve(answer);
    },
  });
  return { client, bodies };
}

/** The options the media pick sends (src/behavior/media-pick.ts#askClassifier), on `model`. */
const pickOptions = (model: string): CompleteOptions => ({
  model,
  ...roleRequestOptions(settings(), { role: 'analyzer', maxOutputTokens: 60, purpose: 'media-pick' }),
  responseFormat: { name: 'media-pick', schema: SCHEMA },
});

test('an analyzer schema request on an Anthropic model carries no cache marker', async () => {
  // Bug: the media pick on Sonnet 5.5 went out with a 1h marker on its system part and every one was refused with 400.
  const { client, bodies } = rig(answered);
  await client.complete(MESSAGES, pickOptions(SONNET));
  const body = JSON.parse(bodies[0]) as { messages: Array<Rec> };
  assert.equal(bodies[0].includes('cache_control'), false);
  assert.equal(body.messages[0].content, 'Pick a reaction.');
});

test('an analyzer schema request on Sol keeps its body byte for byte', async () => {
  // Bug: a fix for the Anthropic route changes what Sol is sent, and with it Sol's cache and its answers.
  const { client, bodies } = rig(answered);
  await client.complete(MESSAGES, pickOptions(SOL));
  const sent = {
    model: SOL,
    messages: [
      {
        role: 'system',
        content: [{ type: 'text', text: 'Pick a reaction.', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      },
      { role: 'user', content: 'chat-line-marker-7f3a' },
    ],
    temperature: 1,
    max_tokens: 60,
    provider: { only: ['amazon-bedrock'], allow_fallbacks: false },
    response_format: { type: 'json_schema', json_schema: { name: 'media-pick', strict: true, schema: SCHEMA } },
  };
  assert.equal(bodies[0], JSON.stringify(sent));
});

test('an Anthropic request without a schema keeps its cache marker', async () => {
  // Bug: the marker is dropped from every Anthropic request, and her own replies lose the cache.
  const { client, bodies } = rig(answered);
  await client.complete(MESSAGES, { model: 'anthropic/claude-opus-4.6', role: 'core' });
  const body = JSON.parse(bodies[0]) as { messages: Array<{ content: Array<Rec> }> };
  assert.deepEqual(body.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' });
});

const LONG = `Invalid request: ${'x'.repeat(600)}`;

const refused: Answer = {
  ok: false,
  status: 400,
  text: () =>
    Promise.resolve(
      JSON.stringify({
        error: {
          message: 'Provider returned error',
          code: 400,
          metadata: { provider_name: 'Anthropic', raw: JSON.stringify({ error: { message: LONG } }) },
        },
      })
    ),
};

test('a refused request logs the provider name and its words, bounded, without the request', async () => {
  // Bug: the 400s of 2026-11-08 left only a status in the journal, and the cause could not be read.
  const { client } = rig(refused);
  const { logs } = await withCapturedLogs(() => assert.rejects(client.complete(MESSAGES, pickOptions(SONNET))));
  const line = logs.find((entry) => entry.msg === 'llm: http error');
  assert.equal(line?.status, 400);
  assert.equal(line?.providerName, 'Anthropic');
  const words = String(line?.providerError);
  assert.ok(words.startsWith('Provider returned error'), words.slice(0, 80));
  assert.ok(words.includes('Invalid request: xxx'), words.slice(0, 80));
  assert.ok(words.length <= 300, String(words.length));
  assert.equal(JSON.stringify(logs).includes('chat-line-marker-7f3a'), false);
});

test('a refused request throws an error carrying the bounded provider words', async () => {
  // Bug: the archive has nothing to keep but the status, so the request record says http_400 and nothing else.
  const { client } = rig(refused);
  let thrown: (Err & { providerError?: unknown }) | null = null;
  await withCapturedLogs(async () => {
    try {
      await client.complete(MESSAGES, pickOptions(SONNET));
    } catch (err) {
      thrown = err as Err & { providerError?: unknown };
    }
  });
  const words = String((thrown as (Err & { providerError?: unknown }) | null)?.providerError);
  assert.ok(words.startsWith('Provider returned error'), words.slice(0, 80));
  assert.ok(words.length <= 300, String(words.length));
});

test('a refusal whose body is not JSON logs its text, bounded', async () => {
  // Bug: a proxy's plain-text refusal is dropped because only a JSON error is read.
  const { client } = rig({ ok: false, status: 403, text: () => Promise.resolve(`Forbidden ${'y'.repeat(900)}`) });
  const { logs } = await withCapturedLogs(() => assert.rejects(client.complete(MESSAGES, pickOptions(SONNET))));
  const line = logs.find((entry) => entry.msg === 'llm: http error');
  const words = String(line?.providerError);
  assert.ok(words.startsWith('Forbidden y'), words.slice(0, 80));
  assert.ok(words.length <= 300, String(words.length));
  assert.equal(line?.providerName, null);
});
