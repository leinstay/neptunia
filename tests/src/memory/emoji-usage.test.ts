// Tests for src/memory/emoji-usage.ts: the custom emoji usage ranking. Pure counting, merging, ranking with recency
// decay, eviction past the cap and the normalisation of a stored ranking, over synthetic messages.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  countEmojiUses,
  mergeEmojiUsage,
  normalizeEmojiUsage,
  rankEmojiUsage,
} from '../../../src/memory/emoji-usage.ts';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);

function msg(overrides = {}) {
  return {
    id: 'm1',
    placeId: 'c1',
    channelName: 'general',
    authorId: '1',
    authorName: 'Zoé',
    self: false,
    bot: false,
    content: 'hi',
    ts: T0,
    replyToId: null,
    attachments: [],
    links: [],
    stickers: [],
    emojis: [],
    ...overrides,
  };
}

// A bot is a person to the persona, so a bot's emoji count like a member's.
// An emoji and a sticker go by a stable name of the engine.
test("countEmojiUses: one use per emoji per message, the persona's own left out", () => {
  const uses = countEmojiUses([
    msg({
      ts: T0,
      emojis: [
        { id: '10', name: 'kappa' },
        { id: '10', name: 'kappa' },
        { id: '20', name: 'omega' },
      ],
    }),
    msg({ ts: T0 + 1000, emojis: [{ id: '10', name: 'kappa_new' }] }),
    msg({ self: true, ts: T0 + 2000, emojis: [{ id: '10', name: 'kappa' }] }),
    msg({ bot: true, ts: T0 + 3000, emojis: [{ id: '20', name: 'omega' }] }),
    msg({ emojis: undefined }),
  ]);
  assert.deepEqual(uses.get('10'), { count: 2, last: T0 + 1000 });
  assert.deepEqual(uses.get('20'), { count: 2, last: T0 + 3000 });
  assert.equal(uses.size, 2);
});

test("countEmojiUses: forwarded snapshots are not the member's own use", () => {
  const uses = countEmojiUses([msg({ forwarded: [{ content: '', emojis: [{ id: '30', name: 'sigma' }] }] })]);
  assert.equal(uses.size, 0);
});

// An emoji and a sticker go by a stable name of the engine.
test('mergeEmojiUsage: counts accumulate over batches and last follows the latest use', () => {
  const first = mergeEmojiUsage(undefined, [msg({ ts: T0, emojis: [{ id: '10', name: 'kappa' }] })]);
  assert.equal(first.counted, 1);
  const second = mergeEmojiUsage(first.usage, [
    msg({ ts: T0 + DAY, emojis: [{ id: '10', name: 'kappa' }] }),
    msg({ ts: T0 + 2 * DAY, emojis: [{ id: '10', name: 'kappa' }] }),
  ]);
  assert.equal(second.counted, 2);
  assert.deepEqual(second.usage, { 10: { count: 3, last: T0 + 2 * DAY } });
  assert.deepEqual(first.usage, { 10: { count: 1, last: T0 } }, 'never mutates its input');
});

// An emoji and a sticker go by a stable name of the engine.
test('mergeEmojiUsage: an older batch never moves last backwards', () => {
  const { usage } = mergeEmojiUsage({ 10: { count: 2, last: T0 + DAY } }, [
    msg({ ts: T0, emojis: [{ id: '10', name: 'kappa_old' }] }),
  ]);
  assert.deepEqual(usage['10'], { count: 3, last: T0 + DAY });
});

// An emoji and a sticker go by a stable name of the engine.
test('rankEmojiUsage: recency decay lets a fresh emoji outrank an old heavier one', () => {
  const usage = {
    1: { count: 8, last: T0 },
    2: { count: 2, last: T0 + 60 * DAY },
  };
  assert.deepEqual(
    rankEmojiUsage(usage, 30).map((e) => e.id),
    ['2', '1']
  );
  // Without decay the count alone decides.
  assert.deepEqual(
    rankEmojiUsage(usage, 0).map((e) => e.id),
    ['1', '2']
  );
});

// An emoji and a sticker go by a stable name of the engine.
test('mergeEmojiUsage: past storeMax the lowest-ranked entries are evicted', () => {
  const usage = {
    1: { count: 5, last: T0 },
    2: { count: 1, last: T0 },
    3: { count: 3, last: T0 },
  };
  const { usage: next } = mergeEmojiUsage(usage, [msg({ ts: T0, emojis: [{ id: '4', name: 'delta' }] })], {
    storeMax: 3,
    halfLifeDays: 30,
  });
  assert.deepEqual(Object.keys(next).sort(), ['1', '3', '4']);
});

// An emoji and a sticker go by a stable name of the engine.
test('normalizeEmojiUsage: a missing or broken field reads as empty, bad entries are dropped', () => {
  assert.deepEqual(normalizeEmojiUsage(undefined), {});
  assert.deepEqual(normalizeEmojiUsage('x'), {});
  assert.deepEqual(
    normalizeEmojiUsage({
      1: { count: 2, last: 5 },
      2: { count: 0 },
      3: null,
      4: { count: 1 },
    }),
    { 1: { count: 2, last: 5 }, 4: { count: 1, last: 0 } }
  );
});
