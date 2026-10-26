// The custom emoji history backfill (src/memory/emoji-backfill.js): a Discord
// history read, no LLM, that fills guild.json's `emojiUsage` at once and
// stamps `emojiBackfill`. A real store on a temp dir, a fake discord.js guild.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createEmojiBackfill } from '../src/memory/emoji-backfill.js';
import { createStore } from '../src/memory/store.js';
import { createDiscordInterface } from '../src/interface/discord.js';
import { tempDir } from './fixtures/tmp.js';
import { openTestMemory } from './fixtures/memory-db/service.js';

// The Discord interface's capabilities object, as src/index.js injects it.
const DISCORD = createDiscordInterface().capabilities;

const T0 = Date.UTC(2026, 8, 1);

function withStore(fn) {
  const dir = tempDir('nep-emoji-backfill-');
  return Promise.resolve()
    .then(() => fn(createStore({ dataDir: dir }), dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

/** A raw discord.js-shaped message; `content` is the raw text carrying `<:name:id>` markup. */
function rawMessage(n, { authorId = 'a', bot = false, content = 'hi' } = {}) {
  return {
    id: String(1000 + n),
    author: { id: authorId, bot, globalName: authorId, username: authorId },
    member: { displayName: authorId },
    content,
    cleanContent: content.replace(/<a?:(\w+):\d+>/g, ':$1:'),
    createdTimestamp: T0 + n * 1000,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    messageSnapshots: new Map(),
  };
}

function fakeChannel(id, historyAsc, { readable = true } = {}) {
  for (const m of historyAsc) m.channelId = id;
  const desc = [...historyAsc].reverse();
  return {
    id,
    name: id,
    parent: null,
    guild: null,
    isTextBased: () => true,
    isThread: () => false,
    viewable: readable,
    permissionsFor: () => ({ has: () => readable }),
    messages: {
      fetchCalls: 0,
      fetch(opts = {}) {
        this.fetchCalls += 1;
        let pool = desc;
        if (opts.before) pool = pool.filter((m) => BigInt(m.id) < BigInt(opts.before));
        return Promise.resolve(new Map(pool.slice(0, opts.limit ?? 50).map((m) => [m.id, m])));
      },
    },
  };
}

function fakeClient(channels, guildId = 'g1') {
  const guild = {
    id: guildId,
    channels: { cache: new Map(channels.map((c) => [c.id, c])) },
    members: { me: { id: 'selfUser' } },
  };
  for (const c of channels) c.guild = guild;
  return { user: { id: 'selfUser' }, guilds: { cache: new Map([[guildId, guild]]) } };
}

function fakeHot({ customEmoji = {}, features = {} } = {}) {
  return {
    config: {
      bot: {},
      features,
      media: { embedTextChars: 200 },
      context: { customEmoji: { max: 30, storeMax: 200, halfLifeDays: 30, backfillMessages: 500, ...customEmoji } },
    },
  };
}

function fakeLog() {
  const entries = [];
  const push = (level) => (message, fields) => entries.push({ level, message, fields });
  return { entries, info: push('info'), warn: push('warn'), error: push('error') };
}

const KAPPA = '<:kappa:111>';
const OMEGA = '<a:omega:222>';

function standardChannels() {
  return [
    fakeChannel('c1', [
      rawMessage(1, { content: `hello ${KAPPA} ${KAPPA}` }),
      rawMessage(2, { authorId: 'b', content: `${KAPPA} ${OMEGA}` }),
      rawMessage(3, { authorId: 'selfUser', content: `me ${KAPPA}` }),
      rawMessage(4, { authorId: 'otherBot', bot: true, content: `bot ${OMEGA}` }),
      rawMessage(5, { content: 'no emoji here' }),
    ]),
    fakeChannel('c2', [rawMessage(6, { authorId: 'c', content: `${OMEGA}` })]),
  ];
}

test("emoji backfill run: counts members' emoji over every readable channel, bots and self skipped", async () => {
  await withStore(async (store) => {
    const log = fakeLog();
    const hidden = fakeChannel('c3', [rawMessage(7, { content: KAPPA })], { readable: false });
    const backfill = createEmojiBackfill({
      discord: DISCORD,
      hot: fakeHot(),
      store,
      client: fakeClient([...standardChannels(), hidden]),
      log,
    });

    const result = await backfill.run('g1');
    assert.deepEqual(result, { ok: true, channels: 2, messages: 4, emoji: 4 });

    const usage = store.getGuild('g1').emojiUsage;
    assert.deepEqual(usage['111'], { name: 'kappa', count: 2, last: T0 + 2000 });
    assert.deepEqual(usage['222'], { name: 'omega', count: 2, last: T0 + 6000 });
    assert.equal(hidden.messages.fetchCalls, 0);

    const stamp = store.getGuild('g1').emojiBackfill;
    assert.equal(stamp.channels, 2);
    assert.equal(stamp.messages, 4);
    assert.ok(Number.isFinite(Date.parse(stamp.at)));
  });
});

test('emoji backfill run: a second run without force is a no-op and never double-counts', async () => {
  await withStore(async (store) => {
    const log = fakeLog();
    const channels = standardChannels();
    const backfill = createEmojiBackfill({
      discord: DISCORD,
      hot: fakeHot(),
      store,
      client: fakeClient(channels),
      log,
    });

    await backfill.run('g1');
    const fetchesAfterFirst = channels[0].messages.fetchCalls;
    const second = await backfill.run('g1');

    assert.deepEqual(second, { ok: false, reason: 'done' });
    assert.equal(store.getGuild('g1').emojiUsage['111'].count, 2);
    assert.equal(channels[0].messages.fetchCalls, fetchesAfterFirst, 'no history read on the no-op');
  });
});

test('emoji backfill run: force clears emojiUsage and recounts from history', async () => {
  await withStore(async (store) => {
    const backfill = createEmojiBackfill({
      discord: DISCORD,
      hot: fakeHot(),
      store,
      client: fakeClient(standardChannels()),
      log: fakeLog(),
    });

    await backfill.run('g1');
    // An entry the history no longer shows (e.g. counted before) disappears on a forced rescan.
    store.recordEmojiUsage('g1', [{ id: 'x', ts: T0, emojis: [{ id: '999', name: 'stale' }] }]);
    const result = await backfill.run('g1', { force: true });

    assert.deepEqual(result, { ok: true, channels: 2, messages: 4, emoji: 4 });
    const usage = store.getGuild('g1').emojiUsage;
    assert.deepEqual(Object.keys(usage).sort(), ['111', '222']);
    assert.equal(usage['111'].count, 2, 'recounted, not added to the first run');
  });
});

test("emoji backfill run: a first run over a ranking with counts ends with the history's counts alone", async () => {
  await withStore(async (store) => {
    // What the analyzer counted since the feature went live: messages the history window also holds.
    store.recordEmojiUsage('g1', [
      { id: '1001', ts: T0 + 1000, emojis: [{ id: '111', name: 'kappa' }] },
      { id: '1006', ts: T0 + 6000, emojis: [{ id: '222', name: 'omega' }] },
      { id: 'old', ts: T0 - 1000, emojis: [{ id: '333', name: 'gone' }] },
    ]);
    const backfill = createEmojiBackfill({
      discord: DISCORD,
      hot: fakeHot(),
      store,
      client: fakeClient(standardChannels()),
      log: fakeLog(),
    });

    const result = await backfill.run('g1');
    assert.deepEqual(result, { ok: true, channels: 2, messages: 4, emoji: 4 });
    assert.deepEqual(store.getGuild('g1').emojiUsage, {
      111: { name: 'kappa', count: 2, last: T0 + 2000 },
      222: { name: 'omega', count: 2, last: T0 + 6000 },
    });
  });
});

test('emoji backfill run: backfillMessages 0 disables it, even forced', async () => {
  await withStore(async (store) => {
    const log = fakeLog();
    const channels = standardChannels();
    const hot = fakeHot({ customEmoji: { backfillMessages: 0 } });
    const backfill = createEmojiBackfill({ discord: DISCORD, hot, store, client: fakeClient(channels), log });

    assert.deepEqual(await backfill.run('g1'), { ok: false, reason: 'disabled' });
    assert.deepEqual(await backfill.run('g1', { force: true }), { ok: false, reason: 'disabled' });
    assert.equal(channels[0].messages.fetchCalls, 0);
    assert.deepEqual(store.getGuild('g1').emojiUsage, {});
    assert.equal(store.getGuild('g1').emojiBackfill, null);
  });
});

test('emoji backfill run: backfillMessages caps the messages read per channel (read at use)', async () => {
  await withStore(async (store) => {
    const hot = fakeHot({ customEmoji: { backfillMessages: 2 } });
    const backfill = createEmojiBackfill({
      discord: DISCORD,
      hot,
      store,
      client: fakeClient(standardChannels()),
      log: fakeLog(),
    });

    // c1's newest two are a member's message without emoji and a bot's; c2 has one member message.
    const result = await backfill.run('g1');
    assert.deepEqual(result, { ok: true, channels: 2, messages: 2, emoji: 1 });
    assert.equal(store.getGuild('g1').emojiUsage['111'], undefined);
  });
});

test('emoji backfill run: refused while paused and while another run is in flight', async () => {
  await withStore(async (store) => {
    const backfill = createEmojiBackfill({
      discord: DISCORD,
      hot: fakeHot(),
      store,
      client: fakeClient(standardChannels()),
      log: fakeLog(),
    });

    store.state.data.paused = true;
    assert.deepEqual(await backfill.run('g1'), { ok: false, reason: 'paused' });
    store.state.data.paused = false;

    const first = backfill.run('g1');
    assert.equal(backfill.isRunning(), true);
    assert.deepEqual(await backfill.run('g1', { force: true }), { ok: false, reason: 'running' });
    assert.equal((await first).ok, true);
    assert.equal(backfill.isRunning(), false);
  });
});

test('emoji backfill run: an unknown guild is skipped', async () => {
  await withStore(async (store) => {
    const backfill = createEmojiBackfill({
      discord: DISCORD,
      hot: fakeHot(),
      store,
      client: fakeClient(standardChannels()),
      log: fakeLog(),
    });
    assert.deepEqual(await backfill.run('nope'), { ok: false, reason: 'no-guild' });
  });
});

test('emoji backfill startIfNeeded: runs once when the feature is on and nothing is stamped', async () => {
  await withStore(async (store) => {
    const channels = standardChannels();
    const backfill = createEmojiBackfill({
      discord: DISCORD,
      hot: fakeHot(),
      store,
      client: fakeClient(channels),
      log: fakeLog(),
    });

    await backfill.startIfNeeded('g1');
    assert.equal(store.getGuild('g1').emojiUsage['111'].count, 2);
    const fetches = channels[0].messages.fetchCalls;
    await backfill.startIfNeeded('g1');
    assert.equal(channels[0].messages.fetchCalls, fetches, 'stamped: never again at startup');
  });
});

test('emoji backfill startIfNeeded: features.customEmoji off skips it', async () => {
  await withStore(async (store) => {
    const log = fakeLog();
    const channels = standardChannels();
    const backfill = createEmojiBackfill({
      discord: DISCORD,
      hot: fakeHot({ features: { customEmoji: false } }),
      store,
      client: fakeClient(channels),
      log,
    });

    await backfill.startIfNeeded('g1');
    assert.equal(channels[0].messages.fetchCalls, 0);
    assert.equal(store.getGuild('g1').emojiBackfill, null);
  });
});

test('emoji backfill startIfNeeded: an error is logged, never thrown', async () => {
  await withStore(async (store) => {
    const log = fakeLog();
    const client = {
      user: { id: 'selfUser' },
      guilds: {
        get cache() {
          throw new Error('boom');
        },
      },
    };
    const backfill = createEmojiBackfill({ discord: DISCORD, hot: fakeHot(), store, client, log });

    await backfill.startIfNeeded('g1');
    assert.ok(log.entries.some((e) => e.level === 'error' && e.message === 'emoji-backfill: failed'));
    assert.equal(backfill.isRunning(), false);
  });
});

test('store emojiBackfill: normalised on read, set only through setEmojiBackfill, cleared usage stays cleared', async () => {
  const mem = await openTestMemory();
  try {
    const { dataDir: dir, memoryDb } = mem;
    const store = createStore({ dataDir: dir, memoryDb });
    assert.equal(store.getGuild('g1').emojiBackfill, null);

    await memoryDb.writeUnit({
      op: 'value',
      owner: 'guilds/g2/guild.json',
      value: { emojiBackfill: { at: 5, channels: 'x' } },
    });
    assert.equal(store.getGuild('g2').emojiBackfill, null);

    await memoryDb.writeUnit({
      op: 'value',
      owner: 'guilds/g3/guild.json',
      value: { emojiBackfill: { at: '2026-09-30T00:00:00.000Z', channels: 2.7, messages: -1 } },
    });
    assert.deepEqual(store.getGuild('g3').emojiBackfill, { at: '2026-09-30T00:00:00.000Z', channels: 2, messages: 0 });

    store.updateGuild('g1', { emojiBackfill: { at: 'x', channels: 1, messages: 1 } });
    assert.equal(store.getGuild('g1').emojiBackfill, null, 'updateGuild never writes the stamp');

    store.setEmojiBackfill('g1', { at: '2026-09-30T00:00:00.000Z', channels: 3, messages: 40 });
    store.recordEmojiUsage('g1', [{ id: 'm', ts: T0, emojis: [{ id: '1', name: 'alpha' }] }]);
    store.clearEmojiUsage('g1');
    store.flush();
    await store.flushSettled({});
    const stored = createStore({ dataDir: dir, memoryDb }).getGuild('g1');
    assert.deepEqual(stored.emojiBackfill, { at: '2026-09-30T00:00:00.000Z', channels: 3, messages: 40 });
    assert.deepEqual(stored.emojiUsage, {});
  } finally {
    await mem.close();
    fs.rmSync(mem.dataDir, { recursive: true, force: true });
  }
});
