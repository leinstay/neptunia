// Tests for src/memory/emoji-backfill.ts: the custom emoji history backfill, a history read through the interface,
// no LLM, that fills a root's `emojiUsage` at once and stamps `emojiBackfill`. A real store on a temp dir, the fake
// interface's reads.

import { placeOfRoot } from '../../../src/memory/addresses.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createEmojiBackfill } from '../../../src/memory/emoji-backfill.ts';
import { createStore } from '../../../src/memory/store.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { IFACE, SELF_ID, channel, message, rig } from '../../fixtures/reads-rig.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import type { Reads } from '../../../src/interface/reads.ts';
import { memoryAt } from '../../fixtures/store-kit.ts';

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

const T0 = Date.UTC(2026, 8, 1);

function withStore(fn: Untyped) {
  const dir = tempDir('nep-emoji-backfill-');
  return Promise.resolve()
    .then(() => fn(createStore(memoryAt(dir)), dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

/** The event of message `n` in `info`: `content` carries `<:name:id>` markup, which the interface reads into `emojis`. */
function rawMessage(info: Untyped, n: Untyped, { authorId = 'a', bot = false, content = 'hi' } = {}) {
  const event = message(info, String(1000 + n), T0 + n * 1000, content.replace(/<a?:(\w+):\d+>/g, ':$1:'), {
    authorId,
    bot,
  });
  event.message.emojis = [...content.matchAll(/<(a?):(\w+):(\d+)>/g)].map((m) => ({
    id: m[3],
    name: m[2],
    animated: m[1] === 'a',
  }));
  return event;
}

/** A chat and its history, oldest first; `readable: false` is one the persona may not read. */
function room(id: string, build: Untyped, { readable = true } = {}) {
  const info = channel(id, {
    permissions: { read: readable, send: readable, attach: readable, react: readable },
  });
  return { info, events: build(info) };
}

/** The fake interface holding `rooms`, with the core's reads over it. */
function worldOf(rooms: Untyped) {
  const world = rig();
  for (const { info, events } of rooms) {
    world.fake.seedChat(info);
    for (const event of events) world.fake.seedEvent(event);
  }
  return world;
}

/** What the backfill takes of the interface. */
const depsOf = (world: Untyped) => ({ reads: world.reads, iface: () => IFACE });

// The switch is code and the emoji measures are constants (the backfill reads 500 messages a channel).
function fakeHot() {
  return { config: { bot: {} } };
}

function fakeLog() {
  const entries: Array<Untyped> = [];
  const push = (level: Untyped) => (message: Untyped, fields: Untyped) => entries.push({ level, message, fields });
  return { entries, info: push('info'), warn: push('warn'), error: push('error') };
}

const KAPPA = '<:kappa:111>';
const OMEGA = '<a:omega:222>';

function standardRooms() {
  return [
    room('c1', (info: Untyped) => [
      rawMessage(info, 1, { content: `hello ${KAPPA} ${KAPPA}` }),
      rawMessage(info, 2, { authorId: 'b', content: `${KAPPA} ${OMEGA}` }),
      rawMessage(info, 3, { authorId: SELF_ID, content: `me ${KAPPA}` }),
      // A bot is a person to the persona, so its emoji count like a member's.
      rawMessage(info, 4, { authorId: 'otherBot', bot: true, content: `bot ${OMEGA}` }),
      rawMessage(info, 5, { content: 'no emoji here' }),
    ]),
    room('c2', (info: Untyped) => [rawMessage(info, 6, { authorId: 'c', content: `${OMEGA}` })]),
  ];
}

// An emoji and a sticker go by a stable name of the engine.
test("emoji backfill run: counts members' emoji over every readable channel, bots too, self skipped", async () => {
  await withStore(async (store: Untyped) => {
    const log = fakeLog();
    const world = worldOf([
      ...standardRooms(),
      room('c3', (info: Untyped) => [rawMessage(info, 7, { content: KAPPA })], { readable: false }),
    ]);
    // @ts-expect-error: createEmojiBackfill takes no `hot` dependency, so the key is ignored
    const backfill = createEmojiBackfill({ ...depsOf(world), hot: fakeHot(), store, log });

    const result = await backfill.run(placeOfRoot(backfill, 'g1'));
    assert.deepEqual(result, { ok: true, channels: 2, messages: 5, emoji: 5 });

    const usage = store.getPlace('g1').emojiUsage;
    assert.deepEqual(usage['111'], { count: 2, last: T0 + 2000 });
    assert.deepEqual(usage['222'], { count: 3, last: T0 + 6000 });
    assert.equal(
      world.asked('history').some((ref) => loose(ref).chatId === 'c3'),
      false,
      'a chat the persona may not read is never read'
    );

    const stamp = store.getPlace('g1').emojiBackfill;
    assert.equal(stamp.channels, 2);
    assert.equal(stamp.messages, 5);
    assert.ok(Number.isFinite(Date.parse(stamp.at)));
  });
});

test('emoji backfill run: a second run is a no-op and never double-counts', async () => {
  await withStore(async (store: Untyped) => {
    const log = fakeLog();
    const world = worldOf(standardRooms());
    // @ts-expect-error: createEmojiBackfill takes no `hot` dependency, so the key is ignored
    const backfill = createEmojiBackfill({ ...depsOf(world), hot: fakeHot(), store, log });

    await backfill.run(placeOfRoot(backfill, 'g1'));
    const fetchesAfterFirst = world.asked('history').length;
    const second = await backfill.run(placeOfRoot(backfill, 'g1'));

    assert.deepEqual(second, { ok: false, reason: 'done' });
    assert.equal(store.getPlace('g1').emojiUsage['111'].count, 2);
    assert.equal(world.asked('history').length, fetchesAfterFirst, 'no history read on the no-op');
  });
});

// An emoji and a sticker go by a stable name of the engine.
test("emoji backfill run: a first run over a ranking with counts ends with the history's counts alone", async () => {
  await withStore(async (store: Untyped) => {
    // What the analyzer counted since the feature went live: messages the history window also holds.
    store.recordEmojiUsage('g1', [
      { id: '1001', ts: T0 + 1000, emojis: [{ id: '111', name: 'kappa' }] },
      { id: '1006', ts: T0 + 6000, emojis: [{ id: '222', name: 'omega' }] },
      { id: 'old', ts: T0 - 1000, emojis: [{ id: '333', name: 'gone' }] },
    ]);
    const backfill = createEmojiBackfill({
      ...depsOf(worldOf(standardRooms())),
      // @ts-expect-error: createEmojiBackfill takes no `hot` dependency, so the key is ignored
      hot: fakeHot(),
      store,
      log: fakeLog(),
    });

    const result = await backfill.run(placeOfRoot(backfill, 'g1'));
    assert.deepEqual(result, { ok: true, channels: 2, messages: 5, emoji: 5 });
    assert.deepEqual(store.getPlace('g1').emojiUsage, {
      111: { count: 2, last: T0 + 2000 },
      222: { count: 3, last: T0 + 6000 },
    });
  });
});

// The messages read per channel are the constant 500, so the emoji sits in the oldest of 501.
test('emoji backfill run: backfillMessages caps the messages read per channel', async () => {
  await withStore(async (store: Untyped) => {
    const rooms = [
      room('c1', (info: Untyped) => [
        rawMessage(info, 0, { content: `hello ${KAPPA}` }),
        ...Array.from({ length: 500 }, (_, n) => rawMessage(info, n + 1, { content: 'no emoji here' })),
      ]),
    ];
    // @ts-expect-error: createEmojiBackfill takes no `hot` dependency, so the key is ignored
    const backfill = createEmojiBackfill({ ...depsOf(worldOf(rooms)), hot: fakeHot(), store, log: fakeLog() });

    const result = await backfill.run(placeOfRoot(backfill, 'g1'));
    assert.deepEqual(result, { ok: true, channels: 1, messages: 500, emoji: 0 });
    assert.equal(store.getPlace('g1').emojiUsage['111'], undefined);
  });
});

test('emoji backfill run: refused while paused and while another run is in flight', async () => {
  await withStore(async (store: Untyped) => {
    const backfill = createEmojiBackfill({
      ...depsOf(worldOf(standardRooms())),
      // @ts-expect-error: createEmojiBackfill takes no `hot` dependency, so the key is ignored
      hot: fakeHot(),
      store,
      log: fakeLog(),
    });

    const { data } = store.state;
    data.paused = true;
    assert.deepEqual(await backfill.run(placeOfRoot(backfill, 'g1')), { ok: false, reason: 'paused' });
    data.paused = false;

    const first = backfill.run(placeOfRoot(backfill, 'g1'));
    assert.equal(backfill.isRunning(), true);
    assert.deepEqual(await backfill.run(placeOfRoot(backfill, 'g1')), {
      ok: false,
      reason: 'running',
    });
    assert.equal((await first).ok, true);
    assert.equal(backfill.isRunning(), false);
  });
});

test('emoji backfill run: an unknown root is skipped', async () => {
  await withStore(async (store: Untyped) => {
    const backfill = createEmojiBackfill({
      ...depsOf(worldOf(standardRooms())),
      // @ts-expect-error: createEmojiBackfill takes no `hot` dependency, so the key is ignored
      hot: fakeHot(),
      store,
      log: fakeLog(),
    });
    assert.deepEqual(await backfill.run('nope'), { ok: false, reason: 'no-place' });
  });
});

test('emoji backfill startIfNeeded: runs once when the feature is on and nothing is stamped', async () => {
  await withStore(async (store: Untyped) => {
    const world = worldOf(standardRooms());
    // @ts-expect-error: createEmojiBackfill takes no `hot` dependency, so the key is ignored
    const backfill = createEmojiBackfill({ ...depsOf(world), hot: fakeHot(), store, log: fakeLog() });

    await backfill.startIfNeeded(placeOfRoot(backfill, 'g1'));
    assert.equal(store.getPlace('g1').emojiUsage['111'].count, 2);
    const fetches = world.asked('history').length;
    await backfill.startIfNeeded(placeOfRoot(backfill, 'g1'));
    assert.equal(world.asked('history').length, fetches, 'stamped: never again at startup');
  });
});

test('emoji backfill startIfNeeded: an error is logged, never thrown', async () => {
  await withStore(async (store: Untyped) => {
    const log = fakeLog();
    // The stand-in holds only the one read that the backfill makes first.
    const reads = {
      chats: () => Promise.reject(new Error('boom')),
    } as unknown as Reads;
    // @ts-expect-error: createEmojiBackfill takes no `hot` dependency, so the key is ignored
    const backfill = createEmojiBackfill({ reads, iface: () => IFACE, hot: fakeHot(), store, log });

    await backfill.startIfNeeded(placeOfRoot(backfill, 'g1'));
    assert.ok(log.entries.some((e) => e.level === 'error' && e.message === 'emoji-backfill: failed'));
    assert.equal(backfill.isRunning(), false);
  });
});
