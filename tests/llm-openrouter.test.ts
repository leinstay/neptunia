// The interface field of a model call (src/llm/openrouter.ts#createLlm): the turn hands its interface as `iface`,
// the usage line names it, and the request body never carries it (PR 7a). Kept apart from tests/openrouter.test.js,
// which is at its recorded length. The cache markers of the three cached user parts (withCacheMarker) are tested here too.
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

test('withCacheMarker: the markers fall on the system, the stable part, the surroundings part and the tail of a tool loop, and nowhere else', () => {
  // Bug: a surroundings part left unmarked is re-read on every turn, and a marker on the per-turn tail wastes one of four.
  const stable = '<self>\n<self_facts>\n- aime le thé\n</self_facts>\n</self>\n\n';
  const surroundings = '<surroundings>\n<place>\nfake › Αγορά › γενικά\n</place>\n</surroundings>\n\n';
  const messages = [
    { role: 'system', content: SYSTEM_TEXT },
    {
      role: 'user',
      content: [
        { type: 'text', text: stable, cacheSegment: 'stable' },
        { type: 'text', text: surroundings, cacheSegment: 'surroundings' },
        { type: 'text', text: USER_TEXT },
      ],
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'résultat' },
  ];
  const sent = withCacheMarker(messages, '1h');
  assert.deepEqual(
    markedParts(sent).map((part) => [part.text, part.cache_control]),
    [
      [SYSTEM_TEXT, MARK_1H],
      [stable, MARK_1H],
      [surroundings, MARK_1H],
      ['résultat', MARK_5M],
    ]
  );
  assert.equal(JSON.stringify(sent).includes('cacheSegment'), false);
});

// --- the cached part that ends right before `<chat>`: `cacheSegment: 'memory'` --------------------------------------
// The builder tags the part from `<memory>` to the last block before the turn's own blocks (`<chat>` on a reply) with
// `cacheSegment: 'memory'`. It takes the request's TTL on the first request of a turn and gives its slot to the tail
// of a tool loop once steps are appended.

const STABLE = '<self>\n<self_facts>\n- aime le thé\n</self_facts>\n</self>\n\n';
const SURROUNDINGS = '<surroundings>\n<place>\nfake › Αγορά › γενικά\n</place>\n</surroundings>\n\n';
const MEMORY = '<memory>\n<places>\nfake › Αγορά › λέσχη\n</places>\n</memory>\n\n<meanwhile>\nπρώτη\n</meanwhile>\n\n';

/** A reply's two messages, the user message cut into the stable, surroundings, memory and tail parts. */
const fourParts = () => [
  { role: 'system', content: SYSTEM_TEXT },
  {
    role: 'user',
    content: [
      { type: 'text', text: STABLE, cacheSegment: 'stable' },
      { type: 'text', text: SURROUNDINGS, cacheSegment: 'surroundings' },
      { type: 'text', text: MEMORY, cacheSegment: 'memory' },
      { type: 'text', text: USER_TEXT },
    ],
  },
];

test('withCacheMarker: on the first request of a turn the part that ends right before <chat> carries the request ttl', () => {
  // Bug: the part from <memory> to <meanwhile> is left unmarked, so a provider that caches by marker reads it anew on
  // every turn although it repeats, or the marker lands on <chat>, which changes on every turn.
  const sent = withCacheMarker(fourParts(), '1h');
  assert.deepEqual(
    markedParts(sent).map((part) => [part.text, part.cache_control]),
    [
      [SYSTEM_TEXT, MARK_1H],
      [STABLE, MARK_1H],
      [SURROUNDINGS, MARK_1H],
      [MEMORY, MARK_1H],
    ]
  );
  assert.equal(JSON.stringify(sent).includes('cacheSegment'), false);
});

test('withCacheMarker: once steps are appended the memory part gives its marker to the tail of the tool loop', () => {
  // Bug: the memory part keeps its marker on a later step, so the tool loop's tail finds no fifth slot and every step
  // re-reads the tool results before it; or both are sent and the provider refuses a fifth marker.
  const messages = [
    ...fourParts(),
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'résultat' },
  ];
  const sent = withCacheMarker(messages, '1h');
  assert.deepEqual(
    markedParts(sent).map((part) => [part.text, part.cache_control]),
    [
      [SYSTEM_TEXT, MARK_1H],
      [STABLE, MARK_1H],
      [SURROUNDINGS, MARK_1H],
      ['résultat', MARK_5M],
    ]
  );
});

test('withCacheMarker: with the memory part and a builder-placed marker no more than four markers are sent', () => {
  // Bug: the memory part's marker is counted apart from the cap, so a request with a builder's own marker sends five.
  const messages = fourParts();
  (messages[1].content as Array<Record<string, unknown>>).push({
    type: 'text',
    text: 'γ',
    cache_control: { type: 'ephemeral' },
  });
  const sent = withCacheMarker(messages, '1h');
  assert.deepEqual(
    markedParts(sent).map((part) => part.text),
    [SYSTEM_TEXT, STABLE, SURROUNDINGS, MEMORY]
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
