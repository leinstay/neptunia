// What memory changes inside the reply's cached stable part is held per cache
// TTL bucket (src/behavior/prompt.ts#freezePerBucket): `<self_facts>` and
// `<gifs>` stay byte-identical within one bucket and move at the next edge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freezePerBucket } from '../src/behavior/prompt.ts';
import { cacheTtlMs } from '../src/llm/openrouter.ts';
import { labels } from './fixtures/labels.ts';
import { frameOfInput } from './fixtures/prompt-rig.ts';
import { buildRequest, type Built } from './fixtures/built-request.ts';

const HOUR = 3_600_000;
const MINUTE = 60_000;
// An hour edge: the bucket of a one-hour TTL starts here.
const EDGE = Date.UTC(2026, 8, 20, 10, 0, 0);

function fakeConfig(overrides: { features?: object; cache?: object } = {}) {
  return {
    bot: { timezone: 'UTC' },
    context: {
      gapMarkerMinutes: 20,
      maxMessageChars: 800,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500 },
      vision: { maxImages: 0, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
      customEmoji: { max: 30 },
    },
    features: { ...overrides.features },
    gifs: { max: 20, halfLifeDays: 30, ownMarkHours: 24 },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9, cache: { ttl: '1h', ...overrides.cache } },
    lore: { scanMessages: 30 },
    memory: {},
  };
}

function baseInput(overrides: Record<string, unknown> & { now?: number } = {}) {
  const now = overrides.now ?? EDGE + 10 * MINUTE;
  const input = {
    config: fakeConfig(),
    prompts: {
      'system-prompt': 'SYSTEM',
      'character-card': 'CARD',
      rules: 'RULES',
      format: 'FORMAT',
      reply: 'REPLY_TASK',
      labels,
    },
    calibrator: { ratio: 1, apply: (n: number) => n },
    mode: 'reply',
    now,
    selfName: 'Nept',
    history: [
      {
        id: '1',
        ts: now - 60_000,
        authorId: 'a',
        authorName: 'Zoé',
        self: false,
        content: 'γεια',
        attachments: [],
        stickers: [],
        replyToId: null,
      },
    ],
    neighbors: [],
    trigger: null,
    triggerKind: null,
    placeMemory: {},
    interlocutor: null,
    otherProfiles: [],
    ...overrides,
  };
  // Every request is built on its turn frame (slice 7).
  return { ...input, frame: frameOfInput(input) };
}

function stableText(request: Built) {
  const part = request.messages[1].content.find((entry) => entry.cacheSegment === 'stable');
  assert.ok(part, 'the request has a stable part');
  return part.text;
}

test('cacheTtlMs: an hour for 1h and anything unknown, five minutes for 5m', () => {
  assert.equal(cacheTtlMs({ llm: { cache: { ttl: '1h' } } }), HOUR);
  assert.equal(cacheTtlMs({ llm: { cache: { ttl: '5m' } } }), 5 * MINUTE);
  assert.equal(cacheTtlMs({}), HOUR);
});

test('freezePerBucket: one value per bucket and signature; no map computes every time', () => {
  const freeze = new Map();
  let calls = 0;
  const compute = () => {
    calls += 1;
    return [`v${calls}`];
  };
  const at = (now: number, signature?: string) =>
    freezePerBucket(freeze, 'k', { now, bucketMs: HOUR, signature }, compute);
  assert.deepEqual(at(EDGE + MINUTE), ['v1']);
  assert.deepEqual(at(EDGE + 59 * MINUTE), ['v1']);
  assert.deepEqual(at(EDGE + 59 * MINUTE, 'other'), ['v2'], 'a new signature computes again');
  assert.deepEqual(at(EDGE + HOUR, 'other'), ['v3'], 'the next bucket computes again');
  const held = at(EDGE + HOUR + MINUTE, 'other');
  held.push('changed');
  assert.deepEqual(at(EDGE + HOUR + 2 * MINUTE, 'other'), ['v3'], 'a caller never changes what is held');
  assert.deepEqual(freezePerBucket(null, 'k', { now: EDGE, bucketMs: HOUR }, compute), ['v4']);
});

test('buildRequest: a memory batch inside one bucket leaves the stable part byte-identical; the next bucket shows the new self fact', () => {
  const stableFreeze = new Map();
  const before = buildRequest(baseInput({ stableFreeze, placeMemory: { self: ['likes tea'] } }));
  const batch = { self: ['likes tea', 'hates mornings'] };
  const sameBucket = buildRequest(baseInput({ stableFreeze, placeMemory: batch, now: EDGE + 50 * MINUTE }));
  assert.equal(stableText(sameBucket), stableText(before));
  assert.ok(!stableText(sameBucket).includes('hates mornings'));

  const nextBucket = buildRequest(baseInput({ stableFreeze, placeMemory: batch, now: EDGE + HOUR + MINUTE }));
  assert.notEqual(stableText(nextBucket), stableText(before));
  assert.ok(stableText(nextBucket).includes('- hates mornings'));
});

// PR 7d: the prompt cache is code, so a request without a holder is the case that follows memory at once.
test('buildRequest: the self facts follow memory at once without a holder', () => {
  const batch = { self: ['likes tea', 'hates mornings'] };
  assert.ok(stableText(buildRequest(baseInput({ placeMemory: batch }))).includes('- hates mornings'));
});
test('buildRequest: with llm.cache.ttl 5m the bucket is five minutes', () => {
  const config = fakeConfig({ cache: { ttl: '5m' } });
  const stableFreeze = new Map();
  const start = EDGE + MINUTE;
  buildRequest(baseInput({ config, stableFreeze, placeMemory: { self: ['likes tea'] }, now: start }));
  const batch = { self: ['likes tea', 'hates mornings'] };
  assert.ok(
    !stableText(
      buildRequest(baseInput({ config, stableFreeze, placeMemory: batch, now: start + 3 * MINUTE }))
    ).includes('hates mornings')
  );
  assert.ok(
    stableText(buildRequest(baseInput({ config, stableFreeze, placeMemory: batch, now: start + 5 * MINUTE }))).includes(
      'hates mornings'
    )
  );
});

// B7: the GIF list left the request, so the test of its order inside one bucket went with it.
