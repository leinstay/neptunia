// Tests for src/memory/update.ts: the live observer that feeds the GIF library and the custom emoji usage of a
// place from each message it sees. The GIF section runs a store on a temporary data directory, the emoji section a
// store on a fresh test memory database. No real data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { placeOfRoot } from '../../../src/memory/addresses.ts';
import { EMOJI_STORE_MAX } from '../../../src/memory/emoji-usage.ts';
import { GIF_STORE_MAX } from '../../../src/memory/gifs.ts';
import { createStore } from '../../../src/memory/store.ts';
import { createMemoryUpdater } from '../../../src/memory/update.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { labels } from '../../fixtures/labels.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { present, wrongly } from '../../fixtures/loose-types.ts';
import { openTestMemory } from '../../fixtures/memory-db/service.ts';
import { memoryAt } from '../../fixtures/store-kit.ts';
import { tempDir } from '../../fixtures/tmp.ts';

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
    content: '',
    ts: T0,
    replyToId: null,
    attachments: [],
    links: [],
    stickers: [],
    emojis: [],
    ...overrides,
  };
}

// ---- GIFs -------------------------------------------------------------------

const GIFS_TENOR = 'https://tenor.com/view/cat-dance-123';

function gifLink(id: string, url = GIFS_TENOR, title = 'Chat qui danse') {
  return { id, kind: 'gif', site: 'Tenor', title, text: '', thumbnailUrl: 'https://media.tenor.com/x.png', url };
}

function gifAttachment(id: string, name = 'réaction.gif') {
  return {
    id,
    kind: 'gif',
    name,
    url: `https://cdn.discordapp.com/attachments/c1/${id}/${name}?ex=1`,
    size: 10,
    durationSec: null,
  };
}

function withGifStore(fn: Untyped) {
  const dir = tempDir('nep-');
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    result = fn(createStore(memoryAt(dir)), dir);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result && typeof result.then === 'function') return result.finally(cleanup);
  cleanup();
  return result;
}

// The GIF switch is code and the library's measures are constants of src/memory/gifs.ts.
function gifsHot() {
  return { config: { bot: { timezone: 'UTC' } }, prompts: { labels } };
}

test("observe: a member's gif joins the library with its url", async () => {
  await withGifStore(async (store: Untyped) => {
    const updater = createMemoryUpdater({ hot: gifsHot(), store });
    const { logs } = await withCapturedLogs(() =>
      updater.observe(placeOfRoot(updater, 'g1'), msg({ links: [gifLink('m1#e0')] }))
    );
    assert.equal(store.findGif('g1').url, GIFS_TENOR);
    const line = logs.find((l) => l.msg === 'memory: gifs recorded');
    assert.equal(present(line).gifs, 1);
    assert.equal(JSON.stringify(line).includes('tenor'), false);
  });
});

test('observe: a private chat, the persona and paused never feed the library', () => {
  withGifStore((store: Untyped) => {
    const on = createMemoryUpdater({ hot: gifsHot(), store });
    on.observe(placeOfRoot(on, 'g1'), msg({ id: 'm2', links: [gifLink('m2#e0')] }), { private: wrongly('1') });
    on.observe(placeOfRoot(on, 'g1'), msg({ id: 'm3', self: true, links: [gifLink('m3#e0')] }));
    const data = store.state.data;
    data.paused = true;
    on.observe(placeOfRoot(on, 'g1'), msg({ id: 'm4', links: [gifLink('m4#e0')] }));
    assert.deepEqual(store.getGifs().entries, {});
  });
});

// `gifs.storeMax` is the constant GIF_STORE_MAX, so one GIF more than it is observed.
test('observe: gifs.storeMax caps the library', () => {
  withGifStore((store: Untyped) => {
    const updater = createMemoryUpdater({ hot: gifsHot(), store });
    updater.observe(placeOfRoot(updater, 'g1'), msg({ id: 'm0', ts: T0, attachments: [gifAttachment('a0')] }));
    for (let n = 1; n <= GIF_STORE_MAX; n += 1)
      updater.observe(
        placeOfRoot(updater, 'g1'),
        msg({ id: `m${n}`, ts: T0 + DAY + n, attachments: [gifAttachment(`a${n}`)] })
      );
    const kept = Object.keys(store.getGifs().entries);
    assert.deepEqual([kept.length, kept.includes('a0')], [GIF_STORE_MAX, false]);
  });
});

// ---- custom emoji -----------------------------------------------------------

/** `fn(store, memoryDb)` over a store on a fresh memory database, closed and removed after. */
async function withEmojiStore(fn: Untyped) {
  const mem = await openTestMemory();
  try {
    return await fn(createStore({ dataDir: mem.dataDir, memoryDb: mem.memoryDb }), mem.memoryDb, mem.dataDir);
  } finally {
    await mem.close();
    fs.rmSync(mem.dataDir, { recursive: true, force: true });
  }
}

function emojiHot() {
  return { config: { bot: { timezone: 'UTC' } } };
}

function emojiMsg(overrides = {}) {
  return msg({ content: 'hi', ...overrides });
}

// An emoji and a sticker go by a stable name of the engine.
test("observe: a member's message adds its emoji to root.emojiUsage; the persona's own adds nothing", async () => {
  await withEmojiStore(async (store: Untyped) => {
    const updater = createMemoryUpdater({ hot: emojiHot(), store });
    updater.observe(placeOfRoot(store, 'g1'), emojiMsg({ id: 'a', ts: T0, emojis: [{ id: '10', name: 'kappa' }] }));
    updater.observe(
      placeOfRoot(store, 'g1'),
      emojiMsg({ id: 'b', ts: T0 + 1, self: true, emojis: [{ id: '10', name: 'kappa' }] })
    );
    updater.observe(
      placeOfRoot(store, 'g1'),
      emojiMsg({
        id: 'c',
        ts: T0 + 2,
        emojis: [
          { id: '10', name: 'kappa' },
          { id: '20', name: 'omega' },
        ],
      })
    );
    assert.deepEqual(store.getPlace(placeOfRoot(store, 'g1')).emojiUsage, {
      10: { count: 2, last: T0 + 2 },
      20: { count: 1, last: T0 + 2 },
    });
  });
});

// `context.customEmoji.storeMax` is the constant EMOJI_STORE_MAX, so one emoji more than it is observed.
test('observe: context.customEmoji.storeMax caps the stored entries', async () => {
  await withEmojiStore(async (store: Untyped) => {
    const updater = createMemoryUpdater({ hot: emojiHot(), store });
    updater.observe(placeOfRoot(store, 'g1'), emojiMsg({ id: 'a', ts: T0, emojis: [{ id: '0', name: 'alpha' }] }));
    for (let n = 1; n <= EMOJI_STORE_MAX; n += 1)
      updater.observe(
        placeOfRoot(store, 'g1'),
        emojiMsg({ id: `m${n}`, ts: T0 + DAY + n, emojis: [{ id: String(n), name: `e${n}` }] })
      );
    const kept = Object.keys(store.getPlace(placeOfRoot(store, 'g1')).emojiUsage);
    assert.deepEqual([kept.length, kept.includes('0')], [EMOJI_STORE_MAX, false]);
  });
});
