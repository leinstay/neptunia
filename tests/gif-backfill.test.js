// The GIF library history backfill (src/memory/gif-backfill.js): a Discord
// history read that rebuilds gifs.json at once, stamps its `backfill`, then
// has the describer caption the top entries still without a caption. A real
// store on a temp dir, a fake discord.js guild, a fake describer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createGifBackfill } from '../src/memory/gif-backfill.js';
import { createStore } from '../src/memory/store.js';
import { createDiscordInterface } from '../src/interface/discord.js';
import { tempDir } from './fixtures/tmp.js';

// The Discord interface's capabilities object, as src/index.js injects it.
const DISCORD = createDiscordInterface().capabilities;

const T0 = Date.UTC(2026, 8, 1);
const TENOR_A = 'https://tenor.com/view/cat-dance-1';
const TENOR_B = 'https://tenor.com/view/wave-2';

function withStore(fn) {
  const dir = tempDir('nep-gif-backfill-');
  return Promise.resolve()
    .then(() => fn(createStore({ dataDir: dir }), dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

/** A tenor embed as discord.js exposes it. */
function tenorEmbed(url, title = 'Chat qui danse') {
  return {
    url,
    title,
    provider: { name: 'Tenor' },
    thumbnail: { url: `${url}/frame.png`, proxyURL: `${url}/proxy.png` },
  };
}

/** A raw discord.js-shaped message. */
function rawMessage(n, { authorId = 'a', bot = false, embeds = [], gifFile = null } = {}) {
  const attachments = new Map();
  if (gifFile) {
    attachments.set(gifFile, {
      id: gifFile,
      name: 'réaction.gif',
      contentType: 'image/gif',
      url: `https://cdn.discordapp.com/attachments/1/${gifFile}/r.gif`,
    });
  }
  return {
    id: String(1000 + n),
    author: { id: authorId, bot, globalName: authorId, username: authorId },
    member: { displayName: authorId },
    content: 'look',
    cleanContent: 'look',
    createdTimestamp: T0 + n * 1000,
    reference: null,
    attachments,
    stickers: new Map(),
    embeds,
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

function fakeHot({ gifs = {}, features = {} } = {}) {
  return {
    config: {
      bot: {},
      features,
      media: { embedTextChars: 200 },
      gifs: {
        max: 20,
        storeMax: 300,
        halfLifeDays: 30,
        maxPerDay: 40,
        backfillMessages: 500,
        backfillDescribe: 20,
        ...gifs,
      },
    },
  };
}

function fakeLog() {
  const entries = [];
  const push = (level) => (message, fields) => entries.push({ level, message, fields });
  return { entries, info: push('info'), warn: push('warn'), error: push('error') };
}

/** Captions every item it is handed; records the calls. */
function fakeDescriber() {
  return {
    calls: [],
    async describeMany(guildId, items, opts) {
      this.calls.push({ guildId, items, opts });
      return {
        descriptions: new Map(items.map((item) => [item.itemId, `caption of ${item.itemId}`])),
        newCount: items.length,
      };
    },
  };
}

/**
 * c1: TENOR_A three times (the first embed id keeps counting), a gif file twice, TENOR_B once,
 * the persona's and a bot's gifs; c2: TENOR_B once more.
 */
function standardChannels() {
  return [
    fakeChannel('c1', [
      rawMessage(1, { embeds: [tenorEmbed(TENOR_A)] }),
      rawMessage(2, { authorId: 'b', embeds: [tenorEmbed(TENOR_A)] }),
      rawMessage(3, { authorId: 'b', gifFile: '555' }),
      rawMessage(4, { embeds: [tenorEmbed(TENOR_A)] }),
      rawMessage(5, { authorId: 'c', gifFile: '555' }),
      rawMessage(6, { embeds: [tenorEmbed(TENOR_B, 'Salut')] }),
      rawMessage(7, { authorId: 'selfUser', embeds: [tenorEmbed(TENOR_B)] }),
      rawMessage(8, { authorId: 'otherBot', bot: true, gifFile: '777' }),
    ]),
    fakeChannel('c2', [rawMessage(9, { authorId: 'c', embeds: [tenorEmbed(TENOR_B, 'Salut')] })]),
  ];
}

function countsByUrl(store) {
  return Object.fromEntries(
    Object.values(store.getGifs('g1').entries).map((entry) => [
      entry.kind === 'link' ? entry.url : entry.itemId,
      entry.count,
    ])
  );
}

test("gif backfill run: counts members' gifs over every readable channel, bots and self skipped", async () => {
  await withStore(async (store) => {
    const log = fakeLog();
    const hidden = fakeChannel('c3', [rawMessage(10, { embeds: [tenorEmbed(TENOR_A)] })], { readable: false });
    const backfill = createGifBackfill({
      discord: DISCORD,
      hot: fakeHot(),
      store,
      client: fakeClient([...standardChannels(), hidden]),
      log,
    });

    const result = await backfill.run('g1');
    assert.deepEqual(result, { ok: true, channels: 2, messages: 7, gifs: 7, described: 0 });
    assert.deepEqual(countsByUrl(store), { [TENOR_A]: 3, 555: 2, [TENOR_B]: 2 });
    assert.equal(store.getGifs('g1').entries['1001#e0'].count, 3, 'the first embed id keeps counting');
    assert.equal(hidden.messages.fetchCalls, 0);

    const stamp = store.getGifs('g1').backfill;
    assert.equal(stamp.channels, 2);
    assert.equal(stamp.messages, 7);
    assert.ok(Number.isFinite(Date.parse(stamp.at)));

    const done = log.entries.find((e) => e.message === 'gif-backfill: done');
    assert.deepEqual(done.fields, { channels: 2, messages: 7, gifs: 7, described: 0 });
  });
});

test('gif backfill run: a second run without force is a no-op and never double-counts', async () => {
  await withStore(async (store) => {
    const log = fakeLog();
    const channels = standardChannels();
    const backfill = createGifBackfill({ discord: DISCORD, hot: fakeHot(), store, client: fakeClient(channels), log });

    await backfill.run('g1');
    const fetches = channels[0].messages.fetchCalls;
    assert.deepEqual(await backfill.run('g1'), { ok: false, reason: 'done' });
    assert.deepEqual(countsByUrl(store), { [TENOR_A]: 3, 555: 2, [TENOR_B]: 2 });
    assert.equal(channels[0].messages.fetchCalls, fetches, 'no history read on the no-op');
    assert.deepEqual(log.entries.find((e) => e.message === 'gif-backfill: skipped').fields, { reason: 'done' });
  });
});

test('gif backfill run: the first run resets what was recorded on arrival, never counting it twice', async () => {
  await withStore(async (store) => {
    // Recorded on arrival: a message the history window also holds, and one gone from it.
    store.recordGifs('g1', [
      { id: '1001', ts: T0 + 1000, channelId: 'c1', links: [{ id: '1001#e0', kind: 'gif', url: TENOR_A }] },
      {
        id: 'old',
        ts: T0 - 1000,
        channelId: 'c1',
        links: [{ id: 'old#e0', kind: 'gif', url: 'https://tenor.com/view/gone-9' }],
      },
    ]);
    const backfill = createGifBackfill({
      discord: DISCORD,
      hot: fakeHot(),
      store,
      client: fakeClient(standardChannels()),
      log: fakeLog(),
    });

    await backfill.startIfNeeded('g1');
    assert.deepEqual(countsByUrl(store), { [TENOR_A]: 3, 555: 2, [TENOR_B]: 2, 'https://tenor.com/view/gone-9': 0 });
    assert.equal(store.getGifs('g1').entries['1001#e0'].id, 'g1', 'the arrival handle is kept');
    assert.equal(store.getGifs('g1').entries['old#e0'].id, 'g2');
  });
});

test('gif backfill run: keep handles across a rescan', async () => {
  await withStore(async (store) => {
    const hot = fakeHot();
    const backfill = createGifBackfill({
      discord: DISCORD,
      hot,
      store,
      client: fakeClient(standardChannels()),
      log: fakeLog(),
    });

    await backfill.run('g1');
    const firstHandles = Object.fromEntries(
      Object.entries(store.getGifs('g1').entries).map(([key, entry]) => [key, entry.id])
    );
    store.recordGifs('g1', [
      {
        id: 'x',
        ts: T0,
        channelId: 'c1',
        attachments: [{ id: '999', kind: 'gif', url: 'https://cdn.discordapp.com/x.gif' }],
      },
    ]);
    const staleHandle = store.getGifs('g1').entries['999'].id;
    const nextId = store.getGifs('g1').nextId;

    const result = await backfill.run('g1', { force: true });
    assert.equal(result.ok, true);
    assert.equal(result.gifs, 7);
    assert.deepEqual(
      countsByUrl(store),
      { [TENOR_A]: 3, 555: 2, [TENOR_B]: 2, 999: 0 },
      'fresh counts, never added on top'
    );
    const entries = store.getGifs('g1').entries;
    for (const [key, id] of Object.entries(firstHandles)) assert.equal(entries[key].id, id, `${key} keeps ${id}`);
    assert.equal(entries['999'].id, staleHandle, 'an entry gone from history keeps its handle with count 0');
    assert.equal(store.getGifs('g1').nextId, nextId, 'no handle was spent');

    hot.config.gifs.storeMax = 3;
    await backfill.run('g1', { force: true });
    assert.deepEqual(
      countsByUrl(store),
      { [TENOR_A]: 3, 555: 2, [TENOR_B]: 2 },
      'the zero-count entry is the first evicted at storeMax'
    );
    for (const [key, id] of Object.entries(firstHandles)) assert.equal(store.getGifs('g1').entries[key].id, id);
  });
});

test('gif backfill run: describes the top backfillDescribe entries without a cached caption, as real requests', async () => {
  await withStore(async (store) => {
    const describer = fakeDescriber();
    const hot = fakeHot({ gifs: { backfillDescribe: 2 } });
    // The most used gif already has a caption (its first embed id): it is skipped, not re-described.
    store.getMediaCache('g1')['1001#e0'] = { text: 'a cat dancing', ts: T0 };
    const backfill = createGifBackfill({
      discord: DISCORD,
      hot,
      store,
      client: fakeClient(standardChannels()),
      describer,
      log: fakeLog(),
    });

    const result = await backfill.run('g1');
    assert.equal(result.described, 2);
    assert.equal(describer.calls.length, 1);
    const [call] = describer.calls;
    assert.equal(call.guildId, 'g1');
    assert.deepEqual(
      call.opts,
      { concurrency: 1 },
      'one GIF at a time; every describer request counts, no option to say so'
    );
    assert.deepEqual(
      call.items.map(({ itemId, kind, url }) => ({ itemId, kind, url })),
      [
        { itemId: '1006#e0', kind: 'gif', url: `${TENOR_B}/proxy.png` },
        { itemId: '555', kind: 'gif', url: 'https://cdn.discordapp.com/attachments/1/555/r.gif' },
      ],
      'the embed thumbnail and the attachment file, in rank order (same count, TENOR_B used last)'
    );
  });
});

test("gif backfill run: the describer gets each GIF's whole picture item, so a library GIF is watched from its animation", async () => {
  await withStore(async (store) => {
    const describer = fakeDescriber();
    const gifv = { ...tenorEmbed(TENOR_A), video: { url: `${TENOR_A}/loop.mp4`, proxyURL: `${TENOR_A}/proxy.mp4` } };
    const channels = [
      fakeChannel('c1', [rawMessage(1, { embeds: [gifv] }), rawMessage(2, { authorId: 'b', gifFile: '555' })]),
    ];
    const backfill = createGifBackfill({
      discord: DISCORD,
      hot: fakeHot(),
      store,
      client: fakeClient(channels),
      describer,
      log: fakeLog(),
    });

    await backfill.run('g1');
    const byId = new Map(describer.calls[0].items.map((item) => [item.itemId, item]));
    assert.equal(byId.get('1001#e0').animationUrl, `${TENOR_A}/proxy.mp4`, 'the gifv mp4 travels with the item');
    assert.equal(byId.get('1001#e0').source, 'embed');
    assert.equal(byId.get('1001#e0').url, `${TENOR_A}/proxy.png`, 'the still frame stays the fallback');
    assert.equal(byId.get('555').source, 'attachment', 'an attached .gif is its own animation');
    assert.equal(byId.get('555').url, 'https://cdn.discordapp.com/attachments/1/555/r.gif');
  });
});

test('gif backfill run: backfillDescribe 0 or no describer describes nothing', async () => {
  await withStore(async (store) => {
    const describer = fakeDescriber();
    const off = createGifBackfill({
      discord: DISCORD,
      hot: fakeHot({ gifs: { backfillDescribe: 0 } }),
      store,
      client: fakeClient(standardChannels()),
      describer,
      log: fakeLog(),
    });
    assert.equal((await off.run('g1')).described, 0);
    assert.equal(describer.calls.length, 0);

    const none = createGifBackfill({
      discord: DISCORD,
      hot: fakeHot(),
      store,
      client: fakeClient(standardChannels()),
      log: fakeLog(),
    });
    assert.equal((await none.run('g1', { force: true })).described, 0);
  });
});

test('gif backfill run: backfillMessages 0 disables it, even forced', async () => {
  await withStore(async (store) => {
    const channels = standardChannels();
    const describer = fakeDescriber();
    const backfill = createGifBackfill({
      discord: DISCORD,
      hot: fakeHot({ gifs: { backfillMessages: 0 } }),
      store,
      client: fakeClient(channels),
      describer,
      log: fakeLog(),
    });

    assert.deepEqual(await backfill.run('g1'), { ok: false, reason: 'disabled' });
    assert.deepEqual(await backfill.run('g1', { force: true }), { ok: false, reason: 'disabled' });
    assert.equal(channels[0].messages.fetchCalls, 0);
    assert.equal(describer.calls.length, 0);
    assert.deepEqual(store.getGifs('g1').entries, {});
    assert.equal(store.getGifs('g1').backfill, null);
  });
});

test('gif backfill run: backfillMessages caps the messages read per channel (read at use)', async () => {
  await withStore(async (store) => {
    const backfill = createGifBackfill({
      discord: DISCORD,
      hot: fakeHot({ gifs: { backfillMessages: 2 } }),
      store,
      client: fakeClient(standardChannels()),
      log: fakeLog(),
    });

    // c1's newest two are the persona's and a bot's; c2 has one member message.
    const result = await backfill.run('g1');
    assert.deepEqual(result, { ok: true, channels: 2, messages: 1, gifs: 1, described: 0 });
    assert.deepEqual(countsByUrl(store), { [TENOR_B]: 1 });
  });
});

test('gif backfill run: refused while paused and while another run is in flight', async () => {
  await withStore(async (store) => {
    const backfill = createGifBackfill({
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

test('gif backfill run: an unknown guild is skipped', async () => {
  await withStore(async (store) => {
    const backfill = createGifBackfill({
      discord: DISCORD,
      hot: fakeHot(),
      store,
      client: fakeClient(standardChannels()),
      log: fakeLog(),
    });
    assert.deepEqual(await backfill.run('nope'), { ok: false, reason: 'no-guild' });
  });
});

test('gif backfill startIfNeeded: runs once when the feature is on and nothing is stamped', async () => {
  await withStore(async (store) => {
    const channels = standardChannels();
    const backfill = createGifBackfill({
      discord: DISCORD,
      hot: fakeHot(),
      store,
      client: fakeClient(channels),
      log: fakeLog(),
    });

    await backfill.startIfNeeded('g1');
    assert.equal(Object.keys(store.getGifs('g1').entries).length, 3);
    const fetches = channels[0].messages.fetchCalls;
    await backfill.startIfNeeded('g1');
    assert.equal(channels[0].messages.fetchCalls, fetches, 'stamped: never again at startup');
  });
});

test('gif backfill startIfNeeded: features.gifs off skips it', async () => {
  await withStore(async (store) => {
    const log = fakeLog();
    const channels = standardChannels();
    const backfill = createGifBackfill({
      discord: DISCORD,
      hot: fakeHot({ features: { gifs: false } }),
      store,
      client: fakeClient(channels),
      log,
    });

    await backfill.startIfNeeded('g1');
    assert.equal(channels[0].messages.fetchCalls, 0);
    assert.equal(store.getGifs('g1').backfill, null);
    assert.deepEqual(log.entries.find((e) => e.message === 'gif-backfill: skipped').fields, { reason: 'feature-off' });
  });
});

test('gif backfill startIfNeeded: an error is logged, never thrown', async () => {
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
    const backfill = createGifBackfill({ discord: DISCORD, hot: fakeHot(), store, client, log });

    await backfill.startIfNeeded('g1');
    assert.ok(log.entries.some((e) => e.level === 'error' && e.message === 'gif-backfill: failed'));
    assert.equal(backfill.isRunning(), false);
  });
});

test('store setGifBackfill / resetGifCounts: the stamp is normalised and persisted, a reset keeps entries and handles', async () => {
  await withStore(async (store, dir) => {
    store.recordGifs('g1', [{ id: 'm', ts: T0, channelId: 'c1', links: [{ id: 'm#e0', kind: 'gif', url: TENOR_A }] }]);
    assert.deepEqual(store.setGifBackfill('g1', { at: '2026-09-30T00:00:00.000Z', channels: 2.7, messages: -1 }), {
      at: '2026-09-30T00:00:00.000Z',
      channels: 2,
      messages: 0,
    });
    assert.equal(store.setGifBackfill('g2', { at: 5 }), null);

    store.resetGifCounts('g1');
    store.flush();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'guilds', 'g1', 'gifs.json'), 'utf8'));
    assert.deepEqual(Object.keys(onDisk.entries), ['m#e0']);
    assert.equal(onDisk.entries['m#e0'].id, 'g1');
    assert.equal(onDisk.entries['m#e0'].count, 0);
    assert.equal(onDisk.entries['m#e0'].last, T0);
    assert.equal(onDisk.nextId, 2);
    assert.equal(
      createStore({ dataDir: dir }).getGifs('g1').entries['m#e0'].id,
      'g1',
      'a reset entry survives a restart'
    );
    assert.deepEqual(onDisk.backfill, { at: '2026-09-30T00:00:00.000Z', channels: 2, messages: 0 });
  });
});
