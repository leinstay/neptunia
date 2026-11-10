// Custom emoji usage ranking (src/memory/emoji-usage.ts), its storage in
// guild.json (src/memory/store.ts, a memory unit in the database) and the live
// observer that feeds it (src/memory/update.ts).

import { placeOfRoot } from '../src/memory/addresses.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  EMOJI_STORE_MAX,
  countEmojiUses,
  mergeEmojiUsage,
  normalizeEmojiUsage,
  rankEmojiUsage,
} from '../src/memory/emoji-usage.ts';
import { placeCollection } from '../src/memory/db/unit-keys.ts';
import { createStore } from '../src/memory/store.ts';
import { createMemoryUpdater } from '../src/memory/update.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import type { Untyped } from '../src/tools/types.ts';
import { writeUnitUpdate } from './fixtures/memory-db/unit-writes.ts';

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

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

/** `fn(store, memoryDb)` over a store on a fresh memory database, closed and removed after. */
async function withStore(fn: Untyped) {
  const mem = await openTestMemory();
  try {
    return await fn(createStore({ dataDir: mem.dataDir, memoryDb: mem.memoryDb }), mem.memoryDb, mem.dataDir);
  } finally {
    await mem.close();
    fs.rmSync(mem.dataDir, { recursive: true, force: true });
  }
}

// --- pure ranking ------------------------------------------------------------

test('countEmojiUses: one use per emoji per message, members only', () => {
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
  assert.deepEqual(uses.get('10'), { name: 'kappa_new', count: 2, last: T0 + 1000 });
  assert.deepEqual(uses.get('20'), { name: 'omega', count: 1, last: T0 });
  assert.equal(uses.size, 2);
});

test("countEmojiUses: forwarded snapshots are not the member's own use", () => {
  const uses = countEmojiUses([msg({ forwarded: [{ content: '', emojis: [{ id: '30', name: 'sigma' }] }] })]);
  assert.equal(uses.size, 0);
});

test('mergeEmojiUsage: counts accumulate over batches and last follows the latest use', () => {
  const first = mergeEmojiUsage(undefined, [msg({ ts: T0, emojis: [{ id: '10', name: 'kappa' }] })]);
  assert.equal(first.counted, 1);
  const second = mergeEmojiUsage(first.usage, [
    msg({ ts: T0 + DAY, emojis: [{ id: '10', name: 'kappa' }] }),
    msg({ ts: T0 + 2 * DAY, emojis: [{ id: '10', name: 'kappa' }] }),
  ]);
  assert.equal(second.counted, 2);
  assert.deepEqual(second.usage, { 10: { name: 'kappa', count: 3, last: T0 + 2 * DAY } });
  assert.deepEqual(first.usage, { 10: { name: 'kappa', count: 1, last: T0 } }, 'never mutates its input');
});

test('mergeEmojiUsage: an older batch never moves last or the name backwards', () => {
  const { usage } = mergeEmojiUsage({ 10: { name: 'kappa_now', count: 2, last: T0 + DAY } }, [
    msg({ ts: T0, emojis: [{ id: '10', name: 'kappa_old' }] }),
  ]);
  assert.deepEqual(usage['10'], { name: 'kappa_now', count: 3, last: T0 + DAY });
});

test('rankEmojiUsage: recency decay lets a fresh emoji outrank an old heavier one', () => {
  const usage = {
    1: { name: 'old', count: 8, last: T0 },
    2: { name: 'fresh', count: 2, last: T0 + 60 * DAY },
  };
  assert.deepEqual(
    rankEmojiUsage(usage, 30).map((e) => e.name),
    ['fresh', 'old']
  );
  // Without decay the count alone decides.
  assert.deepEqual(
    rankEmojiUsage(usage, 0).map((e) => e.name),
    ['old', 'fresh']
  );
});

test('mergeEmojiUsage: past storeMax the lowest-ranked entries are evicted', () => {
  const usage = {
    1: { name: 'alpha', count: 5, last: T0 },
    2: { name: 'beta', count: 1, last: T0 },
    3: { name: 'gamma', count: 3, last: T0 },
  };
  const { usage: next } = mergeEmojiUsage(usage, [msg({ ts: T0, emojis: [{ id: '4', name: 'delta' }] })], {
    storeMax: 3,
    halfLifeDays: 30,
  });
  assert.deepEqual(Object.keys(next).sort(), ['1', '3', '4']);
});

test('normalizeEmojiUsage: a missing or broken field reads as empty, bad entries are dropped', () => {
  assert.deepEqual(normalizeEmojiUsage(undefined), {});
  assert.deepEqual(normalizeEmojiUsage('x'), {});
  assert.deepEqual(
    normalizeEmojiUsage({
      1: { name: 'ok', count: 2, last: 5 },
      2: { name: 'zero', count: 0 },
      3: null,
      4: { count: 1 },
    }),
    { 1: { name: 'ok', count: 2, last: 5 }, 4: { name: '', count: 1, last: 0 } }
  );
});

// --- storage -----------------------------------------------------------------

test('store.getPlace: emojiUsage is normalised on read, missing -> {}', async () => {
  await withStore(async (store: Untyped, memoryDb: Untyped) => {
    assert.deepEqual(store.getPlace(placeOfRoot(store, 'g1')).emojiUsage, {});
    // The notes are written under the place the store names the root by: a unit names its place, never a path.
    await writeUnitUpdate(memoryDb as { memoryWrite: (update: unknown) => Promise<unknown> }, {
      op: 'value',
      key: placeCollection('place', placeOfRoot(store, 'g2')),
      value: { patterns: 'p', emojiUsage: { 7: { name: 'ή', count: 4, last: 9 }, 8: 'junk' } },
    });
    assert.deepEqual(store.getPlace(placeOfRoot(store, 'g2')).emojiUsage, { 7: { name: 'ή', count: 4, last: 9 } });
    assert.equal(store.getPlace(placeOfRoot(store, 'g2')).patterns, 'p');
  });
});

test('store.recordEmojiUsage: persists counts; updatePlace never overwrites them', async () => {
  await withStore(async (store: Untyped, memoryDb: Untyped, dataDir: Untyped) => {
    const counted = store.recordEmojiUsage(
      placeOfRoot(store, 'g1'),
      [msg({ ts: T0, emojis: [{ id: '10', name: 'kappa' }] })],
      {
        storeMax: 200,
      }
    );
    assert.equal(counted, 1);
    store.updatePlace(placeOfRoot(store, 'g1'), { patterns: 'friendly', emojiUsage: {} });
    store.flush();
    await store.flushSettled({});
    const stored = createStore({ dataDir, memoryDb }).getPlace(placeOfRoot(store, 'g1'));
    assert.deepEqual(loose(stored).emojiUsage, { 10: { name: 'kappa', count: 1, last: T0 } });
    assert.equal(loose(stored).patterns, 'friendly');
  });
});

// --- the live observer --------------------------------------------------------

function hotFor() {
  return { config: { bot: { timezone: 'UTC' } } };
}

test("observe: a member's message adds its emoji to root.emojiUsage; her own adds nothing", async () => {
  await withStore(async (store: Untyped) => {
    const updater = createMemoryUpdater({ hot: hotFor(), store });
    updater.observe(placeOfRoot(store, 'g1'), msg({ id: 'a', ts: T0, emojis: [{ id: '10', name: 'kappa' }] }));
    updater.observe(
      placeOfRoot(store, 'g1'),
      msg({ id: 'b', ts: T0 + 1, self: true, emojis: [{ id: '10', name: 'kappa' }] })
    );
    updater.observe(
      placeOfRoot(store, 'g1'),
      msg({
        id: 'c',
        ts: T0 + 2,
        emojis: [
          { id: '10', name: 'kappa' },
          { id: '20', name: 'omega' },
        ],
      })
    );
    assert.deepEqual(store.getPlace(placeOfRoot(store, 'g1')).emojiUsage, {
      10: { name: 'kappa', count: 2, last: T0 + 2 },
      20: { name: 'omega', count: 1, last: T0 + 2 },
    });
  });
});

// PR 7d: `context.customEmoji.storeMax` is the constant EMOJI_STORE_MAX, so one emoji more than it is observed.
test('observe: context.customEmoji.storeMax caps the stored entries', async () => {
  await withStore(async (store: Untyped) => {
    const updater = createMemoryUpdater({ hot: hotFor(), store });
    updater.observe(placeOfRoot(store, 'g1'), msg({ id: 'a', ts: T0, emojis: [{ id: '0', name: 'alpha' }] }));
    for (let n = 1; n <= EMOJI_STORE_MAX; n += 1)
      updater.observe(
        placeOfRoot(store, 'g1'),
        msg({ id: `m${n}`, ts: T0 + DAY + n, emojis: [{ id: String(n), name: `e${n}` }] })
      );
    const kept = Object.keys(store.getPlace(placeOfRoot(store, 'g1')).emojiUsage);
    assert.deepEqual([kept.length, kept.includes('0')], [EMOJI_STORE_MAX, false]);
  });
});
