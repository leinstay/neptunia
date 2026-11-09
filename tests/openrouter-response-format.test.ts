// Tests for the `responseFormat` option of src/llm/openrouter.ts#complete: a strict JSON schema the request body
// carries as `response_format`, on a plain request and on both attempts of a hedged one. No network: the transport is
// a fake that records each body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleRequestOptions } from '../src/llm/openrouter.ts';
import type { CompleteOptions } from '../src/llm/openrouter.ts';
import { createLlm } from './fixtures/llm.ts';
import { chainsOf } from './fixtures/chains.ts';

type Rec = Record<string, unknown>;

const SCHEMA = {
  type: 'object',
  properties: { pick: { type: 'string', enum: ['left', 'right'] } },
  required: ['pick'],
  additionalProperties: false,
};

const FORMAT = { name: 'side', schema: SCHEMA };

/** What the body carries for FORMAT, in the exact shape of the brief. */
const SENT = { type: 'json_schema', json_schema: { name: 'side', strict: true, schema: SCHEMA } };

const HEDGE = { roles: ['analyzer'], afterMs: 2500, timeoutMs: 8000, longTimeoutMs: 20000 };

function config(hedge: Rec | null = null) {
  const llm: Rec = {
    baseUrl: 'https://openrouter.ai/api/v1',
    maxOutputTokens: 100,
    maxRequestTokens: 1000,
    maxRequestsPerDay: 300,
    timeoutMs: 5000,
    analyzerTimeoutMs: 600000,
    retries: 0,
  };
  if (hedge) llm.hedge = hedge;
  return { models: { routes: chainsOf({ core: 'test-model' }) }, llm, context: { vision: { tokensPerImage: 1600 } } };
}

function fakeState() {
  return { data: {}, markDirty() {} };
}

const calibrator = { apply: (n: number) => n, observe: () => undefined };

function okResponse(text: string) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ choices: [{ message: { content: text } }], usage: {} }),
  };
}

/** A client whose transport answers at once and keeps every body it was sent, parsed. */
function recordingLlm() {
  const bodies: Array<Rec> = [];
  const settings = config();
  const client = createLlm({
    apiKey: 'k',
    getConfig: () => settings,
    calibrator,
    state: fakeState(),
    fetchImpl: (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Rec);
      return Promise.resolve(okResponse('{"pick":"left"}'));
    },
  });
  return { client, bodies };
}

const drain = () => new Promise((resolve) => setImmediate(resolve));

/** A clock whose timers fire only when the test advances it. */
function fakeClock() {
  let nowMs = Date.UTC(2026, 10, 6, 12, 0, 0);
  const timers: Array<{ at: number; fn: () => void }> = [];
  return {
    now: () => nowMs,
    setTimer: (fn: () => void, ms: number) => {
      const timer = { at: nowMs + ms, fn };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer: { at: number; fn: () => void }) => {
      const at = timers.indexOf(timer);
      if (at !== -1) timers.splice(at, 1);
    },
    async advance(ms: number) {
      const target = nowMs + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > target) break;
        timers.shift();
        nowMs = next.at;
        next.fn();
        await drain();
      }
      nowMs = target;
      await drain();
    },
  };
}

test('a request with responseFormat carries it as a strict json_schema response_format', async () => {
  const { client, bodies } = recordingLlm();
  const options: CompleteOptions = { model: 'small/model', responseFormat: FORMAT };
  await client.complete([{ role: 'user', content: 'left or right?' }], options);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].response_format, SENT);
});

test('a request without responseFormat carries no response_format', async () => {
  const { client, bodies } = recordingLlm();
  const options: CompleteOptions = { model: 'small/model' };
  await client.complete([{ role: 'user', content: 'left or right?' }], options);
  assert.equal(bodies.length, 1);
  assert.equal(Object.hasOwn(bodies[0], 'response_format'), false);
});

test('a hedged request carries response_format on its first and on its second attempt', async () => {
  const clock = fakeClock();
  const settings = config(HEDGE);
  const sent: Array<{ body: Rec; answer: (response: unknown) => void }> = [];
  const client = createLlm({
    apiKey: 'k',
    getConfig: () => settings,
    calibrator,
    state: fakeState(),
    fetchImpl: (_url: string, init: { body: string; signal: AbortSignal }) =>
      new Promise((resolve, reject) => {
        sent.push({ body: JSON.parse(init.body) as Rec, answer: resolve });
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const options: CompleteOptions = {
    model: 'small/model',
    ...roleRequestOptions(settings, { role: 'analyzer', maxOutputTokens: 20, purpose: 'address' }),
    responseFormat: FORMAT,
  };
  const pending = client.complete([{ role: 'user', content: 'left or right?' }], options);
  await clock.advance(HEDGE.afterMs);
  assert.equal(sent.length, 2, 'the second attempt went out at afterMs');
  const [first, second] = sent;
  second.answer(okResponse('{"pick":"right"}'));
  const result = await pending;
  assert.equal(result.text, '{"pick":"right"}');
  assert.deepEqual(first.body.response_format, SENT, 'the first attempt');
  assert.deepEqual(second.body.response_format, SENT, 'the second attempt');
});
