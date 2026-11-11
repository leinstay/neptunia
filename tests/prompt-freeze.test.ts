// What memory changes inside the reply's cached stable part is held per cache
// TTL bucket (src/behavior/prompt.ts#freezePerBucket): `<self_facts>` and
// `<gifs>` stay byte-identical within one bucket and move at the next edge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freezePerBucket } from '../src/behavior/prompt.ts';
import { cacheTtlMs } from '../src/llm/openrouter.ts';
import { labels } from './fixtures/labels.ts';
import { frameOfInput } from './fixtures/prompt-rig.ts';
import { frameInput } from './fixtures/frame-input.ts';
import { frameOf } from '../src/turn/request/frame.ts';
import type { Frame } from '../src/turn/request/frame.ts';
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

// --- `<surroundings>`, held per bucket by place and version, opens the cached `memory` part (2026-11-11) -------------

const ROOT_LINK = { id: 'place:root', kind: 'server', name: 'Αγορά' };
const ROOM = frameOf(frameInput({ chain: [{ id: 'place:room', kind: 'channel', name: 'γενικά' }, ROOT_LINK] }));
const GARDEN = frameOf(frameInput({ chain: [{ id: 'place:garden', kind: 'channel', name: 'κήπος' }, ROOT_LINK] }));

/** A reply in `frame` whose place has `purpose` under the description versions `versions`. */
function placed(
  frame: Frame,
  {
    purpose,
    versions,
    now,
    self = ['likes tea'],
  }: { purpose: string; versions: Array<string>; now: number; self?: Array<string> },
  stableFreeze: Map<string, unknown>
) {
  return {
    ...baseInput({ now, stableFreeze, placeMemory: { self } }),
    surroundings: { interfaceText: 'IFACE_TEXT', root: null, place: { purpose }, versions },
    frame,
  };
}

/** The text of the part of `request` cached under `segment`. */
function segmentText(request: Built, segment: string): string {
  const [, user] = request.messages;
  const part = user.content.find((entry) => entry.cacheSegment === segment);
  assert.ok(part, `the request has a ${segment} part`);
  return part.text;
}

/** `<surroundings>` as it opens the cached `memory` part of `request` (the owner's decision of 2026-11-11). */
function surroundingsText(request: Built): string {
  const text = segmentText(request, 'memory');
  assert.ok(text.startsWith('<surroundings>\n'), text);
  return text.slice(0, text.indexOf('</surroundings>'));
}

test('buildRequest: two requests of one place within a bucket have byte-identical stable parts and <surroundings>', () => {
  // Bug: a memory batch or a field edit under the same description version rewrites the cached prefix mid-bucket.
  const stableFreeze = new Map<string, unknown>();
  const first = buildRequest(
    placed(ROOM, { purpose: 'μιλάμε για τσάι', versions: ['ver:1'], now: EDGE + 10 * MINUTE }, stableFreeze)
  );
  const second = buildRequest(
    placed(
      ROOM,
      {
        purpose: 'μιλάμε για καφέ',
        versions: ['ver:1'],
        now: EDGE + 50 * MINUTE,
        self: ['likes tea', 'hates mornings'],
      },
      stableFreeze
    )
  );
  assert.equal(segmentText(second, 'stable'), segmentText(first, 'stable'));
  assert.equal(surroundingsText(second), surroundingsText(first));
  assert.ok(surroundingsText(first).includes('μιλάμε για τσάι'));
});

test('buildRequest: a new description version of the place changes <surroundings> within the bucket', () => {
  // Bug: the freeze keyed by place alone keeps a stale description for up to an hour after the memory rewrote it.
  const stableFreeze = new Map<string, unknown>();
  buildRequest(
    placed(ROOM, { purpose: 'μιλάμε για τσάι', versions: ['ver:1'], now: EDGE + 10 * MINUTE }, stableFreeze)
  );
  const renewed = buildRequest(
    placed(ROOM, { purpose: 'μιλάμε για καφέ', versions: ['ver:2'], now: EDGE + 20 * MINUTE }, stableFreeze)
  );
  assert.ok(surroundingsText(renewed).includes('μιλάμε για καφέ'));
});

test('buildRequest: a request of another place differs from the first only in <surroundings> of the cached prefix', () => {
  // Bug: a place fact inside the stable part breaks the cache of `<self>` at every change of room.
  const stableFreeze = new Map<string, unknown>();
  const room = buildRequest(
    placed(ROOM, { purpose: 'μιλάμε για τσάι', versions: ['ver:1'], now: EDGE + 10 * MINUTE }, stableFreeze)
  );
  const garden = buildRequest(
    placed(GARDEN, { purpose: 'φυτεύουμε ντομάτες', versions: ['ver:9'], now: EDGE + 11 * MINUTE }, stableFreeze)
  );
  const [roomSystem] = room.messages;
  const [gardenSystem] = garden.messages;
  assert.equal(gardenSystem.content, roomSystem.content);
  assert.equal(segmentText(garden, 'stable'), segmentText(room, 'stable'));
  assert.notEqual(surroundingsText(garden), surroundingsText(room));
});
