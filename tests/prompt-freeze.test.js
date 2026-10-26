// What memory changes inside the reply's cached stable part is held per cache
// TTL bucket (src/behavior/prompt.js#freezePerBucket): `<self_facts>` and
// `<gifs>` stay byte-identical within one bucket and move at the next edge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, freezePerBucket } from '../src/behavior/prompt.js';
import { cacheTtlMs } from '../src/llm/openrouter.js';
import { labels } from './fixtures/labels.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;
// An hour edge: the bucket of a one-hour TTL starts here.
const EDGE = Date.UTC(2026, 8, 20, 10, 0, 0);

function fakeConfig(overrides = {}) {
  return {
    bot: { timezone: 'UTC' },
    context: {
      gapMarkerMinutes: 20,
      maxMessageChars: 800,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500 },
      vision: { maxImages: 0, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
      customEmoji: { max: 30 },
    },
    features: { vision: false, promptCache: true, ...overrides.features },
    gifs: { max: 20, halfLifeDays: 30, ownMarkHours: 24 },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9, cache: { ttl: '1h', ...overrides.cache } },
    lore: { scanMessages: 30 },
    memory: {},
  };
}

function baseInput(overrides = {}) {
  const now = overrides.now ?? EDGE + 10 * MINUTE;
  return {
    config: fakeConfig(),
    prompts: {
      'system-prompt': 'SYSTEM',
      'character-card': 'CARD',
      rules: 'RULES',
      format: 'FORMAT',
      reply: 'REPLY_TASK',
      labels,
    },
    calibrator: { ratio: 1, apply: (n) => n },
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
    guildMemory: {},
    interlocutor: null,
    otherProfiles: [],
    ...overrides,
  };
}

function stableText(request) {
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
  const at = (now, signature) => freezePerBucket(freeze, 'k', { now, bucketMs: HOUR, signature }, compute);
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
  const before = buildRequest(baseInput({ stableFreeze, guildMemory: { self: ['likes tea'] } }));
  const batch = { self: ['likes tea', 'hates mornings'] };
  const sameBucket = buildRequest(baseInput({ stableFreeze, guildMemory: batch, now: EDGE + 50 * MINUTE }));
  assert.equal(stableText(sameBucket), stableText(before));
  assert.ok(!stableText(sameBucket).includes('hates mornings'));

  const nextBucket = buildRequest(baseInput({ stableFreeze, guildMemory: batch, now: EDGE + HOUR + MINUTE }));
  assert.notEqual(stableText(nextBucket), stableText(before));
  assert.ok(stableText(nextBucket).includes('- hates mornings'));
});

test('buildRequest: the self facts follow memory at once with the prompt cache off or without a holder', () => {
  const batch = { self: ['likes tea', 'hates mornings'] };
  const off = fakeConfig({ features: { promptCache: false } });
  const stableFreeze = new Map();
  buildRequest(baseInput({ config: off, stableFreeze, guildMemory: { self: ['likes tea'] } }));
  assert.ok(
    stableText(buildRequest(baseInput({ config: off, stableFreeze, guildMemory: batch }))).includes('- hates mornings')
  );
  assert.ok(stableText(buildRequest(baseInput({ guildMemory: batch }))).includes('- hates mornings'));
});

test('buildRequest: with llm.cache.ttl 5m the bucket is five minutes', () => {
  const config = fakeConfig({ cache: { ttl: '5m' } });
  const stableFreeze = new Map();
  const start = EDGE + MINUTE;
  buildRequest(baseInput({ config, stableFreeze, guildMemory: { self: ['likes tea'] }, now: start }));
  const batch = { self: ['likes tea', 'hates mornings'] };
  assert.ok(
    !stableText(
      buildRequest(baseInput({ config, stableFreeze, guildMemory: batch, now: start + 3 * MINUTE }))
    ).includes('hates mornings')
  );
  assert.ok(
    stableText(buildRequest(baseInput({ config, stableFreeze, guildMemory: batch, now: start + 5 * MINUTE }))).includes(
      'hates mornings'
    )
  );
});

/** A library of link GIFs `g<n>` keyed `k<n>`, each `[n, count, ownLast?]`. */
function library(rows) {
  const entries = {};
  for (const [n, count, ownLast] of rows) {
    entries[`k${n}`] = {
      id: `g${n}`,
      kind: 'link',
      url: `https://tenor.com/view/gif-${n}`,
      itemId: `k${n}`,
      messageId: `m${n}`,
      channelId: 'c1',
      count,
      last: EDGE - 24 * HOUR,
      firstSeen: EDGE - 24 * HOUR,
      ...(ownLast ? { ownLast, ownUses: 1 } : {}),
    };
  }
  return { nextId: 100, entries, backfill: null };
}

test('buildRequest: an own GIF post and a reranking use inside one bucket leave the stable part byte-identical; the next bucket shows the new order', () => {
  const stableFreeze = new Map();
  const before = buildRequest(
    baseInput({
      stableFreeze,
      gifs: library([
        [1, 9],
        [2, 5],
        [3, 2],
      ]),
    })
  );
  assert.ok(stableText(before).includes('g1\ng2\ng3'), stableText(before));
  // The persona posts g3 and members use it enough to lead the ranking.
  const posted = EDGE + 30 * MINUTE;
  const after = library([
    [1, 9],
    [2, 5],
    [3, 20, posted],
  ]);
  const sameBucket = buildRequest(baseInput({ stableFreeze, gifs: after, now: posted + MINUTE }));
  assert.equal(stableText(sameBucket), stableText(before));
  // The post is said in the tail at once.
  const tail = sameBucket.messages[1].content.at(-1);
  assert.equal(tail.cacheSegment, undefined);
  assert.ok(tail.text.includes('<gifs_recent>\ng3 (you, '), tail.text);

  const nextBucket = buildRequest(baseInput({ stableFreeze, gifs: after, now: EDGE + HOUR + MINUTE }));
  assert.ok(stableText(nextBucket).includes('g3\ng1\ng2'), stableText(nextBucket));
  assert.ok(!stableText(nextBucket).includes('(you'));
});
