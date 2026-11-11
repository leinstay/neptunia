// The interface field of a model call (src/llm/openrouter.ts#createLlm): the turn hands its interface as `iface`,
// the usage line names it, and the request body never carries it (PR 7a). Kept apart from tests/openrouter.test.js,
// which is at its recorded length. The cache markers of the cached user parts (withCacheMarker) are tested here too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLlm, withCacheMarker } from '../src/llm/openrouter.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import type { Untyped } from '../src/tools/types.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { chainsOf } from './fixtures/chains.ts';

function baseConfig() {
  return {
    models: { routes: chainsOf({ core: 'test-model' }) },
    llm: {
      baseUrl: 'https://openrouter.ai/api/v1',
      temperature: 1,
      maxOutputTokens: 100,
      maxRequestTokens: 1000,
      maxRequestsPerDay: 300,
      timeoutMs: 5000,
      retries: 2,
    },
    context: { vision: { tokensPerImage: 1600 } },
  };
}

function fakeState() {
  return { data: {}, markDirty: () => {} };
}

function fakeCalibrator() {
  return { ratio: 1, apply: (n: number) => n, observe: () => {} };
}

function okResponse(text: string, usage: object): Response {
  // A fake of the three members of a Response that createLlm reads.
  return wrongly({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ choices: [{ message: { content: text } }], usage }),
  });
}

test('complete: the interface of the turn is logged on its usage line and never sent', async () => {
  const sent: Array<Untyped> = [];
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(wrongly<string>(init?.body)));
      return Promise.resolve(okResponse('yes', { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 }));
    },
  });
  const complete = wrongly<(messages: unknown, options: unknown) => Promise<unknown>>(llm.complete);
  const { logs } = await withCapturedLogs(() =>
    complete([{ role: 'user', content: 'hi' }], { role: 'core', purpose: 'reply', iface: 'cli' })
  );
  const [line] = logs.filter((l) => l.msg === 'llm: usage');
  assert.equal(line.iface, 'cli');
  assert.equal(JSON.stringify(sent[0]).includes('cli'), false, 'the interface is not in the body');
});

// --- slice 8 of the turn frame: the cached parts persona, self, surroundings -------------

const SYSTEM_TEXT = 'Tu es la persona du salon : réponds brièvement.';
const USER_TEXT = '<chat>\nΚαλημέρα σε όλους\n</chat>';
const MARK_1H = { type: 'ephemeral', ttl: '1h' };
const MARK_5M = { type: 'ephemeral' };

type SentPart = { type?: string; text?: string; cache_control?: unknown };

/** Every part of `messages` that carries a cache marker, in message order. */
function markedParts(messages: ReadonlyArray<{ content?: unknown }>): Array<SentPart> {
  return messages.flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as Array<SentPart>).filter((part) => Object.hasOwn(part, 'cache_control'))
      : []
  );
}

// --- the cached parts of a turn: `stable` and `memory` -----------------------------------------------------------
// The owner's decision of 2026-11-11: every request of a turn carries its markers at the same places. The builder tags
// `<self>` with `cacheSegment: 'stable'` and the part from `<surroundings>` to the last block before the turn's own
// blocks (`<chat>` on a reply) with `cacheSegment: 'memory'`. A first request marks the system message and both parts,
// a later step marks the same three and the tail of the tool loop. `<surroundings>` has no marker of its own.

const STABLE = '<self>\n<self_facts>\n- aime le thé\n</self_facts>\n</self>\n\n';
const MEMORY =
  '<surroundings>\n<place>\nfake › Αγορά › γενικά\n</place>\n</surroundings>\n\n' +
  '<memory>\n<places>\nfake › Αγορά › λέσχη\n</places>\n</memory>\n\n<meanwhile>\nπρώτη\n</meanwhile>\n\n';

/** A reply's two messages, the user message cut into the stable, memory and tail parts. */
const threeParts = () => [
  { role: 'system', content: SYSTEM_TEXT },
  {
    role: 'user',
    content: [
      { type: 'text', text: STABLE, cacheSegment: 'stable' },
      { type: 'text', text: MEMORY, cacheSegment: 'memory' },
      { type: 'text', text: USER_TEXT },
    ],
  },
];

/** A turn's request after one step: the first two messages, her call and its result. */
const afterStep = () => [
  ...threeParts(),
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } }],
  },
  { role: 'tool', tool_call_id: 'c1', content: 'résultat' },
];

test('withCacheMarker: a first request carries exactly three markers, on the system, the end of <self> and right before <chat>', () => {
  // Bug: the part from <surroundings> to <meanwhile> is left unmarked, so a provider that caches by marker reads it anew
  // on every turn although it repeats, or the marker lands on <chat>, which changes on every turn.
  const sent = withCacheMarker(threeParts(), '1h');
  assert.deepEqual(
    markedParts(sent).map((part) => [part.text, part.cache_control]),
    [
      [SYSTEM_TEXT, MARK_1H],
      [STABLE, MARK_1H],
      [MEMORY, MARK_1H],
    ]
  );
  assert.equal(JSON.stringify(sent).includes('cacheSegment'), false);
});

test('withCacheMarker: a later step keeps the three markers of the first request and adds the tail of the tool loop', () => {
  // Bug: a later step drops the memory marker for the tail, so the entry written at the end of <meanwhile> is reached
  // only by the provider's look-back, which a wide step outruns; or the tail is left unmarked and each step re-reads
  // the results before it.
  const sent = withCacheMarker(afterStep(), '1h');
  assert.deepEqual(
    markedParts(sent).map((part) => [part.text, part.cache_control]),
    [
      [SYSTEM_TEXT, MARK_1H],
      [STABLE, MARK_1H],
      [MEMORY, MARK_1H],
      ['résultat', MARK_5M],
    ]
  );
});

test('withCacheMarker: a part tagged surroundings carries no marker of its own', () => {
  // Bug: a builder that still cuts <surroundings> apart spends a marker on it, and a later step has five candidates.
  const messages = afterStep();
  (messages[1].content as Array<Record<string, unknown>>).splice(1, 0, {
    type: 'text',
    text: '<surroundings>\nγενικά\n</surroundings>\n\n',
    cacheSegment: 'surroundings',
  });
  const sent = withCacheMarker(messages, '1h');
  assert.deepEqual(
    markedParts(sent).map((part) => part.text),
    [SYSTEM_TEXT, STABLE, MEMORY, 'résultat']
  );
  assert.equal(JSON.stringify(sent).includes('cacheSegment'), false);
});

test('withCacheMarker: with a builder-placed marker on a later step no more than four markers are sent', () => {
  // Bug: the memory or the tail marker is counted apart from the cap, so a request with a builder's own marker sends five.
  const messages = afterStep();
  (messages[1].content as Array<Record<string, unknown>>).push({
    type: 'text',
    text: 'γ',
    cache_control: { type: 'ephemeral' },
  });
  const sent = withCacheMarker(messages, '1h');
  assert.deepEqual(
    markedParts(sent).map((part) => part.text),
    [SYSTEM_TEXT, STABLE, MEMORY, 'γ']
  );
});

// Tests for the key name on the usage line of the chat client (src/llm/openrouter.ts).

const NOW = Date.parse('2026-11-20T12:00:00Z');

function coreLlm() {
  const llm = createLlm({
    apiKey: 'core-a',
    getConfig: () =>
      ({
        models: { routes: chainsOf({ core: 'x/core' }) },
        llm: {
          baseUrl: 'http://x',
          timeoutMs: 1000,
          retries: 0,
          maxRequestTokens: 1e6,
          maxOutputTokens: 10,
          maxRequestsPerDay: 100,
        },
      }) as never,
    calibrator: { apply: (n: number) => n, observe() {} },
    state: { data: {}, markDirty() {} },
    now: () => NOW,
    fetchImpl: (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
        json: () =>
          Promise.resolve({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5, cost: 0.5 } }),
      })) as never,
  });
  const ask = () => withCapturedLogs(() => llm.complete([{ role: 'user', content: 'hi' }], { role: 'core' }));
  return { ask };
}

test('createLlm: a request on the main key leaves the key field out of the usage line', async () => {
  const { ask } = coreLlm();
  const { logs } = await ask();
  assert.ok(!('key' in (logs.find((line) => line.msg === 'llm: usage') ?? {})));
});
