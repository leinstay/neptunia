// The owner's GIF recache (src/memory/gif-recache.js): which library
// entries a run re-describes and in what order, which one-frame captions of
// the media cache it drops, the caption counts of `/nep gifs status`, and the
// run itself on a real store, a fake describer and a fake discord.js client:
// the per-run cap, watched entries skipped, one run at a time, the pause
// respected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createGifRecache, gifCaptionCounts, gifCaptionState, gifFormatCounts, isPictureKey, oneFrameGifKeys, pickStaleDescriptions, recacheQueue, recordFinder, snowflakeMs } from '../src/memory/gif-recache.js';
import { createStore } from '../src/memory/store.js';
import { createDiscordInterface } from '../src/interface/discord.js';
import { tempDir } from './fixtures/tmp.js';

// The Discord interface's capabilities object, as src/index.js injects it.
const DISCORD = createDiscordInterface().capabilities;

const T0 = Date.UTC(2026, 8, 1);
const TENOR = (n) => `https://tenor.com/view/danse-${n}`;

function withStore(fn) {
  const dir = tempDir('nep-gif-recache-');
  return Promise.resolve()
    .then(() => fn(createStore({ dataDir: dir })))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

/** A library entry for a tenor GIF `n`, last seen in message `m<n>` of channel c1. */
function linkEntry(n, overrides = {}) {
  return {
    id: `g${n}`,
    kind: 'link',
    url: TENOR(n),
    site: 'Tenor',
    itemId: `m${n}#e0`,
    messageId: `m${n}`,
    channelId: 'c1',
    count: 1,
    last: T0,
    firstSeen: T0,
    ...overrides,
  };
}

function library(entries) {
  return { nextId: entries.length + 1, entries: Object.fromEntries(entries.map((entry) => [entry.itemId, entry])), backfill: null };
}

// --- pure helpers ------------------------------------------------------------

test('gifCaptionState: watched, failed, one-frame or none', () => {
  assert.equal(gifCaptionState({ text: 'a man runs', ts: 1, watched: true }), 'watched');
  assert.equal(gifCaptionState({ text: 'a still', ts: 1, gif: true, watchFailed: 5 }), 'failed');
  assert.equal(gifCaptionState({ miss: true, ts: 1, watchFailed: 5 }), 'failed');
  assert.equal(gifCaptionState({ text: 'a still', ts: 1 }), 'one-frame');
  assert.equal(gifCaptionState({ miss: true, ts: 1 }), 'none');
  assert.equal(gifCaptionState(undefined), 'none');
});

test('gifCaptionCounts: counts the library entries by their caption state', () => {
  const gifs = library([linkEntry(1), linkEntry(2), linkEntry(3), linkEntry(4), linkEntry(5)]);
  const cache = {
    'm1#e0': { text: 'watched', ts: 1, watched: true },
    'm2#e0': { text: 'a still', ts: 1 },
    'm3#e0': { text: 'a still', ts: 1, watchFailed: 3 },
    'm4#e0': { miss: true, ts: 1 },
    'x#e0': { text: 'not in the library', ts: 1 },
  };
  assert.deepEqual(gifCaptionCounts(gifs, cache), { watched: 1, 'one-frame': 1, failed: 1, none: 2 });
});

test('gifFormatCounts: watched with fields, watched in the old format, unwatched', () => {
  const gifs = library([linkEntry(1), linkEntry(2), linkEntry(3), linkEntry(4), linkEntry(5)]);
  const cache = {
    'm1#e0': { text: 'watched', reaction: '', action: 'watched', screen: '', ts: 1, watched: true },
    'm2#e0': { text: 'watched', ts: 1, watched: true },
    'm3#e0': { text: 'a still', ts: 1 },
    'm4#e0': { text: 'a still', ts: 1, watchFailed: 3 },
  };
  assert.deepEqual(gifFormatCounts(gifs, cache), { fields: 1, oldFormat: 1, unwatched: 3 });
});

test('recacheQueue: an old-format watched entry (no reaction field) is queued with the rest, oldest first', () => {
  const gifs = library([linkEntry(1), linkEntry(2), linkEntry(3), linkEntry(4)]);
  const cache = {
    'm1#e0': { text: 'watched long ago', ts: 50, watched: true, gif: true },
    'm2#e0': { text: 'watched', reaction: 'agreement', action: 'watched', screen: '', ts: 10, watched: true, gif: true },
    'm3#e0': { text: 'a still', ts: 100 },
    'm4#e0': { text: 'watched lately', ts: 500, watched: true, gif: true },
  };
  assert.deepEqual(recacheQueue(gifs, cache, 10).map((entry) => entry.id), ['g1', 'g3', 'g4'], 'the three-field entry is done');
  assert.deepEqual(recacheQueue(gifs, cache, 2).map((entry) => entry.id), ['g1', 'g3'], 'under the same per-run cap');
  const failed = { ...cache, 'm1#e0': { ...cache['m1#e0'], watchFailed: 900 } };
  assert.deepEqual(recacheQueue(gifs, failed, 10).map((entry) => entry.id), ['g3', 'g4', 'g1'], 'a failed re-watch goes to the back');
});

test('gif recache: old-format watched captions migrate over runs and the describer is asked for them', async () => {
  await withStore(async (store) => {
    seed(store, [linkEntry(1), linkEntry(2)], {
      'm1#e0': { text: 'watched before', ts: 200, watched: true, gif: true },
      'm2#e0': { text: 'watched before', ts: 100, watched: true, gif: true },
    });
    const describer = fakeDescriber(store);
    const log = silentLog();
    const recache = createGifRecache({ discord: DISCORD, hot: fakeHot({ recachePerRun: 1 }), store, client: fakeClient([rawGifMessage(1), rawGifMessage(2)]), describer, log });
    assert.deepEqual(recache.start('g1'), { ok: true, dropped: 0, queued: 1 });
    await recache.waitIdle();
    assert.deepEqual(recache.start('g1'), { ok: true, dropped: 0, queued: 1 });
    await recache.waitIdle();
    assert.deepEqual(recache.start('g1'), { ok: true, dropped: 0, queued: 0 });
    await recache.waitIdle();
    assert.deepEqual(describer.calls.map((c) => c.item.itemId), ['m2#e0', 'm1#e0'], 'oldest first, one per run');
    const started = log.entries.filter((entry) => entry.message === 'gif-recache: started').map((entry) => entry.fields);
    assert.deepEqual(started[0], { dropped: 0, queued: 1 }, 'counts only');
  });
});

test('recacheQueue: never-described first, then oldest-described; watched skipped; capped', () => {
  const gifs = library([linkEntry(1), linkEntry(2), linkEntry(3), linkEntry(4), linkEntry(5)]);
  const cache = {
    'm1#e0': { text: 'a still', ts: 300 },
    'm2#e0': { text: 'watched', reaction: '', action: 'watched', screen: '', ts: 1, watched: true },
    'm3#e0': { text: 'a still', ts: 100 },
    'm4#e0': { text: 'a still', ts: 50, watchFailed: 400 },
  };
  assert.deepEqual(recacheQueue(gifs, cache, 10).map((entry) => entry.id), ['g5', 'g3', 'g1', 'g4']);
  assert.deepEqual(recacheQueue(gifs, cache, 2).map((entry) => entry.id), ['g5', 'g3']);
  assert.deepEqual(recacheQueue(gifs, cache, 0), []);
  assert.equal(recacheQueue(gifs, cache, 1)[0].key, 'm5#e0');
});

test('oneFrameGifKeys: one-frame GIF captions outside the library; never pictures, videos, watched or library ones', () => {
  const gifs = library([linkEntry(1)]);
  const cache = {
    'm1#e0': { text: 'library still', ts: 1 },
    'm9#e0': { text: 'embed still', ts: 1 },
    'm9#e1': { text: 'embed watched', ts: 1, watched: true, gif: true },
    'm8#e0': { miss: true, ts: 1 },
    '555': { text: 'attached gif still', ts: 1, gif: true },
    '556': { text: 'a picture', ts: 1 },
    'link:abc': { text: 'a thumbnail', ts: 1 },
    'video:777': { text: 'a video', ts: 1, watched: true },
    'video:m7#e0': { text: 'never a gif caption', ts: 1 },
  };
  assert.deepEqual(oneFrameGifKeys(cache, gifs).sort(), ['555', 'm9#e0']);
});

// --- the run -------------------------------------------------------------------

/** A raw discord.js message carrying one tenor gifv embed `n`. */
function rawGifMessage(n) {
  return {
    id: `m${n}`,
    channelId: 'c1',
    author: { id: 'u1', bot: false, username: 'u1' },
    cleanContent: '',
    createdTimestamp: T0,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
    messageSnapshots: new Map(),
    embeds: [
      {
        url: TENOR(n),
        provider: { name: 'Tenor' },
        thumbnail: { url: `${TENOR(n)}/still.png` },
        video: { url: `${TENOR(n)}/loop.mp4` },
      },
    ],
  };
}

/** A client whose channel c1 serves `messages` by id; any other id throws like a deleted message. */
function fakeClient(messages) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const channel = {
    messages: {
      fetch: async (id) => {
        if (!byId.has(id)) throw new Error('Unknown Message');
        return byId.get(id);
      },
    },
  };
  return { user: { id: 'self' }, channels: { fetch: async (id) => (id === 'c1' ? channel : null) } };
}

/** A describer whose watchGif follows `outcome(item)` (watched by default) and writes the watched caption. */
function fakeDescriber(store, { outcome, blocker = null, gate } = {}) {
  const calls = [];
  return {
    calls,
    gifWatchBlocker: () => blocker,
    async watchGif(guildId, item, opts) {
      calls.push({ guildId, item, opts });
      if (gate) await gate();
      const result = outcome ? outcome(item) : { state: 'watched', text: `watched ${item.itemId}` };
      if (result.state === 'watched') {
        store.getMediaCache(guildId)[item.itemId] = { text: result.text, reaction: '', action: result.text, screen: '', ts: T0, watched: true, gif: true };
      }
      return result;
    },
  };
}

function fakeHot(gifs = {}) {
  return { config: { media: { embedTextChars: 200 }, gifs: { recachePerRun: 50, ...gifs } } };
}

function silentLog() {
  const entries = [];
  const push = (level) => (message, fields) => entries.push({ level, message, fields });
  return { entries, info: push('info'), warn: push('warn'), error: push('error') };
}

function seed(store, entries, cache = {}) {
  store.recordGifs('g1', []);
  const gifs = store.getGifs('g1');
  Object.assign(gifs, library(entries));
  Object.assign(store.getMediaCache('g1'), cache);
}

test('gif recache: drops one-frame captions at once, then watches at most recachePerRun entries, oldest first, from a fresh read', async () => {
  await withStore(async (store) => {
    seed(store, [linkEntry(1), linkEntry(2), linkEntry(3)], {
      'm1#e0': { text: 'a still', ts: 300 },
      'm2#e0': { text: 'a still', ts: 100 },
      'x9#e0': { text: 'a stray still', ts: 1, gif: true },
      '556': { text: 'a picture', ts: 1 },
    });
    const describer = fakeDescriber(store);
    const recache = createGifRecache({
      discord: DISCORD,
      hot: fakeHot({ recachePerRun: 2 }),
      store,
      client: fakeClient([rawGifMessage(1), rawGifMessage(2), rawGifMessage(3)]),
      describer,
      log: silentLog(),
    });

    const started = recache.start('g1');
    assert.deepEqual(started, { ok: true, dropped: 1, queued: 2 });
    assert.equal(store.getMediaCache('g1')['x9#e0'], undefined, 'the stray one-frame caption is dropped, not re-described');
    assert.equal(store.getMediaCache('g1')['556'].text, 'a picture');
    assert.equal(recache.isRunning(), true);
    await recache.waitIdle();
    assert.equal(recache.isRunning(), false);

    assert.deepEqual(describer.calls.map((c) => c.item.itemId), ['m3#e0', 'm2#e0'], 'never described first, then the oldest');
    const [first] = describer.calls;
    assert.equal(first.item.kind, 'gif');
    assert.equal(first.item.animationUrl, `${TENOR(3)}/loop.mp4`, 'the animation comes from the message read again');
    assert.equal(first.opts, undefined, 'every describer request counts: no option to say so');
    assert.equal(store.getMediaCache('g1')['m1#e0'].text, 'a still', 'past the cap: left for the next run');
  });
});

test('gif recache: a second run skips what the first watched and continues with the rest', async () => {
  await withStore(async (store) => {
    seed(store, [linkEntry(1), linkEntry(2), linkEntry(3)]);
    const describer = fakeDescriber(store);
    const recache = createGifRecache({
      discord: DISCORD,
      hot: fakeHot({ recachePerRun: 2 }),
      store,
      client: fakeClient([rawGifMessage(1), rawGifMessage(2), rawGifMessage(3)]),
      describer,
      log: silentLog(),
    });
    recache.start('g1');
    await recache.waitIdle();
    assert.deepEqual(recache.start('g1'), { ok: true, dropped: 0, queued: 1 });
    await recache.waitIdle();
    assert.deepEqual(describer.calls.map((c) => c.item.itemId), ['m1#e0', 'm2#e0', 'm3#e0']);
    assert.deepEqual(gifCaptionCounts(store.getGifs('g1'), store.getMediaCache('g1')), { watched: 3, 'one-frame': 0, failed: 0, none: 0 });
    assert.deepEqual(recache.start('g1'), { ok: true, dropped: 0, queued: 0 });
    await recache.waitIdle();
  });
});

test('gif recache: a GIF whose message is gone still goes to the describer, which fails it as source', async () => {
  await withStore(async (store) => {
    seed(store, [linkEntry(1)]);
    const describer = fakeDescriber(store, { outcome: (item) => (item.animationUrl ? { state: 'watched', text: 'x' } : { state: 'failed', reason: 'source' }) });
    const log = silentLog();
    const recache = createGifRecache({ discord: DISCORD, hot: fakeHot(), store, client: fakeClient([]), describer, log });
    recache.start('g1');
    await recache.waitIdle();
    assert.deepEqual(describer.calls[0].item, { itemId: 'm1#e0', kind: 'gif' });
    const done = log.entries.find((e) => e.message === 'gif-recache: done');
    assert.deepEqual(done.fields, { watched: 0, failed: 1, queued: 1, stopped: null });
  });
});

test('gif recache: one run at a time', async () => {
  await withStore(async (store) => {
    seed(store, [linkEntry(1)]);
    let release;
    const gate = () => new Promise((resolve) => {
      release = resolve;
    });
    const recache = createGifRecache({
      discord: DISCORD,
      hot: fakeHot(),
      store,
      client: fakeClient([rawGifMessage(1)]),
      describer: fakeDescriber(store, { gate }),
      log: silentLog(),
    });
    assert.equal(recache.start('g1').ok, true);
    assert.deepEqual(recache.start('g1'), { ok: false, reason: 'running' });
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    release();
    await recache.waitIdle();
    assert.equal(recache.start('g1').ok, true);
    await recache.waitIdle();
  });
});

test('gif recache: refused while paused, without a describer or while GIFs are not watched -- nothing dropped', async () => {
  await withStore(async (store) => {
    seed(store, [linkEntry(1)], { 'x9#e0': { text: 'a stray still', ts: 1, gif: true } });
    const base = { hot: fakeHot(), store, client: fakeClient([]), log: silentLog() };

    assert.deepEqual(createGifRecache({ discord: DISCORD, ...base }).start('g1'), { ok: false, reason: 'unavailable' });
    for (const blocker of ['off', 'video-off', 'no-prompt']) {
      assert.deepEqual(createGifRecache({ discord: DISCORD, ...base, describer: fakeDescriber(store, { blocker }) }).start('g1'), { ok: false, reason: blocker });
    }
    store.state.data.paused = true;
    assert.deepEqual(createGifRecache({ discord: DISCORD, ...base, describer: fakeDescriber(store) }).start('g1'), { ok: false, reason: 'paused' });
    assert.equal(store.getMediaCache('g1')['x9#e0'].text, 'a stray still');
  });
});

test('gif recache: a run stops before the next GIF once paused or a daily rail is spent', async () => {
  for (const stop of ['paused', 'daily']) {
    await withStore(async (store) => {
      seed(store, [linkEntry(1), linkEntry(2), linkEntry(3)]);
      const describer = fakeDescriber(store, {
        outcome: (item) => {
          if (stop === 'paused') store.state.data.paused = true;
          if (stop === 'daily') return { state: 'unavailable', reason: 'daily' };
          return { state: 'watched', text: `watched ${item.itemId}` };
        },
      });
      const log = silentLog();
      const recache = createGifRecache({
        discord: DISCORD,
        hot: fakeHot(),
        store,
        client: fakeClient([rawGifMessage(1), rawGifMessage(2), rawGifMessage(3)]),
        describer,
        log,
      });
      recache.start('g1');
      await recache.waitIdle();
      assert.equal(describer.calls.length, 1, `${stop}: only the GIF in flight`);
      assert.equal(log.entries.find((e) => e.message === 'gif-recache: done').fields.stopped, stop);
    });
  }
});

// --- the media recache (startMedia) ---------------------------------------------

const NOW = Date.UTC(2026, 9, 15, 12);
const DAY = 24 * 60 * 60 * 1000;
const MODELS = { vision: 'x/new-vision', video: 'x/new-video' };

/** A Discord snowflake id created at `ms` (sequence `seq`). */
function snowflake(ms, seq = 0) {
  return String((BigInt(ms - 1_420_070_400_000) << 22n) + BigInt(seq));
}

test('snowflakeMs: the creation time of a snowflake; null for anything else', () => {
  assert.equal(snowflakeMs(snowflake(NOW, 5)), NOW);
  assert.equal(snowflakeMs('m1'), null);
  assert.equal(snowflakeMs('123'), null);
  assert.equal(snowflakeMs(undefined), null);
});

test('isPictureKey: picture descriptions only, never video summaries, answers or web entries', () => {
  for (const key of [snowflake(NOW), `${snowflake(NOW)}#e0`, 'm1#e2', 'emoji:42', 'sticker:42', 'link:abcdef', 'video:url:abcdef']) {
    assert.equal(isPictureKey(key), true, key);
  }
  for (const key of [`video:${snowflake(NOW)}`, 'video:video:url:abcdef', 'video:m7#e0', 'image:1:q:abc', 'gif:m1#e0:q:abc', 'video:1:q:abc', 'read:link:abc', 'search:abc', 'a1']) {
    assert.equal(isPictureKey(key), false, key);
  }
});

test('pickStaleDescriptions: by last use within the days, older models only, most recent first', () => {
  const cache = {
    old: { text: 'x', ts: NOW - 10 * DAY },
    [snowflake(NOW - 2 * DAY)]: { text: 'a photo', ts: NOW - 20 * DAY, usedAt: NOW - 2 * DAY },
    'emoji:1': { text: 'a grin', ts: NOW - DAY },
    'emoji:2': { text: 'a wink', ts: NOW - 3 * DAY, describedAt: NOW - 3 * DAY, model: 'x/new-vision' },
    'emoji:3': { text: 'a nod', ts: NOW - 8 * DAY },
    'm1#e0': { text: 'a dance', ts: NOW - 4 * DAY, watched: true, gif: true, model: 'x/new-vision' },
    'm2#e0': { text: 'a jump', ts: NOW - 4 * DAY, watched: true, gif: true, model: 'x/new-video' },
    'link:aa': { miss: true, ts: NOW },
    'video:1': { text: 'a video', ts: NOW, watched: true },
  };
  assert.deepEqual(pickStaleDescriptions(cache, { nowMs: NOW, days: 7, cutoffMs: null, models: MODELS }), ['emoji:1', snowflake(NOW - 2 * DAY), 'm1#e0']);
  assert.deepEqual(pickStaleDescriptions(cache, { nowMs: NOW, days: 9, cutoffMs: null, models: MODELS }), ['emoji:1', snowflake(NOW - 2 * DAY), 'm1#e0', 'emoji:3']);
});

test('pickStaleDescriptions: with media.recacheBefore set, entries described at or after it are skipped', () => {
  const cutoffMs = NOW - 5 * DAY;
  const cache = {
    'emoji:1': { text: 'a', ts: NOW - DAY, describedAt: cutoffMs, model: 'x/older' },
    'emoji:2': { text: 'b', ts: NOW - DAY, describedAt: cutoffMs - 1, model: 'x/older' },
    'emoji:3': { text: 'c', ts: NOW - DAY },
    'emoji:4': { text: 'd', ts: NOW - DAY, describedAt: cutoffMs - 1, model: 'x/new-vision' },
  };
  assert.deepEqual(pickStaleDescriptions(cache, { nowMs: NOW, days: 7, cutoffMs, models: MODELS }).sort(), ['emoji:2', 'emoji:3']);
});

test('recordFinder: a gif embed by its message, an attachment by its upload time, an undated key within the window', () => {
  const upload = NOW - 3 * DAY;
  const attachment = snowflake(upload);
  const embedMessage = snowflake(NOW - 40 * DAY);
  const line = (messageId, occurredAt, extra = {}) => ({ kind: 'seen', messageId, occurredAt: new Date(occurredAt).toISOString(), scope: { channel: 'c1' }, media: ['image'], ...extra });

  const dated = recordFinder([attachment, `${embedMessage}#e0`], NOW - 7 * DAY);
  assert.ok(dated.fromMs <= NOW - 40 * DAY, 'reads back to the oldest dated key');
  assert.equal(dated.matches(line(embedMessage, NOW - 40 * DAY)), true);
  assert.equal(dated.matches(line(snowflake(upload + 60_000), upload + 60_000)), true, 'sent a minute after the upload');
  assert.equal(dated.matches(line(snowflake(upload + 3_600_000), upload + 3_600_000)), false, 'an hour later');
  assert.equal(dated.matches(line(snowflake(NOW - DAY), NOW - DAY)), false, 'no undated key: the window alone is not enough');
  assert.equal(dated.matches(line(embedMessage, NOW - 40 * DAY, { media: [] })), false, 'no media');
  assert.equal(dated.matches(line(embedMessage, NOW - 40 * DAY, { kind: 'deleted' })), false);

  const undated = recordFinder(['link:aa'], NOW - 7 * DAY);
  assert.equal(undated.fromMs, NOW - 7 * DAY);
  assert.equal(undated.matches(line(snowflake(NOW - DAY), NOW - DAY)), true);
  assert.equal(undated.matches(line(snowflake(NOW - 8 * DAY), NOW - 8 * DAY)), false);
});

/** A raw discord.js message in channel c1 with one attached png `attachmentId`. */
function rawPictureMessage(id, attachmentId) {
  return {
    id,
    channelId: 'c1',
    author: { id: 'u1', bot: false, username: 'u1' },
    cleanContent: '',
    createdTimestamp: snowflakeMs(id) ?? T0,
    reference: null,
    attachments: new Map([[attachmentId, { id: attachmentId, contentType: 'image/png', name: 'p.png', url: `https://cdn.discordapp.com/attachments/1/${attachmentId}/p.png`, width: 64, height: 64 }]]),
    stickers: new Map(),
    messageSnapshots: new Map(),
    embeds: [],
  };
}

/** A record whose iterate yields `lines` from `from` on, as src/memory/record.js does. */
function fakeRecord(lines) {
  return {
    async *iterate(guildId, { from = null } = {}) {
      const fromMs = from ? Date.parse(from) : -Infinity;
      for (const line of lines) if (Date.parse(line.occurredAt) >= fromMs) yield line;
    },
  };
}

/** A media describer: redescribe takes `costMs` of the clock and follows `outcome(item)` (done by default). */
function fakeMediaDescriber(clock, { outcome, costMs = 0, blocker = null } = {}) {
  const calls = [];
  return {
    calls,
    pictureBlocker: () => blocker,
    async redescribe(guildId, item) {
      calls.push({ guildId, item, at: clock.at });
      clock.at += costMs;
      return outcome ? outcome(item) : { state: 'done' };
    },
  };
}

function mediaHot(media = {}) {
  return { config: { media: { embedTextChars: 200, recacheIntervalMs: 3000, ...media }, gifs: { recachePerRun: 50 }, models: { base: { vision: MODELS.vision, video: MODELS.video } } } };
}

/** A clock and a sleep that moves it, recording every wait. */
function fakeTime(start = NOW) {
  const clock = { at: start, sleeps: [] };
  clock.now = () => clock.at;
  clock.sleep = async (ms) => {
    clock.sleeps.push(ms);
    clock.at += ms;
  };
  return clock;
}

test('media recache: emoji from their id, a library GIF from its message, an attachment through the record; counts logged', async () => {
  await withStore(async (store) => {
    const upload = NOW - 2 * DAY;
    const attachmentId = snowflake(upload, 1);
    const messageId = snowflake(upload + 5_000, 2);
    seed(store, [linkEntry(1)], {
      'emoji:77': { text: 'a grin', ts: NOW - DAY },
      'm1#e0': { text: 'a dance', ts: NOW - DAY, watched: true, gif: true },
      [attachmentId]: { text: 'a photo', ts: NOW - DAY },
      [snowflake(upload, 9)]: { text: 'nowhere to be found', ts: NOW - DAY },
      'emoji:78': { text: 'current', ts: NOW - DAY, describedAt: NOW - DAY, model: MODELS.vision },
    });
    const clock = fakeTime();
    const describer = fakeMediaDescriber(clock);
    const log = silentLog();
    const record = fakeRecord([
      { kind: 'seen', messageId, occurredAt: new Date(upload + 5_000).toISOString(), scope: { channel: 'c1' }, media: ['image'] },
    ]);
    const recache = createGifRecache({
      discord: DISCORD,
      hot: mediaHot(),
      store,
      client: fakeClient([rawGifMessage(1), rawPictureMessage(messageId, attachmentId)]),
      describer,
      record,
      now: clock.now,
      sleep: clock.sleep,
      log,
    });

    assert.deepEqual(recache.startMedia('g1', { days: 7 }), { ok: true, picked: 4, days: 7 });
    assert.equal(recache.isRunning(), true);
    await recache.waitIdle();

    assert.deepEqual(describer.calls.map((c) => c.item.itemId), ['emoji:77', 'm1#e0', attachmentId]);
    const [emoji, gif, picture] = describer.calls.map((c) => c.item);
    assert.equal(emoji.kind, 'emoji');
    assert.match(emoji.url, /emojis\/77\./);
    assert.equal(gif.animationUrl, `${TENOR(1)}/loop.mp4`);
    assert.equal(picture.kind, 'image');
    const done = log.entries.find((e) => e.message === 'media: recached');
    assert.deepEqual(done.fields, { picked: 4, done: 3, failed: 0, unlocated: 1, stopped: null });
  });
});

test('media recache: descriptions are paced media.recacheIntervalMs apart on the injected clock', async () => {
  await withStore(async (store) => {
    seed(store, [], {
      'emoji:1': { text: 'a', ts: NOW - DAY },
      'emoji:2': { text: 'b', ts: NOW - DAY },
      'emoji:3': { text: 'c', ts: NOW - DAY },
    });
    const clock = fakeTime();
    const describer = fakeMediaDescriber(clock, { costMs: 1000 });
    const recache = createGifRecache({ discord: DISCORD, hot: mediaHot({ recacheIntervalMs: 3000 }), store, client: fakeClient([]), describer, now: clock.now, sleep: clock.sleep, log: silentLog() });
    recache.startMedia('g1', {});
    await recache.waitIdle();
    assert.deepEqual(clock.sleeps, [2000, 2000], 'the time a request took counts toward the pause');
    assert.deepEqual(describer.calls.map((c) => c.at - NOW), [0, 3000, 6000]);
  });
});

test('media recache: a spent daily request cap stops the run; a failure is counted and the run goes on', async () => {
  await withStore(async (store) => {
    seed(store, [], {
      'emoji:1': { text: 'a', ts: NOW - DAY },
      'emoji:2': { text: 'b', ts: NOW - 2 * DAY },
      'emoji:3': { text: 'c', ts: NOW - 3 * DAY },
    });
    const clock = fakeTime();
    const outcomes = [{ state: 'failed' }, { state: 'unavailable', reason: 'daily-cap' }, { state: 'done' }];
    const describer = fakeMediaDescriber(clock, { outcome: () => outcomes.shift() });
    const log = silentLog();
    const recache = createGifRecache({ discord: DISCORD, hot: mediaHot(), store, client: fakeClient([]), describer, now: clock.now, sleep: clock.sleep, log });
    recache.startMedia('g1', { days: 7 });
    await recache.waitIdle();
    assert.equal(describer.calls.length, 2);
    assert.deepEqual(log.entries.find((e) => e.message === 'media: recached').fields, { picked: 3, done: 0, failed: 1, unlocated: 0, stopped: 'daily-cap' });
  });
});

test('media recache: refused while running (either run), paused, without a describer or with pictures off', async () => {
  await withStore(async (store) => {
    seed(store, [linkEntry(1)], { 'emoji:1': { text: 'a', ts: NOW - DAY } });
    const clock = fakeTime();
    const base = { hot: mediaHot(), store, client: fakeClient([rawGifMessage(1)]), now: clock.now, sleep: clock.sleep, log: silentLog() };
    let release;
    const gate = () => new Promise((resolve) => {
      release = resolve;
    });
    const both = { ...fakeDescriber(store, { gate }), ...fakeMediaDescriber(clock) };
    const busy = createGifRecache({ discord: DISCORD, ...base, describer: both });
    assert.equal(busy.start('g1').ok, true);
    assert.deepEqual(busy.startMedia('g1', {}), { ok: false, reason: 'running' });
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    release();
    await busy.waitIdle();

    assert.deepEqual(createGifRecache({ discord: DISCORD, ...base }).startMedia('g1', {}), { ok: false, reason: 'unavailable' });
    assert.deepEqual(createGifRecache({ discord: DISCORD, ...base, describer: fakeMediaDescriber(clock, { blocker: 'off' }) }).startMedia('g1', {}), { ok: false, reason: 'off' });
    store.state.data.paused = true;
    assert.deepEqual(createGifRecache({ discord: DISCORD, ...base, describer: fakeMediaDescriber(clock) }).startMedia('g1', {}), { ok: false, reason: 'paused' });
  });
});
