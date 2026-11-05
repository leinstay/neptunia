// The GIF library history backfill (src/memory/gif-backfill.ts): a history read
// through the interface that rebuilds gifs.json at once, stamps its `backfill`, then
// has the describer caption the top entries still without a caption. A real
// store on a temp dir, the fake interface's reads, a fake describer. The messages
// are Discord-shaped and read into events as the Discord package does.

import { placeOfCommunity } from '../src/memory/addresses.ts';
import { MEMORY_OF, memDataDir, readRaw } from './fixtures/store-kit.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createGifBackfill } from '../src/memory/gif-backfill.ts';
import { gifOpts } from '../src/memory/gifs.ts';
import { createStore } from '../src/memory/store.ts';
import { normalizeOptions, toEvent } from '../interfaces/discord/index.ts';
import { tempDir } from './fixtures/tmp.ts';
import { IFACE, channel, rig } from './fixtures/reads-rig.ts';
import type { Untyped } from '../src/tools/types.ts';
import { present, wrongly, removeField } from './fixtures/loose-types.ts';
import type { GifEntry } from '../src/memory/gifs.ts';
import type { Store } from '../src/memory/store.ts';

const T0 = Date.UTC(2026, 8, 1);
const TENOR_A = 'https://tenor.com/view/cat-dance-1';
const TENOR_B = 'https://tenor.com/view/wave-2';

/** The store with the library typed as it is kept: `getGifs` answers entries of the library, not bare objects. */
type GifStore = Omit<Store, 'getGifs' | 'getMediaCache'> & {
  getMediaCache(placeId: string): Record<string, Untyped>;
  getGifs(placeId: string): {
    nextId: number;
    entries: Record<string, GifEntry>;
    backfill: { at: string; channels: number; messages: number } | null;
  };
};

function withStore(fn: (store: GifStore, dir: string) => unknown) {
  const dir = tempDir('nep-gif-backfill-');
  return Promise.resolve()
    .then(() => fn(wrongly<GifStore>(createStore({ dataDir: dir })), dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

/** A tenor embed as discord.js exposes it. */
function tenorEmbed(url: string, title = 'Chat qui danse') {
  return {
    url,
    title,
    provider: { name: 'Tenor' },
    thumbnail: { url: `${url}/frame.png`, proxyURL: `${url}/proxy.png` },
  };
}

/** A raw discord.js-shaped message. */
function rawMessage(
  n: number,
  {
    authorId = 'a',
    bot = false,
    embeds = [],
    gifFile = null,
  }: { authorId?: string; bot?: boolean; embeds?: Array<Untyped>; gifFile?: Untyped } = {}
) {
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

/**
 * A conversation holding `historyAsc` (raw messages, oldest first), read into the events the interface would deliver.
 */
function fakeChannel(
  id: string,
  historyAsc: Array<Record<string, Untyped>>,
  { readable = true }: { readable?: boolean } = {}
) {
  const stub = { id, name: id, parent: null, guild: { id: 'g1' }, isThread: () => false };
  const events = historyAsc.map((raw) => {
    const event = toEvent(
      { ...raw, channel: stub, channelId: id, guild: stub.guild },
      'selfUser',
      normalizeOptions({ media: { embedTextChars: 200 } })
    );
    removeField(event, 'raw');
    return event;
  });
  const info = channel(id, { permissions: { read: readable, send: readable, attach: readable, react: readable } });
  return { info, events };
}

/** The fake interface holding `rooms`, with the core's reads over it. */
function fakeClient(rooms: Array<Record<string, Untyped>>) {
  const world = rig();
  for (const { info, events } of rooms) {
    world.fake.seedConversation(info);
    for (const event of events) world.fake.seedEvent(event);
  }
  return world;
}

/**
 * What the backfill takes of the interface.
 */
const depsOf = (world: Record<string, Untyped>) => ({ reads: world.reads, iface: () => IFACE });

// PR 7d: the switch is code and the library's measures are constants (300 entries kept, 500 messages read a channel,
// 20 GIFs described after a count).
function fakeHot() {
  return { config: { bot: {} } };
}

function fakeLog() {
  const entries: Array<Untyped> = [];
  const push = (level: string) => (message: string, fields: Record<string, Untyped>) =>
    entries.push({ level, message, fields });
  return { entries, info: push('info'), warn: push('warn'), error: push('error') };
}

/** Captions every item it is handed; records the calls. */
function fakeDescriber() {
  return {
    calls: [],
    async describeMany(placeId: string, items: Array<Record<string, Untyped>>, opts: Record<string, Untyped>) {
      this.calls.push(wrongly({ placeId, items, opts }));
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

function countsByUrl(store: GifStore) {
  return Object.fromEntries(
    Object.values(store.getGifs(placeOfCommunity(store, 'g1')).entries).map((entry) => [
      entry.kind === 'link' ? entry.url : entry.itemId,
      entry.count,
    ])
  );
}

test("gif backfill run: counts members' gifs over every readable channel, bots and self skipped", async () => {
  await withStore(async (store: GifStore) => {
    const log = fakeLog();
    const hidden = fakeChannel('c3', [rawMessage(10, { embeds: [tenorEmbed(TENOR_A)] })], { readable: false });
    const world = fakeClient([...standardChannels(), hidden]);
    const backfill = createGifBackfill(wrongly({ ...depsOf(world), hot: fakeHot(), store, log }));

    const result = await backfill.run(placeOfCommunity(backfill, 'g1'));
    assert.deepEqual(result, { ok: true, channels: 2, messages: 7, gifs: 7, described: 0 });
    assert.deepEqual(countsByUrl(store), { [TENOR_A]: 3, 555: 2, [TENOR_B]: 2 });
    assert.equal(
      store.getGifs(placeOfCommunity(store, 'g1')).entries['1001#e0'].count,
      3,
      'the first embed id keeps counting'
    );
    assert.equal(
      world.asked('history').some((ref: Untyped) => ref.conversationId === 'c3'),
      false,
      'a conversation the persona may not read is never read'
    );

    const stamp = present(store.getGifs(placeOfCommunity(store, 'g1')).backfill);
    assert.equal(stamp.channels, 2);
    assert.equal(stamp.messages, 7);
    assert.ok(Number.isFinite(Date.parse(stamp.at)));

    const done = log.entries.find((e) => e.message === 'gif-backfill: done');
    assert.deepEqual(done.fields, { channels: 2, messages: 7, gifs: 7, described: 0 });
  });
});

test('gif backfill run: a second run without force is a no-op and never double-counts', async () => {
  await withStore(async (store: GifStore) => {
    const log = fakeLog();
    const world = fakeClient(standardChannels());
    const backfill = createGifBackfill(wrongly({ ...depsOf(world), hot: fakeHot(), store, log }));

    await backfill.run(placeOfCommunity(backfill, 'g1'));
    const fetches = world.asked('history').length;
    assert.deepEqual(await backfill.run(placeOfCommunity(backfill, 'g1')), { ok: false, reason: 'done' });
    assert.deepEqual(countsByUrl(store), { [TENOR_A]: 3, 555: 2, [TENOR_B]: 2 });
    assert.equal(world.asked('history').length, fetches, 'no history read on the no-op');
    assert.deepEqual(log.entries.find((e) => e.message === 'gif-backfill: skipped').fields, { reason: 'done' });
  });
});

test('gif backfill run: the first run resets what was recorded on arrival, never counting it twice', async () => {
  await withStore(async (store: GifStore) => {
    // Recorded on arrival: a message the history window also holds, and one gone from it.
    store.recordGifs(placeOfCommunity(store, 'g1'), [
      { id: '1001', ts: T0 + 1000, placeId: 'c1', links: [{ id: '1001#e0', kind: 'gif', url: TENOR_A }] },
      {
        id: 'old',
        ts: T0 - 1000,
        placeId: 'c1',
        links: [{ id: 'old#e0', kind: 'gif', url: 'https://tenor.com/view/gone-9' }],
      },
    ]);
    const backfill = createGifBackfill(
      wrongly({
        ...depsOf(fakeClient(standardChannels())),
        hot: fakeHot(),
        store,
        log: fakeLog(),
      })
    );

    await backfill.startIfNeeded(placeOfCommunity(backfill, 'g1'));
    assert.deepEqual(countsByUrl(store), { [TENOR_A]: 3, 555: 2, [TENOR_B]: 2, 'https://tenor.com/view/gone-9': 0 });
    assert.equal(
      store.getGifs(placeOfCommunity(store, 'g1')).entries['1001#e0'].id,
      'g1',
      'the arrival handle is kept'
    );
    assert.equal(store.getGifs(placeOfCommunity(store, 'g1')).entries['old#e0'].id, 'g2');
  });
});

test('gif backfill run: keep handles across a rescan', async () => {
  await withStore(async (store: GifStore) => {
    const hot = fakeHot();
    const backfill = createGifBackfill(
      wrongly({ ...depsOf(fakeClient(standardChannels())), hot, store, log: fakeLog() })
    );

    await backfill.run(placeOfCommunity(backfill, 'g1'));
    const firstHandles = Object.fromEntries(
      Object.entries(store.getGifs(placeOfCommunity(store, 'g1')).entries).map(([key, entry]: [string, Untyped]) => [
        key,
        entry.id,
      ])
    );
    store.recordGifs(placeOfCommunity(store, 'g1'), [
      {
        id: 'x',
        ts: T0,
        placeId: 'c1',
        attachments: [{ id: '999', kind: 'gif', url: 'https://cdn.discordapp.com/x.gif' }],
      },
    ]);
    const staleHandle = store.getGifs(placeOfCommunity(store, 'g1')).entries['999'].id;
    const nextId = store.getGifs(placeOfCommunity(store, 'g1')).nextId;

    const result = await backfill.run(placeOfCommunity(backfill, 'g1'), { force: true });
    assert.equal(result.ok, true);
    assert.equal(result.gifs, 7);
    assert.deepEqual(
      countsByUrl(store),
      { [TENOR_A]: 3, 555: 2, [TENOR_B]: 2, 999: 0 },
      'fresh counts, never added on top'
    );
    const entries = store.getGifs(placeOfCommunity(store, 'g1')).entries;
    for (const [key, id] of Object.entries(firstHandles)) assert.equal(entries[key].id, id, `${key} keeps ${id}`);
    assert.equal(entries['999'].id, staleHandle, 'an entry gone from history keeps its handle with count 0');
    assert.equal(store.getGifs(placeOfCommunity(store, 'g1')).nextId, nextId, 'no handle was spent');

    // PR 7d: `gifs.storeMax` is the constant 300, so 297 more GIFs, recorded as the live observer records them, fill the
    // library past it.
    store.recordGifs(
      placeOfCommunity(store, 'g1'),
      Array.from({ length: 297 }, (_, n) => ({
        id: `y${n}`,
        ts: T0 + n,
        placeId: 'c1',
        attachments: [{ id: `y${n}`, kind: 'gif', url: `https://cdn.discordapp.com/y${n}.gif` }],
      })),
      gifOpts()
    );
    const kept = countsByUrl(store);
    assert.equal(Object.keys(kept).length, 300);
    assert.equal('999' in kept, false, 'the zero-count entry is the first evicted at storeMax');
    for (const [key, id] of Object.entries(firstHandles))
      assert.equal(store.getGifs(placeOfCommunity(store, 'g1')).entries[key].id, id);
  });
});

test('gif backfill run: describes the top backfillDescribe entries without a cached caption, as real requests', async () => {
  await withStore(async (store: GifStore) => {
    const describer: Record<string, Untyped> = fakeDescriber();
    const hot = fakeHot();
    // The most used gif already has a caption (its first embed id): it is skipped, not re-described.
    wrongly<Record<string, unknown>>(store.getMediaCache(placeOfCommunity(store, 'g1')))['1001#e0'] = {
      text: 'a cat dancing',
      ts: T0,
    };
    const backfill = createGifBackfill(
      wrongly({
        ...depsOf(fakeClient(standardChannels())),
        hot,
        store,
        describer,
        log: fakeLog(),
      })
    );

    const result: Record<string, Untyped> = await backfill.run(placeOfCommunity(backfill, 'g1'));
    assert.equal(result.described, 2);
    assert.equal(describer.calls.length, 1);
    const [call] = describer.calls;
    assert.equal(call.placeId, 'g1');
    assert.deepEqual(
      call.opts,
      { concurrency: 1 },
      'one GIF at a time; every describer request counts, no option to say so'
    );
    assert.deepEqual(
      call.items.map(({ itemId, kind, url }: Record<string, Untyped>) => ({ itemId, kind, url })),
      [
        { itemId: '1006#e0', kind: 'gif', url: `${TENOR_B}/proxy.png` },
        { itemId: '555', kind: 'gif', url: 'https://cdn.discordapp.com/attachments/1/555/r.gif' },
      ],
      'the embed thumbnail and the attachment file, in rank order (same count, TENOR_B used last)'
    );
  });
});

test("gif backfill run: the describer gets each GIF's whole picture item, so a library GIF is watched from its animation", async () => {
  await withStore(async (store: GifStore) => {
    const describer: Record<string, Untyped> = fakeDescriber();
    const gifv = { ...tenorEmbed(TENOR_A), video: { url: `${TENOR_A}/loop.mp4`, proxyURL: `${TENOR_A}/proxy.mp4` } };
    const channels = [
      fakeChannel('c1', [rawMessage(1, { embeds: [gifv] }), rawMessage(2, { authorId: 'b', gifFile: '555' })]),
    ];
    const backfill = createGifBackfill(
      wrongly({
        ...depsOf(fakeClient(channels)),
        hot: fakeHot(),
        store,
        describer,
        log: fakeLog(),
      })
    );

    await backfill.run(placeOfCommunity(backfill, 'g1'));
    const byId: Record<string, Untyped> = new Map(
      describer.calls[0].items.map((item: Record<string, Untyped>) => [item.itemId, item])
    );
    assert.equal(byId.get('1001#e0').animationUrl, `${TENOR_A}/proxy.mp4`, 'the gifv mp4 travels with the item');
    assert.equal(byId.get('1001#e0').source, 'embed');
    assert.equal(byId.get('1001#e0').url, `${TENOR_A}/proxy.png`, 'the still frame stays the fallback');
    assert.equal(byId.get('555').source, 'attachment', 'an attached .gif is its own animation');
    assert.equal(byId.get('555').url, 'https://cdn.discordapp.com/attachments/1/555/r.gif');
  });
});

test('gif backfill run: no describer describes nothing', async () => {
  await withStore(async (store: GifStore) => {
    const none = createGifBackfill(
      wrongly({
        ...depsOf(fakeClient(standardChannels())),
        hot: fakeHot(),
        store,
        log: fakeLog(),
      })
    );
    assert.equal(
      wrongly<{ described: number }>(await none.run(placeOfCommunity(none, 'g1'), { force: true })).described,
      0
    );
  });
});

// PR 7d: the messages read per channel are the constant 500, so the GIF sits in the oldest of 501.
test('gif backfill run: backfillMessages caps the messages read per channel', async () => {
  await withStore(async (store: GifStore) => {
    const rooms = [
      fakeChannel('c1', [
        rawMessage(0, { embeds: [tenorEmbed(TENOR_A)] }),
        ...Array.from({ length: 500 }, (_, n) => rawMessage(n + 1, { embeds: [tenorEmbed(TENOR_B, 'Salut')] })),
      ]),
    ];
    const backfill = createGifBackfill(
      wrongly({ ...depsOf(fakeClient(rooms)), hot: fakeHot(), store, log: fakeLog() })
    );

    const result = await backfill.run(placeOfCommunity(backfill, 'g1'));
    assert.deepEqual(result, { ok: true, channels: 1, messages: 500, gifs: 500, described: 0 });
    assert.deepEqual(countsByUrl(store), { [TENOR_B]: 500 });
  });
});

test('gif backfill run: refused while paused and while another run is in flight', async () => {
  await withStore(async (store: GifStore) => {
    const backfill = createGifBackfill(
      wrongly({
        ...depsOf(fakeClient(standardChannels())),
        hot: fakeHot(),
        store,
        log: fakeLog(),
      })
    );

    store.state.data.paused = true;
    assert.deepEqual(await backfill.run(placeOfCommunity(backfill, 'g1')), { ok: false, reason: 'paused' });
    store.state.data.paused = false;

    const first = backfill.run(placeOfCommunity(backfill, 'g1'));
    assert.equal(backfill.isRunning(), true);
    assert.deepEqual(await backfill.run(placeOfCommunity(backfill, 'g1'), { force: true }), {
      ok: false,
      reason: 'running',
    });
    assert.equal((await first).ok, true);
    assert.equal(backfill.isRunning(), false);
  });
});

test('gif backfill run: an unknown guild is skipped', async () => {
  await withStore(async (store: GifStore) => {
    const backfill = createGifBackfill(
      wrongly({
        ...depsOf(fakeClient(standardChannels())),
        hot: fakeHot(),
        store,
        log: fakeLog(),
      })
    );
    assert.deepEqual(await backfill.run('nope'), { ok: false, reason: 'no-place' });
  });
});

test('gif backfill startIfNeeded: runs once when the feature is on and nothing is stamped', async () => {
  await withStore(async (store: GifStore) => {
    const world = fakeClient(standardChannels());
    const backfill = createGifBackfill(wrongly({ ...depsOf(world), hot: fakeHot(), store, log: fakeLog() }));

    await backfill.startIfNeeded(placeOfCommunity(backfill, 'g1'));
    assert.equal(Object.keys(store.getGifs(placeOfCommunity(store, 'g1')).entries).length, 3);
    const fetches = world.asked('history').length;
    await backfill.startIfNeeded(placeOfCommunity(backfill, 'g1'));
    assert.equal(world.asked('history').length, fetches, 'stamped: never again at startup');
  });
});

test('gif backfill startIfNeeded: an error is logged, never thrown', async () => {
  await withStore(async (store: GifStore) => {
    const log = fakeLog();
    const reads = {
      conversations: () => Promise.reject(new Error('boom')),
    };
    const backfill = createGifBackfill(wrongly({ reads, iface: () => IFACE, hot: fakeHot(), store, log }));

    await backfill.startIfNeeded(placeOfCommunity(backfill, 'g1'));
    assert.ok(log.entries.some((e) => e.level === 'error' && e.message === 'gif-backfill: failed'));
    assert.equal(backfill.isRunning(), false);
  });
});

test('store setGifBackfill / resetGifCounts: the stamp is normalised and persisted, a reset keeps entries and handles', async () => {
  const { dir: memoryDir } = memDataDir();
  await (async (store: GifStore, dir: string) => {
    store.recordGifs(placeOfCommunity(store, 'g1'), [
      { id: 'm', ts: T0, placeId: 'c1', links: [{ id: 'm#e0', kind: 'gif', url: TENOR_A }] },
    ]);
    assert.deepEqual(
      store.setGifBackfill(placeOfCommunity(store, 'g1'), {
        at: '2026-09-30T00:00:00.000Z',
        channels: 2.7,
        messages: -1,
      }),
      {
        at: '2026-09-30T00:00:00.000Z',
        channels: 2,
        messages: 0,
      }
    );
    assert.equal(store.setGifBackfill(placeOfCommunity(store, 'g2'), wrongly({ at: 5 })), null);

    store.resetGifCounts(placeOfCommunity(store, 'g1'));
    store.flush();
    await wrongly<{ flushSettled(options: object): Promise<void> }>(store).flushSettled({});
    const onDisk = JSON.parse(readRaw(path.join(dir, 'guilds', 'g1', 'gifs.json')));
    assert.deepEqual(Object.keys(onDisk.entries), ['m#e0']);
    assert.equal(onDisk.entries['m#e0'].id, 'g1');
    assert.equal(onDisk.entries['m#e0'].count, 0);
    assert.equal(onDisk.entries['m#e0'].last, T0);
    assert.equal(onDisk.nextId, 2);
    assert.equal(
      wrongly<Untyped>(
        createStore({ dataDir: dir, memoryDb: MEMORY_OF.get(dir) }).getGifs(placeOfCommunity(store, 'g1')).entries[
          'm#e0'
        ]
      ).id,
      'g1',
      'a reset entry survives a restart'
    );
    assert.deepEqual(onDisk.backfill, { at: '2026-09-30T00:00:00.000Z', channels: 2, messages: 0 });
  })(wrongly<GifStore>(createStore({ dataDir: memoryDir, memoryDb: MEMORY_OF.get(memoryDir) })), memoryDir);
});
