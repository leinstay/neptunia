// Custom emoji usage ranking (src/memory/emoji-usage.js), its storage in
// guild.json (src/memory/store.js) and the analyzer run that feeds it
// (src/memory/update.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { countEmojiUses, mergeEmojiUsage, normalizeEmojiUsage, rankEmojiUsage } from '../src/memory/emoji-usage.js';
import { createStore } from '../src/memory/store.js';
import { createMemoryUpdater } from '../src/memory/update.js';
import { createCalibrator } from '../src/llm/tokens.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { tempDir } from './fixtures/tmp.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);

function msg(overrides = {}) {
  return {
    id: 'm1',
    channelId: 'c1',
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

function withStore(fn) {
  const dir = tempDir('nep-');
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    result = fn(createStore({ dataDir: dir }), dir);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result && typeof result.then === 'function') return result.finally(cleanup);
  cleanup();
  return result;
}

// --- pure ranking ------------------------------------------------------------

test('countEmojiUses: one use per emoji per message, members only', () => {
  const uses = countEmojiUses([
    msg({ ts: T0, emojis: [{ id: '10', name: 'kappa' }, { id: '10', name: 'kappa' }, { id: '20', name: 'omega' }] }),
    msg({ ts: T0 + 1000, emojis: [{ id: '10', name: 'kappa_new' }] }),
    msg({ self: true, ts: T0 + 2000, emojis: [{ id: '10', name: 'kappa' }] }),
    msg({ bot: true, ts: T0 + 3000, emojis: [{ id: '20', name: 'omega' }] }),
    msg({ emojis: undefined }),
  ]);
  assert.deepEqual(uses.get('10'), { name: 'kappa_new', count: 2, last: T0 + 1000 });
  assert.deepEqual(uses.get('20'), { name: 'omega', count: 1, last: T0 });
  assert.equal(uses.size, 2);
});

test('countEmojiUses: forwarded snapshots are not the member\'s own use', () => {
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
  assert.deepEqual(rankEmojiUsage(usage, 30).map((e) => e.name), ['fresh', 'old']);
  // Without decay the count alone decides.
  assert.deepEqual(rankEmojiUsage(usage, 0).map((e) => e.name), ['old', 'fresh']);
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
    normalizeEmojiUsage({ 1: { name: 'ok', count: 2, last: 5 }, 2: { name: 'zero', count: 0 }, 3: null, 4: { count: 1 } }),
    { 1: { name: 'ok', count: 2, last: 5 }, 4: { name: '', count: 1, last: 0 } },
  );
});

// --- storage -----------------------------------------------------------------

test('store.getGuild: emojiUsage is normalised on read, missing -> {}', () => {
  withStore((store, dir) => {
    assert.deepEqual(store.getGuild('g1').emojiUsage, {});
    fs.mkdirSync(path.join(dir, 'guilds', 'g2'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'guilds', 'g2', 'guild.json'),
      JSON.stringify({ patterns: 'p', emojiUsage: { 7: { name: 'ή', count: 4, last: 9 }, 8: 'junk' } }),
    );
    assert.deepEqual(store.getGuild('g2').emojiUsage, { 7: { name: 'ή', count: 4, last: 9 } });
    assert.equal(store.getGuild('g2').patterns, 'p');
  });
});

test('store.recordEmojiUsage: persists counts; updateGuild never overwrites them', () => {
  withStore((store, dir) => {
    const counted = store.recordEmojiUsage('g1', [msg({ ts: T0, emojis: [{ id: '10', name: 'kappa' }] })], { storeMax: 200 });
    assert.equal(counted, 1);
    store.updateGuild('g1', { patterns: 'friendly', emojiUsage: {} });
    store.flush();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'guilds', 'g1', 'guild.json'), 'utf8'));
    assert.deepEqual(onDisk.emojiUsage, { 10: { name: 'kappa', count: 1, last: T0 } });
    assert.equal(onDisk.patterns, 'friendly');
  });
});

test('store: a buffered message keeps its custom emoji ids and names across a restart', () => {
  withStore((store, dir) => {
    store.pushBuffer('g1', msg({ emojis: [{ id: '10', name: 'kappa' }] }), 100);
    store.flush();
    const reopened = createStore({ dataDir: dir });
    assert.deepEqual(reopened.getBuffer('g1')[0].emojis, [{ id: '10', name: 'kappa' }]);
  });
});

// --- the analyzer run --------------------------------------------------------

function hotFor(context) {
  return {
    config: {
      bot: { timezone: 'UTC' },
      context: { gapMarkerMinutes: 20, maxMessageChars: 800, ...context },
      llm: { model: 'x/y', maxOutputTokens: 700, maxRequestTokens: 50000, safetyMargin: 0.9, timeoutMs: 1000 },
      memory: { model: null, batchMessages: 4, minBatchMessages: 1, maxBatchAgeMinutes: 180, maxOutputTokens: 4000, fieldChars: 400 },
    },
    prompts: { memory: 'memory system prompt', labels },
  };
}

test('memory run: a consumed batch adds its members\' emoji to guild.emojiUsage', async () => {
  await withStore(async (store) => {
    store.pushBuffer('g1', msg({ id: 'a', ts: T0, emojis: [{ id: '10', name: 'kappa' }] }), 100);
    store.pushBuffer('g1', msg({ id: 'b', ts: T0 + 1, self: true, emojis: [{ id: '10', name: 'kappa' }] }), 100);
    store.pushBuffer('g1', msg({ id: 'c', ts: T0 + 2, emojis: [{ id: '10', name: 'kappa' }, { id: '20', name: 'omega' }] }), 100);
    const llm = { complete: async () => ({ text: '{}' }) };
    const updater = createMemoryUpdater({ hot: hotFor({}), store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });
    await withCapturedLogs(() => updater.run('g1'));
    assert.deepEqual(store.getGuild('g1').emojiUsage, {
      10: { name: 'kappa', count: 2, last: T0 + 2 },
      20: { name: 'omega', count: 1, last: T0 + 2 },
    });
  });
});

test('memory run: a failed batch counts nothing (it is retried later)', async () => {
  await withStore(async (store) => {
    store.pushBuffer('g1', msg({ emojis: [{ id: '10', name: 'kappa' }] }), 100);
    const llm = { complete: async () => ({ text: 'not json at all' }) };
    const updater = createMemoryUpdater({ hot: hotFor({}), store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });
    await withCapturedLogs(() => updater.run('g1'));
    assert.deepEqual(store.getGuild('g1').emojiUsage, {});
  });
});

test('memory run: context.customEmoji.storeMax caps the stored entries', async () => {
  await withStore(async (store) => {
    store.pushBuffer('g1', msg({ id: 'a', ts: T0, emojis: [{ id: '1', name: 'alpha' }] }), 100);
    store.pushBuffer('g1', msg({ id: 'b', ts: T0 + DAY, emojis: [{ id: '2', name: 'beta' }] }), 100);
    const llm = { complete: async () => ({ text: '{}' }) };
    const hot = hotFor({ customEmoji: { storeMax: 1, halfLifeDays: 30 } });
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });
    await withCapturedLogs(() => updater.run('g1'));
    assert.deepEqual(Object.keys(store.getGuild('g1').emojiUsage), ['2']);
  });
});
