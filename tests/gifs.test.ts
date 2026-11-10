// The GIF library: pure collection/ranking (src/memory/gifs.ts), its storage
// in gifs.json (src/memory/store.ts), the live pipeline that feeds it
// (src/memory/update.ts#observe), the <gif> tag (src/llm/parse.ts) and the
// poster (src/behavior/turn.js).

import { placeOfRoot } from '../src/memory/addresses.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { gifLibraryValue } from '../src/memory/db/gif-library.ts';
import { memDataDir, memoryAt } from './fixtures/store-kit.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  GIF_STORE_MAX,
  collectGifItems,
  findGif,
  markOwnGif,
  mergeGifs,
  normalizeGifs,
  rankGifs,
  resetGifCounts,
} from '../src/memory/gifs.ts';
import { createStore } from '../src/memory/store.ts';
import { createMemoryUpdater } from '../src/memory/update.ts';
import { createTurnRunner as createRealTurnRunner } from '../src/behavior/turn.ts';
import { userText } from '../src/behavior/prompt.ts';
import { labels } from './fixtures/labels.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { onWorld, world } from './fixtures/turn-world.ts';
import type { Posted } from './fixtures/turn-world.ts';
import type { GifLibrary } from '../src/memory/gifs.ts';
import { tempDir } from './fixtures/tmp.ts';
import type { Untyped } from '../src/tools/types.ts';
import { present, wrongly } from './fixtures/loose-types.ts';
import { chainsOf } from './fixtures/chains.ts';

const createTurnRunner = onWorld(wrongly(createRealTurnRunner));

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);
const TENOR = 'https://tenor.com/view/cat-dance-123';
const GIPHY = 'https://giphy.com/gifs/wave-abc';

function gifLink(id: string, url = TENOR, title = 'Chat qui danse') {
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

function withStore(fn: Untyped) {
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

// --- pure collection ---------------------------------------------------------

test("collectGifItems: gif embeds and gif attachments, the message's own then its forwards", () => {
  const items = collectGifItems(
    msg({
      id: 'm7',
      placeId: 'c3',
      attachments: [gifAttachment('a1'), { id: 'a2', kind: 'image', name: 'p.png', url: 'https://cdn/p.png' }],
      links: [
        gifLink('m7#e0'),
        { id: 'link:1', kind: 'link', site: 'example.org', title: 'Page', url: 'https://example.org' },
      ],
      forwarded: [
        { content: '', attachments: [gifAttachment('fa1', 'ωμέγα.gif')], links: [gifLink('fwd#e0', GIPHY, '')] },
      ],
    })
  );
  assert.deepEqual(items, [
    {
      key: 'a1',
      kind: 'attachment',
      url: gifAttachment('a1').url,
      name: 'réaction.gif',
      itemId: 'a1',
      messageId: 'm7',
      placeId: 'c3',
    },
    {
      key: 'm7#e0',
      kind: 'link',
      url: TENOR,
      site: 'Tenor',
      name: 'Chat qui danse',
      itemId: 'm7#e0',
      messageId: 'm7',
      placeId: 'c3',
    },
    {
      key: 'fa1',
      kind: 'attachment',
      url: gifAttachment('fa1', 'ωμέγα.gif').url,
      name: 'ωμέγα.gif',
      itemId: 'fa1',
      messageId: 'm7',
      placeId: 'c3',
    },
    { key: 'fwd#e0', kind: 'link', url: GIPHY, site: 'Tenor', itemId: 'fwd#e0', messageId: 'm7', placeId: 'c3' },
  ]);
});

test('collectGifItems: a gif embed the adapter marked expiring is not a library item, whatever its host', () => {
  const signed = 'https://klipy.com/gifs/dancing-cat?sig=1';
  const items = collectGifItems(
    msg({
      links: [
        { ...gifLink('m1#e0', signed), expiring: true },
        { ...gifLink('m1#e1', 'https://klipy.com/gifs/waving-cat'), expiring: false },
      ],
    })
  );
  assert.deepEqual(
    items.map((item) => item.url),
    ['https://klipy.com/gifs/waving-cat']
  );
});

test('collectGifItems: a gif embed on a Discord CDN host the adapter did not mark is a library item, the core reads no host', () => {
  const cdn = 'https://cdn.discordapp.com/attachments/1/2/loop.gif?ex=1&is=2&hm=3';
  const items = collectGifItems(msg({ links: [gifLink('m1#e0', cdn)] }));
  assert.deepEqual(
    items.map((item) => item.url),
    [cdn]
  );
});

test('collectGifItems: items without a url or an id are skipped; no message -> []', () => {
  assert.deepEqual(
    collectGifItems(
      msg({ links: [{ ...gifLink('e0'), url: null }], attachments: [{ ...gifAttachment('a1'), id: null }] })
    ),
    []
  );
  assert.deepEqual(collectGifItems(wrongly(null)), []);
});

// --- pure merge and ranking --------------------------------------------------

test('mergeGifs: members only, one count per gif per message, handles assigned once', () => {
  const { gifs, counted }: Record<string, Untyped> = mergeGifs(undefined, [
    msg({ id: 'm1', ts: T0, attachments: [gifAttachment('a1'), gifAttachment('a1')] }),
    msg({ id: 'm2', ts: T0 + 1, self: true, attachments: [gifAttachment('a9')] }),
    msg({ id: 'm3', ts: T0 + 2, bot: true, links: [gifLink('m3#e0')] }),
    msg({ id: 'm4', ts: T0 + 3, links: [gifLink('m4#e0')] }),
  ]);
  assert.equal(counted, 2);
  assert.equal(gifs.nextId, 3);
  assert.deepEqual(Object.keys(gifs.entries), ['a1', 'm4#e0']);
  assert.equal(gifs.entries.a1.id, 'g1');
  assert.equal(gifs.entries.a1.count, 1);
  assert.equal(gifs.entries['m4#e0'].id, 'g2');
  assert.equal(gifs.entries['m4#e0'].firstSeen, T0 + 3);
  assert.equal(gifs.backfill, null);
});

test('mergeGifs: handles are stable across merges; a reposted link counts on its first entry', () => {
  const first: Record<string, Untyped> = mergeGifs(undefined, [
    msg({ id: 'm1', ts: T0, links: [gifLink('m1#e0')] }),
  ]).gifs;
  const second: Record<string, Untyped> = mergeGifs(first, [
    msg({ id: 'm2', placeId: 'c2', ts: T0 + DAY, links: [gifLink('m2#e0')] }),
    msg({ id: 'm3', ts: T0 + 2 * DAY, links: [gifLink('m3#e0', GIPHY)] }),
  ]).gifs;
  assert.deepEqual(Object.keys(second.entries).sort(), ['m1#e0', 'm3#e0']);
  const tenor = second.entries['m1#e0'];
  assert.equal(tenor.id, 'g1');
  assert.equal(tenor.count, 2);
  assert.equal(tenor.last, T0 + DAY);
  assert.equal(tenor.firstSeen, T0);
  assert.equal(tenor.messageId, 'm2');
  assert.equal(tenor.placeId, 'c2');
  assert.equal(second.entries['m3#e0'].id, 'g2');
  assert.equal(first.entries['m1#e0'].count, 1, 'the input is never mutated');
});

test('mergeGifs: an older use counts but never moves last or the message pointer back', () => {
  const first = mergeGifs(undefined, [msg({ id: 'm5', ts: T0 + DAY, attachments: [gifAttachment('a1')] })]).gifs;
  const second: Record<string, Untyped> = mergeGifs(first, [
    msg({ id: 'm1', ts: T0, attachments: [gifAttachment('a1')] }),
  ]).gifs;
  assert.equal(second.entries.a1.count, 2);
  assert.equal(second.entries.a1.last, T0 + DAY);
  assert.equal(second.entries.a1.messageId, 'm5');
  assert.equal(second.entries.a1.firstSeen, T0);
});

test('mergeGifs: past storeMax the lowest-ranked are evicted and their handles never reused', () => {
  let gifs: Record<string, Untyped> = mergeGifs(undefined, [
    msg({ id: 'm1', ts: T0, attachments: [gifAttachment('a1')] }),
    msg({ id: 'm2', ts: T0 + DAY, attachments: [gifAttachment('a2')] }),
    msg({ id: 'm3', ts: T0 + DAY, attachments: [gifAttachment('a2')] }),
  ]).gifs;
  gifs = mergeGifs(gifs, [msg({ id: 'm4', ts: T0 + 2 * DAY, attachments: [gifAttachment('a3')] })], {
    storeMax: 2,
    halfLifeDays: 30,
  }).gifs;
  assert.deepEqual(Object.keys(gifs.entries).sort(), ['a2', 'a3']);
  gifs = mergeGifs(gifs, [msg({ id: 'm5', ts: T0 + 3 * DAY, attachments: [gifAttachment('a4')] })]).gifs;
  assert.equal(gifs.entries.a4.id, 'g4');
});

test('rankGifs: count and recency, best first; findGif by handle', () => {
  const { gifs } = mergeGifs(undefined, [
    msg({ id: 'm1', ts: T0, attachments: [gifAttachment('a1')] }),
    msg({ id: 'm2', ts: T0, attachments: [gifAttachment('a1')] }),
    msg({ id: 'm3', ts: T0 + DAY, links: [gifLink('m3#e0')] }),
  ]);
  assert.deepEqual(
    rankGifs(gifs, 30).map((entry) => entry.key),
    ['a1', 'm3#e0']
  );
  assert.deepEqual(
    rankGifs(gifs, 0.01).map((entry) => entry.key),
    ['m3#e0', 'a1']
  );
  assert.equal('weight' in rankGifs(gifs, 30)[0], false);
  assert.equal(wrongly<Untyped>(present(findGif(gifs, 'G2'))).key, 'm3#e0');
  assert.equal(findGif(gifs, 'g99'), null);
  assert.equal(findGif(gifs, 'cat'), null);
});

test('resetGifCounts: every entry kept with count 0, handles, last and nextId untouched; never mutates', () => {
  const { gifs }: Record<string, Untyped> = mergeGifs(undefined, [
    msg({ id: 'm1', ts: T0, attachments: [gifAttachment('a1')] }),
    msg({ id: 'm2', ts: T0 + DAY, links: [gifLink('m2#e0')] }),
  ]);
  const reset = resetGifCounts({ ...gifs, backfill: { at: '2026-09-30T00:00:00.000Z', channels: 1, messages: 2 } });
  assert.deepEqual(Object.keys(reset.entries), ['a1', 'm2#e0']);
  assert.deepEqual(
    Object.values(reset.entries).map((entry) => entry.count),
    [0, 0]
  );
  assert.equal(reset.entries.a1.id, 'g1');
  assert.equal(reset.entries['m2#e0'].id, 'g2');
  assert.equal(reset.entries['m2#e0'].last, T0 + DAY);
  assert.equal(reset.nextId, 3);
  assert.equal(wrongly<Untyped>(present(reset.backfill)).at, '2026-09-30T00:00:00.000Z');
  assert.equal(gifs.entries.a1.count, 1, 'the input is never mutated');
  // B7: the library holds a stamp per place beside the newest one.
  assert.deepEqual(resetGifCounts(null), { nextId: 1, entries: {}, backfill: null, backfills: {} });
});

test('mergeGifs: a reset entry seen again keeps its handle and counts afresh', () => {
  const first = mergeGifs(undefined, [
    msg({ id: 'm1', ts: T0, attachments: [gifAttachment('a1')] }),
    msg({ id: 'm2', ts: T0, attachments: [gifAttachment('a1')] }),
  ]).gifs;
  const { gifs, counted }: Record<string, Untyped> = mergeGifs(resetGifCounts(first), [
    msg({ id: 'm7', placeId: 'c2', ts: T0 + DAY, attachments: [gifAttachment('a1')] }),
  ]);
  assert.equal(counted, 1);
  assert.equal(gifs.entries.a1.id, 'g1');
  assert.equal(gifs.entries.a1.count, 1);
  assert.equal(gifs.entries.a1.last, T0 + DAY);
  assert.equal(gifs.entries.a1.messageId, 'm7');
  assert.equal(gifs.entries.a1.placeId, 'c2');
  assert.equal(gifs.nextId, 2, 'no new handle');
});

test('mergeGifs: a reset link entry is matched by url under a new embed id and keeps its handle', () => {
  const first = mergeGifs(undefined, [msg({ id: 'm1', ts: T0, links: [gifLink('m1#e0')] })]).gifs;
  const { gifs }: Record<string, Untyped> = mergeGifs(resetGifCounts(first), [
    msg({ id: 'm9', ts: T0 + DAY, links: [gifLink('m9#e0')] }),
  ]);
  assert.deepEqual(Object.keys(gifs.entries), ['m1#e0']);
  assert.equal(gifs.entries['m1#e0'].id, 'g1');
  assert.equal(gifs.entries['m1#e0'].count, 1);
  assert.equal(gifs.entries['m1#e0'].messageId, 'm9');
  assert.equal(gifs.nextId, 2);
});

test('rankGifs: a GIF posted once yesterday outranks one posted seven times three years ago', () => {
  const now = T0 + 3 * 365 * DAY;
  const oldPosts = Array.from({ length: 7 }, (_, i) =>
    msg({ id: `o${i}`, ts: T0 + i * DAY, attachments: [gifAttachment('old')] })
  );
  const { gifs }: Record<string, Untyped> = mergeGifs(undefined, [
    ...oldPosts,
    msg({ id: 'n1', ts: now - DAY, attachments: [gifAttachment('new')] }),
  ]);
  assert.equal(gifs.entries.old.count, 7);
  assert.equal(gifs.entries.new.count, 1);
  assert.deepEqual(
    rankGifs(gifs, 30).map((entry) => entry.key),
    ['new', 'old']
  );
});

test('rankGifs: a zero count ranks below any positive count, however recent', () => {
  const old = mergeGifs(undefined, [msg({ id: 'm1', ts: T0, attachments: [gifAttachment('a1')] })]).gifs;
  const recent: Record<string, Untyped> = mergeGifs(old, [
    msg({ id: 'm2', ts: T0 + 400 * DAY, attachments: [gifAttachment('a2')] }),
  ]).gifs;
  // B7: the global count is the sum over places, so the reset is on the counter of the place.
  const library = {
    ...recent,
    entries: {
      ...recent.entries,
      a2: { ...recent.entries.a2, count: 0, places: { c1: { count: 0, last: T0 + 400 * DAY } } },
    },
  };
  assert.deepEqual(
    rankGifs(library, 30).map((entry) => entry.key),
    ['a1', 'a2']
  );
  assert.deepEqual(
    rankGifs(library, 0.01).map((entry) => entry.key),
    ['a1', 'a2']
  );
  assert.deepEqual(
    rankGifs(library).map((entry) => entry.key),
    ['a1', 'a2']
  );
});

test('mergeGifs: past storeMax zero-count entries are evicted first, handles never reused', () => {
  const first = mergeGifs(undefined, [
    msg({ id: 'm1', ts: T0 + 5 * DAY, attachments: [gifAttachment('a1')] }),
    msg({ id: 'm2', ts: T0 + 6 * DAY, attachments: [gifAttachment('a2')] }),
  ]).gifs;
  const { gifs }: Record<string, Untyped> = mergeGifs(
    resetGifCounts(first),
    [
      msg({ id: 'm3', ts: T0, attachments: [gifAttachment('a3')] }),
      msg({ id: 'm4', ts: T0 + DAY, attachments: [gifAttachment('a1')] }),
    ],
    { storeMax: 2, halfLifeDays: 30 }
  );
  assert.deepEqual(
    Object.keys(gifs.entries).sort(),
    ['a1', 'a3'],
    'the zero-count a2 goes, though its last is the newest'
  );
  assert.equal(gifs.entries.a1.id, 'g1');
  assert.equal(gifs.entries.a3.id, 'g3');
  const again: Record<string, Untyped> = mergeGifs(gifs, [
    msg({ id: 'm5', ts: T0 + 7 * DAY, attachments: [gifAttachment('a2')] }),
  ]).gifs;
  assert.equal(again.entries.a2.id, 'g4', 'an evicted handle is never reused');
});

test('normalizeGifs: garbage in -> the empty library; broken entries dropped; bad handles reassigned', () => {
  // B7: the library holds a stamp per place beside the newest one.
  assert.deepEqual(normalizeGifs(null), { nextId: 1, entries: {}, backfill: null, backfills: {} });
  assert.deepEqual(normalizeGifs([1, 2]), { nextId: 1, entries: {}, backfill: null, backfills: {} });
  const out = normalizeGifs({
    nextId: 2,
    entries: {
      a: { id: 'g5', kind: 'link', url: TENOR, count: 2, last: T0 },
      b: { id: 'g5', kind: 'attachment', url: 'https://cdn/x.gif', count: 1 },
      c: { id: 'g1', kind: 'video', url: TENOR, count: 1 },
      d: { id: 'g2', kind: 'link', url: '', count: 1 },
      e: { id: 'g3', kind: 'link', url: GIPHY, count: -1 },
      z: { id: 'g4', kind: 'link', url: GIPHY, count: 0, last: T0 },
      f: 'nope',
    },
    backfill: { at: '2026-09-30T00:00:00.000Z', channels: 2.7, messages: -1 },
  });
  assert.deepEqual(Object.keys(out.entries), ['a', 'b', 'z']);
  assert.equal(out.entries.z.count, 0, 'a reset entry (count 0) is kept');
  assert.equal(out.entries.z.id, 'g4');
  assert.equal(out.entries.a.id, 'g5');
  assert.equal(out.entries.a.itemId, 'a');
  assert.equal(out.entries.a.firstSeen, T0);
  assert.equal(out.entries.b.id, 'g6');
  assert.equal(out.entries.b.last, 0);
  assert.equal(out.nextId, 7);
  assert.deepEqual(out.backfill, { at: '2026-09-30T00:00:00.000Z', channels: 2, messages: 0 });
});

// --- storage -----------------------------------------------------------------

/** B7: the library of the persona as the database holds it, undefined when it holds none. */
function libraryUnit(memoryDb: Untyped): Untyped {
  const found: Untyped = gifLibraryValue(dbOf(memoryDb.readHandle()));
  return found.found ? found.value : undefined;
}

test('store.recordGifs: persists its unit; getGifs/findGif read it back after a restart', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  const g1 = placeOfRoot(store, 'g1');
  assert.deepEqual(store.getGifs(), { nextId: 1, entries: {}, backfill: null, backfills: {} });
  assert.equal(store.recordGifs(g1, [msg({ self: true, links: [gifLink('m1#e0')] })], { storeMax: 300 }), 0);
  store.flush();
  await store.flushSettled({});
  assert.equal(libraryUnit(memoryDb), undefined, 'nothing counted, nothing written');

  assert.equal(store.recordGifs(g1, [msg({ links: [gifLink('m1#e0')] })], { storeMax: 300 }), 1);
  store.flush();
  await store.flushSettled({});
  const onDisk = libraryUnit(memoryDb);
  assert.equal(onDisk.nextId, 2);
  assert.equal(onDisk.entries['m1#e0'].id, 'g1');

  const reopened = createStore({ dataDir: dir, memoryDb });
  assert.equal(wrongly<Untyped>(present(reopened.findGif('g1'))).url, TENOR);
  assert.equal(reopened.findGif('g2'), null);
});

test('store.getGifs: a hand-broken unit is normalised on read, never wiped by reading', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  const raw = { entries: { a: { kind: 'link', url: TENOR, count: 3, last: T0 } } };
  await memoryDb.writeGifLibrary({ put: raw.entries });
  const gifs = store.getGifs();
  assert.equal(wrongly<Record<string, { id: string }>>(gifs.entries).a.id, 'g1');
  assert.equal(gifs.nextId, 2);
  store.flush();
  await store.flushSettled({});
  assert.deepEqual(libraryUnit(memoryDb), raw);
});

test('markOwnGif: stamps ownLast and counts ownUses on the entry; an unknown key changes nothing; never mutates', () => {
  const { gifs }: Record<string, Untyped> = mergeGifs(null, [msg({ links: [gifLink('m1#e0')] })]);
  const once = markOwnGif(gifs, 'm1#e0', T0 + DAY);
  assert.equal(once.marked, true);
  assert.equal(once.gifs.entries['m1#e0'].ownLast, T0 + DAY);
  assert.equal(once.gifs.entries['m1#e0'].ownUses, 1);
  assert.equal(once.gifs.entries['m1#e0'].count, 1, "the members' count is not touched");
  assert.equal('ownLast' in gifs.entries['m1#e0'], false);
  const twice = markOwnGif(once.gifs, 'm1#e0', T0 + 2 * DAY);
  assert.equal(twice.gifs.entries['m1#e0'].ownLast, T0 + 2 * DAY);
  assert.equal(twice.gifs.entries['m1#e0'].ownUses, 2);
  const unknown = markOwnGif(gifs, 'nope', T0);
  assert.equal(unknown.marked, false);
  assert.deepEqual(unknown.gifs, normalizeGifs(gifs));
});

test("normalizeGifs: ownLast/ownUses survive a member's use and a recount; bad values are dropped", () => {
  const { gifs } = mergeGifs(null, [msg({ links: [gifLink('m1#e0')] })]);
  const marked = markOwnGif(gifs, 'm1#e0', T0 + DAY).gifs;
  const again: Record<string, Untyped> = mergeGifs(marked, [
    msg({ id: 'm2', ts: T0 + 2 * DAY, links: [gifLink('m2#e0')] }),
  ]).gifs;
  assert.equal(again.entries['m1#e0'].count, 2);
  assert.equal(again.entries['m1#e0'].ownLast, T0 + DAY);
  assert.equal(again.entries['m1#e0'].ownUses, 1);
  const reset = resetGifCounts(again);
  assert.equal(reset.entries['m1#e0'].ownLast, T0 + DAY);
  assert.equal(reset.entries['m1#e0'].ownUses, 1);
  const broken = normalizeGifs({
    entries: { a: { kind: 'link', url: TENOR, count: 1, last: T0, ownLast: 'x', ownUses: -3 } },
  });
  assert.equal('ownLast' in broken.entries.a, false);
  assert.equal('ownUses' in broken.entries.a, false);
  const fractional = normalizeGifs({
    entries: { a: { kind: 'link', url: TENOR, count: 1, last: T0, ownLast: T0, ownUses: 2.7 } },
  });
  assert.equal(fractional.entries.a.ownUses, 2);
});

test('store.recordOwnGif: persists the stamp; an unknown key writes nothing', async () => {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  const g1 = placeOfRoot(store, 'g1');
  assert.equal(store.recordOwnGif(g1, 'm1#e0', T0), false);
  store.flush();
  await store.flushSettled({});
  assert.equal(libraryUnit(memoryDb), undefined, 'nothing marked, nothing written');
  store.recordGifs(g1, [msg({ links: [gifLink('m1#e0')] })]);
  assert.equal(store.recordOwnGif(g1, 'm1#e0', T0 + DAY), true);
  store.flush();
  await store.flushSettled({});
  const entry = createStore({ dataDir: dir, memoryDb }).findGif('g1');
  assert.equal(wrongly<Untyped>(present(entry)).ownLast, T0 + DAY);
  assert.equal(wrongly<Untyped>(present(entry)).ownUses, 1);
});

// --- the live pipeline -------------------------------------------------------

// PR 7d: the GIF switch is code and the library's measures are constants of src/memory/gifs.ts.
function hotFor() {
  return { config: { bot: { timezone: 'UTC' } }, prompts: { labels } };
}

test("observe: a member's gif joins the library with its url", async () => {
  await withStore(async (store: Untyped) => {
    const updater = createMemoryUpdater({ hot: hotFor(), store });
    const { logs } = await withCapturedLogs(() =>
      updater.observe(placeOfRoot(updater, 'g1'), msg({ links: [gifLink('m1#e0')] }))
    );
    assert.equal(store.findGif('g1').url, TENOR);
    const line = logs.find((l) => l.msg === 'memory: gifs recorded');
    assert.equal(present(line).gifs, 1);
    assert.equal(JSON.stringify(line).includes('tenor'), false);
  });
});

test('observe: a private chat, the persona and paused never feed the library', () => {
  withStore((store: Untyped) => {
    const on = createMemoryUpdater({ hot: hotFor(), store });
    on.observe(placeOfRoot(on, 'g1'), msg({ id: 'm2', links: [gifLink('m2#e0')] }), { private: wrongly('1') });
    on.observe(placeOfRoot(on, 'g1'), msg({ id: 'm3', self: true, links: [gifLink('m3#e0')] }));
    store.state.data.paused = true;
    on.observe(placeOfRoot(on, 'g1'), msg({ id: 'm4', links: [gifLink('m4#e0')] }));
    assert.deepEqual(store.getGifs().entries, {});
  });
});

// PR 7d: `gifs.storeMax` is the constant GIF_STORE_MAX, so one GIF more than it is observed.
test('observe: gifs.storeMax caps the library', () => {
  withStore((store: Untyped) => {
    const updater = createMemoryUpdater({ hot: hotFor(), store });
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

// --- the <gif> tag -----------------------------------------------------------

// B7: `<gif>` left the output contract; tests/parse-gif-retired.test.ts holds what the parser does with one.

// --- the poster --------------------------------------------------------------

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

function rawMessage(
  id: string,
  { attachments = new Map(), messageSnapshots }: { attachments?: Untyped; messageSnapshots?: Untyped } = {}
) {
  return {
    id,
    placeId: 'c1',
    author: { id: 'u1', bot: false, globalName: 'Zoé', username: 'Zoé' },
    member: { displayName: 'Zoé' },
    cleanContent: 'hey',
    createdTimestamp: NOW - 1000,
    reference: null,
    attachments,
    stickers: new Map(),
    ...(messageSnapshots ? { messageSnapshots } : {}),
  };
}

function trigger(raw: Record<string, Untyped>) {
  return {
    id: raw.id,
    placeId: 'c1',
    authorId: 'u1',
    authorName: 'Zoé',
    self: false,
    bot: false,
    content: 'hey',
    ts: raw.createdTimestamp,
    replyToId: null,
    attachments: [],
    stickers: [],
  };
}

/** A channel of the world holding `historyMessages`; `fetched` lists the messages read by id, `fetchFails` makes that read fail. */
function fakeChannel({
  id = 'c1',
  historyMessages = [],
  fetchFails = false,
}: { id?: string; historyMessages?: Array<Untyped>; fetchFails?: boolean } = {}) {
  const fetched: Array<Untyped> = [];
  world().tap('fetchMessages', ([ref, ids]: Untyped) => {
    if (ref.chatId === id) fetched.push(...ids);
  });
  const channel = world().channel({ id, name: 'general', placeId: 'g1', historyMessages });
  if (fetchFails) world().failRead('fetchMessages', id);
  return Object.assign(channel, { fetched });
}

// PR 7d: the switches are code and the context and media measures constants, so only the settings stay.
function fakeHot() {
  return {
    config: {
      bot: { timezone: 'UTC' },
      context: { channelMessages: 100, caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 } },
      llm: { maxRequestTokens: 50000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 1, betweenMessagesMs: [0, 0] },
    },
    prompts: {
      'system-prompt': 'You are a regular member of this chat.',
      'character-card': 'Terse.',
      format: 'Use tags.',
      reply: 'Someone called you: {{author}}.',
      interject: 'Jump in.',
      initiate: 'Start a topic.',
      labels,
    },
  };
}

function calibrator() {
  return { ratio: 1, apply: (n: Record<string, Untyped>) => n, observe: () => {} };
}

/** A real store seeded with one link gif (g1, from m-old in c1) and one attached gif (g2, from m-att in c2). */
function seedLibrary(store: Record<string, Untyped>) {
  store.recordGifs(placeOfRoot(store, 'g1'), [
    msg({ id: 'm-old', placeId: 'c1', ts: NOW - DAY, links: [gifLink('m-old#e0')] }),
    msg({ id: 'm-att', placeId: 'c2', ts: NOW - DAY, attachments: [gifAttachment('att1')] }),
  ]);
  // B7: the pick's search reads the caption on the entry; `ha` is the word of the replies below.
  store.setGifCaption('m-old#e0', { caption: 'ha a cat dancing', vector: null });
  store.setGifCaption('att1', { caption: 'ha an attached gif', vector: null });
}

/**
 * B7: one turn with the media pick on an interface that declares GIF links and files: `output` is her answer and `pick`
 * the classifier's. `<gif>` left her output, so a GIF of hers goes out only through the pick.
 */
type GifTurnRun = {
  result: { outcome: unknown };
  logs: Array<Record<string, Untyped>>;
  channel: { sent: Array<Posted> };
  gifs: GifLibrary;
};

async function runGifTurn({
  output,
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  pick = '{"pick":"none","name":null}',
  channelOpts = {},
  prepare,
  triggerKind = 'mention',
}: {
  output?: Untyped;
  pick?: string;
  channelOpts?: Record<string, Untyped>;
  prepare?: Untyped;
  triggerKind?: string;
} = {}): Promise<GifTurnRun> {
  return withStore(async (store: Record<string, Untyped>) => {
    seedLibrary(store);
    if (prepare) prepare(store);
    const raw = rawMessage('m1');
    const channel = fakeChannel({ historyMessages: [raw], ...channelOpts });
    const port = world().port as unknown as { capabilities: () => object };
    const declared = port.capabilities.bind(port);
    port.capabilities = () => ({ ...declared(), mediaPick: { gifForms: ['file', 'link'] } });
    const hot: Untyped = fakeHot();
    Object.assign(hot.prompts, { 'media-pick': 'Pick for {{name}}.' });
    hot.config.models = { routes: chainsOf({ analyzer: 'cheap/classifier' }) };
    const llm = {
      complete: (_messages: Untyped, options: Untyped) =>
        Promise.resolve({ text: options?.purpose === 'media-pick' ? pick : output, usage: {}, estimated: 10 }),
    };
    const turns = createTurnRunner({
      hot,
      store,
      llm,
      calibrator: calibrator(),
      now: () => NOW,
    });
    const { result, logs } = await withCapturedLogs(() =>
      turns.runTurn({ channel, mode: 'reply', trigger: trigger(raw), triggerKind })
    );
    return { result, logs, channel, state: store.state.data, gifs: store.getGifs() };
  });
}

test('the pick: a link handle sends the stored url in place of the first message, as a reply', async () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const { result, channel } = await runGifTurn({
    output: '<msg reply="#1">ha</msg><msg>more</msg>',
    pick: '{"pick":"gif","name":"g1"}',
  });
  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent.length, 2);
  assert.equal(channel.sent[0].content, TENOR);
  assert.equal(channel.sent[1].content, 'more');
  assert.equal(channel.sent[0].reply?.messageReference, 'm1');
  assert.deepEqual(channel.sent[0].allowedMentions, { parse: [] });
});

test('the pick: a sent gif stamps ownLast and ownUses on its entry, for the place it went to', async () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const { gifs } = await runGifTurn({ output: '<msg>ha</msg>', pick: '{"pick":"gif","name":"g1"}' });
  assert.equal(gifs.entries['m-old#e0'].ownLast, NOW);
  assert.equal(gifs.entries['m-old#e0'].ownUses, 1);
  assert.equal(gifs.entries['m-old#e0'].places.c1?.ownLast, NOW);
  assert.equal(gifs.entries['m-old#e0'].count, 1, "the members' count is not touched");
  assert.equal('ownLast' in gifs.entries.att1, false);
});

test('the pick: a gif alone is a turn; a follow-up never replies', async () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const withReply = await runGifTurn({ output: '<msg reply="#1">ha</msg>', pick: '{"pick":"gif","name":"g1"}' });
  assert.equal(withReply.result.outcome, 'spoke');
  assert.equal(withReply.channel.sent.length, 1);
  assert.equal(withReply.channel.sent[0].reply?.messageReference, 'm1');
  const followUp = await runGifTurn({
    output: '<msg reply="#1">ha</msg>',
    pick: '{"pick":"gif","name":"g1"}',
    triggerKind: 'followUp',
  });
  assert.equal(followUp.channel.sent.length, 1);
  assert.equal(followUp.channel.sent[0].reply, undefined);
});

test('the pick: an attachment with no cached file re-fetches its message and sends the fresh url', async () => {
  const fresh = 'https://cdn.discordapp.com/attachments/c2/att1/r%C3%A9action.gif?ex=fresh';
  const original = rawMessage('m-att', { attachments: new Map([['att1', { id: 'att1', url: fresh }]]) });
  const source = fakeChannel({ id: 'c2', historyMessages: [original] });
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const { channel, logs } = await runGifTurn({ output: '<msg>ha</msg>', pick: '{"pick":"gif","name":"g2"}' });
  assert.deepEqual(source.fetched, ['m-att']);
  assert.equal(channel.sent[0].content, fresh);
  const line = logs.find((l: Record<string, Untyped>) => l.msg === 'turn: gif sent');
  assert.equal(line?.fresh, true);
  assert.equal(line?.gif, 'g2');
});

test('the pick: an attachment in a forwarded snapshot is found too', async () => {
  const fresh = 'https://cdn.discordapp.com/attachments/c2/att1/x.gif?ex=fwd';
  const snapshots = new Map([['s', { attachments: new Map([['att1', { id: 'att1', url: fresh }]]) }]]);
  const original = rawMessage('m-att', wrongly({ messageSnapshots: snapshots }));
  fakeChannel({ id: 'c2', historyMessages: [original] });
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const { channel } = await runGifTurn({ output: '<msg>ha</msg>', pick: '{"pick":"gif","name":"g2"}' });
  assert.equal(channel.sent[0].content, fresh);
});

test('the pick: a failed re-fetch falls back to the stored url', async () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const { channel, logs } = await runGifTurn({ output: '<msg>ha</msg>', pick: '{"pick":"gif","name":"g2"}' });
  assert.equal(channel.sent[0].content, gifAttachment('att1').url);
  assert.ok(logs.find((l: Record<string, Untyped>) => l.msg === 'turn: gif refetch failed'));
  assert.equal(logs.find((l: Record<string, Untyped>) => l.msg === 'turn: gif sent')?.fresh, false);
});

test('the pick: an unknown handle posts the text as written', async () => {
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  const { result, channel, logs } = await runGifTurn({ output: '<msg>ha</msg>', pick: '{"pick":"gif","name":"g99"}' });
  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(
    channel.sent.map((p: Record<string, Untyped>) => p.content),
    ['ha']
  );
  assert.equal(logs.find((l: Record<string, Untyped>) => l.msg === 'media-pick: answered')?.kind, 'none');
});

// B7: the library left her request; a GIF of the chat keeps its handle in the transcript.
test('turn request: the library does not reach her request', async () => {
  const on = await withStore(async (store: Record<string, Untyped>) => {
    seedLibrary(store);
    store.putMediaEntry(placeOfRoot(store, 'g1'), 'm-old#e0', { text: 'a cat dancing', ts: NOW });
    const raw = rawMessage('m1');
    const channel = fakeChannel({ historyMessages: [raw] });
    const seen: Array<Untyped> = [];
    const llm = {
      complete: async (messages: Record<string, Untyped>) => {
        seen.push(messages);
        return { text: '<skip/>', usage: {}, estimated: 10 };
      },
    };
    const turns = createTurnRunner({
      hot: fakeHot(),
      store,
      llm,
      calibrator: calibrator(),
      now: () => NOW,
    });
    await withCapturedLogs(() =>
      turns.runTurn({ channel, mode: 'reply', trigger: trigger(raw), triggerKind: 'mention' })
    );
    return userText(seen[0][1].content);
  });
  assert.equal(on.includes('<gifs>'), false);
  assert.equal(on.includes('a cat dancing'), false);
});
