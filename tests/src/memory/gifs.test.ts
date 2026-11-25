// Tests for src/memory/gifs.ts: the one GIF library shared across places and interfaces. The pure collection of the
// GIF items of a message, the merge that counts them per place, the ranking and eviction, the normalisation of a
// stored library, the marks of the persona's own posts, the handles a transcript shows, the per-place slice and the
// search that hands the media pick its candidates. Pure functions over synthetic messages, no store and no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectGifItems,
  findGif,
  gifHandleMap,
  gifHandleOf,
  gifsOfPlace,
  markOwnGif,
  matchGifKey,
  mergeGifs,
  normalizeGifs,
  rankGifs,
  resetGifCounts,
  searchGifs,
  withGifFile,
} from '../../../src/memory/gifs.ts';
import type { GifEntry } from '../../../src/memory/gifs.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { present, wrongly } from '../../fixtures/loose-types.ts';
import { captionOfCached } from '../../../src/memory/gifs.ts';

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

/** The entry under `key` of a library that a test holds untyped. */
function entryOf(library: Untyped, key: string): GifEntry {
  return library.entries[key];
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

// An animated emoji or sticker is watched as a GIF, yet the library holds GIFs people post.
test('collectGifItems: an animated emoji and an animated sticker are no library items, beside an attached GIF', () => {
  const items = collectGifItems(
    msg({
      attachments: [gifAttachment('a1')],
      emojis: [
        {
          id: 'e2',
          name: 'kekw',
          animated: true,
          url: 'https://cdn.discordapp.com/emojis/e2.webp?size=96',
          animationUrl: 'https://cdn.discordapp.com/emojis/e2.gif',
        },
      ],
      stickers: [
        {
          id: 's3',
          name: 'dance',
          animated: true,
          url: 'https://media.discordapp.net/stickers/s3.gif?size=160',
          animationUrl: 'https://media.discordapp.net/stickers/s3.gif?size=160',
        },
      ],
    })
  );
  assert.deepEqual(
    items.map((item) => item.key),
    ['a1']
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

// A bot is a person to the persona, so a bot's GIF counts like a member's.
test('mergeGifs: everyone but the persona, one count per gif per message, handles assigned once', () => {
  const { gifs, counted }: Record<string, Untyped> = mergeGifs(undefined, [
    msg({ id: 'm1', ts: T0, attachments: [gifAttachment('a1'), gifAttachment('a1')] }),
    msg({ id: 'm2', ts: T0 + 1, self: true, attachments: [gifAttachment('a9')] }),
    msg({ id: 'm3', ts: T0 + 2, bot: true, links: [gifLink('m3#e0')] }),
    msg({ id: 'm4', ts: T0 + 3, links: [gifLink('m4#e0')] }),
  ]);
  // The bot's link and the member's share an address, so the member's repost counts on the bot's entry.
  assert.equal(counted, 3);
  assert.equal(gifs.nextId, 3);
  assert.deepEqual(Object.keys(gifs.entries), ['a1', 'm3#e0']);
  const attached = entryOf(gifs, 'a1');
  assert.equal(attached.id, 'g1');
  assert.equal(attached.count, 1);
  const shared = gifs.entries['m3#e0'];
  assert.equal(shared.id, 'g2');
  assert.equal(shared.count, 2);
  assert.equal(shared.firstSeen, T0 + 2);
  assert.equal(gifs.backfill, null);
});

// The direct media address is kept on the entry beside the page link, so a download that failed is tried again from
// it. Bug: only the page link was kept, and a GIF site's page link answers a page or a refusal, never the file.
test('mergeGifs: a GIF embed keeps its animation address as fileUrl beside the page link', () => {
  const embed = { ...gifLink('m1#e0'), animationUrl: 'https://media.gifs.example/cat.mp4' };
  const { gifs }: Record<string, Untyped> = mergeGifs(undefined, [msg({ links: [embed] })]);
  const entry = normalizeGifs(gifs).entries['m1#e0'];
  assert.equal(entry.url, TENOR);
  assert.equal(entry.fileUrl, 'https://media.gifs.example/cat.mp4');
});

// An attachment's address is signed and was expired in every measured case older than a week, so it serves no later
// retry and is not stored.
test('mergeGifs: an attached GIF stores no fileUrl', () => {
  const { gifs }: Record<string, Untyped> = mergeGifs(undefined, [msg({ attachments: [gifAttachment('a1')] })]);
  assert.equal(normalizeGifs(gifs).entries.a1.fileUrl, undefined);
});

test('mergeGifs: a GIF embed with no animation address keeps no fileUrl, never the page link', () => {
  const { gifs }: Record<string, Untyped> = mergeGifs(undefined, [msg({ links: [gifLink('m1#e0')] })]);
  assert.equal(normalizeGifs(gifs).entries['m1#e0'].fileUrl, undefined);
});

test('mergeGifs: a later sighting with an animation address gives an entry without one its fileUrl', () => {
  const first: Record<string, Untyped> = mergeGifs(undefined, [msg({ id: 'm1', links: [gifLink('m1#e0')] })]);
  const embed = { ...gifLink('m2#e0'), animationUrl: 'https://media.gifs.example/cat.mp4' };
  const { gifs }: Record<string, Untyped> = mergeGifs(first.gifs, [msg({ id: 'm2', ts: T0 + DAY, links: [embed] })]);
  const entries = Object.values(normalizeGifs(gifs).entries);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].fileUrl, 'https://media.gifs.example/cat.mp4');
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
  const giphy = entryOf(second, 'm3#e0');
  assert.equal(giphy.id, 'g2');
  const input = entryOf(first, 'm1#e0');
  assert.equal(input.count, 1, 'the input is never mutated');
});

test('mergeGifs: an older use counts but never moves last or the message pointer back', () => {
  const first = mergeGifs(undefined, [msg({ id: 'm5', ts: T0 + DAY, attachments: [gifAttachment('a1')] })]).gifs;
  const second: Record<string, Untyped> = mergeGifs(first, [
    msg({ id: 'm1', ts: T0, attachments: [gifAttachment('a1')] }),
  ]).gifs;
  const entry = entryOf(second, 'a1');
  assert.equal(entry.count, 2);
  assert.equal(entry.last, T0 + DAY);
  assert.equal(entry.messageId, 'm5');
  assert.equal(entry.firstSeen, T0);
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
  const fresh = entryOf(gifs, 'a4');
  assert.equal(fresh.id, 'g4');
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
  const attached = reset.entries.a1;
  assert.equal(attached.id, 'g1');
  const link = reset.entries['m2#e0'];
  assert.equal(link.id, 'g2');
  assert.equal(link.last, T0 + DAY);
  assert.equal(reset.nextId, 3);
  assert.equal(wrongly<Untyped>(present(reset.backfill)).at, '2026-09-30T00:00:00.000Z');
  const input = entryOf(gifs, 'a1');
  assert.equal(input.count, 1, 'the input is never mutated');
  // The library holds a stamp per place beside the newest one.
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
  const entry = entryOf(gifs, 'a1');
  assert.equal(entry.id, 'g1');
  assert.equal(entry.count, 1);
  assert.equal(entry.last, T0 + DAY);
  assert.equal(entry.messageId, 'm7');
  assert.equal(entry.placeId, 'c2');
  assert.equal(gifs.nextId, 2, 'no new handle');
});

test('mergeGifs: a reset link entry is matched by url under a new embed id and keeps its handle', () => {
  const first = mergeGifs(undefined, [msg({ id: 'm1', ts: T0, links: [gifLink('m1#e0')] })]).gifs;
  const { gifs }: Record<string, Untyped> = mergeGifs(resetGifCounts(first), [
    msg({ id: 'm9', ts: T0 + DAY, links: [gifLink('m9#e0')] }),
  ]);
  assert.deepEqual(Object.keys(gifs.entries), ['m1#e0']);
  const entry = entryOf(gifs, 'm1#e0');
  assert.equal(entry.id, 'g1');
  assert.equal(entry.count, 1);
  assert.equal(entry.messageId, 'm9');
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
  const old = entryOf(gifs, 'old');
  const recent = entryOf(gifs, 'new');
  assert.equal(old.count, 7);
  assert.equal(recent.count, 1);
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
  // The global count is the sum over places, so the reset is on the counter of the place.
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
  const a1 = entryOf(gifs, 'a1');
  const a3 = entryOf(gifs, 'a3');
  assert.equal(a1.id, 'g1');
  assert.equal(a3.id, 'g3');
  const again: Record<string, Untyped> = mergeGifs(gifs, [
    msg({ id: 'm5', ts: T0 + 7 * DAY, attachments: [gifAttachment('a2')] }),
  ]).gifs;
  const back = entryOf(again, 'a2');
  assert.equal(back.id, 'g4', 'an evicted handle is never reused');
});

test('normalizeGifs: garbage in -> the empty library; broken entries dropped; bad handles reassigned', () => {
  // The library holds a stamp per place beside the newest one.
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
  const { a, b, z } = out.entries;
  assert.equal(z.count, 0, 'a reset entry (count 0) is kept');
  assert.equal(z.id, 'g4');
  assert.equal(a.id, 'g5');
  assert.equal(a.itemId, 'a');
  assert.equal(a.firstSeen, T0);
  assert.equal(b.id, 'g6');
  assert.equal(b.last, 0);
  assert.equal(out.nextId, 7);
  assert.deepEqual(out.backfill, { at: '2026-09-30T00:00:00.000Z', channels: 2, messages: 0 });
});

// --- the persona's own posts ---------------------------------------------------

test('markOwnGif: stamps ownLast and counts ownUses on the entry; an unknown key changes nothing; never mutates', () => {
  const { gifs }: Record<string, Untyped> = mergeGifs(null, [msg({ links: [gifLink('m1#e0')] })]);
  const once = markOwnGif(gifs, 'm1#e0', T0 + DAY);
  assert.equal(once.marked, true);
  const { gifs: onceGifs } = once;
  const onceEntry = onceGifs.entries['m1#e0'];
  assert.equal(onceEntry.ownLast, T0 + DAY);
  assert.equal(onceEntry.ownUses, 1);
  assert.equal(onceEntry.count, 1, "the members' count is not touched");
  assert.equal('ownLast' in gifs.entries['m1#e0'], false);
  const twice = markOwnGif(once.gifs, 'm1#e0', T0 + 2 * DAY);
  const { gifs: twiceGifs } = twice;
  const twiceEntry = twiceGifs.entries['m1#e0'];
  assert.equal(twiceEntry.ownLast, T0 + 2 * DAY);
  assert.equal(twiceEntry.ownUses, 2);
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
  const seen = entryOf(again, 'm1#e0');
  assert.equal(seen.count, 2);
  assert.equal(seen.ownLast, T0 + DAY);
  assert.equal(seen.ownUses, 1);
  const reset = resetGifCounts(again);
  const recounted = reset.entries['m1#e0'];
  assert.equal(recounted.ownLast, T0 + DAY);
  assert.equal(recounted.ownUses, 1);
  const broken = normalizeGifs({
    entries: { a: { kind: 'link', url: TENOR, count: 1, last: T0, ownLast: 'x', ownUses: -3 } },
  });
  assert.equal('ownLast' in broken.entries.a, false);
  assert.equal('ownUses' in broken.entries.a, false);
  const fractional = normalizeGifs({
    entries: { a: { kind: 'link', url: TENOR, count: 1, last: T0, ownLast: T0, ownUses: 2.7 } },
  });
  const rounded = fractional.entries.a;
  assert.equal(rounded.ownUses, 2);
});

// --- the handles a transcript shows ----------------------------------------------

function handleMsg(id: string, overrides = {}) {
  return {
    id,
    ts: T0,
    placeId: 'c1',
    authorId: 'a',
    authorName: 'Zoé',
    self: false,
    content: '',
    attachments: [],
    links: [],
    ...overrides,
  };
}

function handlesLibraryOf(messages: Untyped) {
  return mergeGifs(undefined, messages).gifs;
}

const HANDLES_LINK_MSG = handleMsg('m1', {
  links: [{ id: 'm1#e0', kind: 'gif', url: TENOR, site: 'Tenor', title: 'Chat qui danse' }],
});
const HANDLES_FILE_MSG = handleMsg('m2', {
  attachments: [
    { id: 'att9', kind: 'gif', url: 'https://cdn.discordapp.com/a/att9/réaction.gif', name: 'réaction.gif' },
  ],
});

test('matchGifKey: own key first, then a link by url, never an attachment by url', () => {
  const has = (key: string) => key === 'k1';
  const byUrl = (url: string) => (url === TENOR ? 'k1' : null);
  assert.equal(matchGifKey({ key: 'k1', kind: 'attachment', url: 'x' }, has, byUrl), 'k1');
  assert.equal(matchGifKey({ key: 'k2', kind: 'link', url: TENOR }, has, byUrl), 'k1');
  assert.equal(matchGifKey({ key: 'k2', kind: 'attachment', url: TENOR }, has, byUrl), null);
  assert.equal(matchGifKey({ key: 'k2', kind: 'link', url: 'https://tenor.com/other' }, has, byUrl), null);
});

test('gifHandleMap / gifHandleOf: keys and link urls lead to the handle', () => {
  const handles = gifHandleMap(handlesLibraryOf([HANDLES_LINK_MSG, HANDLES_FILE_MSG]));
  assert.equal(gifHandleOf(handles, { id: 'm1#e0', url: TENOR }, 'link'), 'g1');
  assert.equal(gifHandleOf(handles, { id: 'm7#e0', url: TENOR }, 'link'), 'g1', 'a repost counts on the first entry');
  assert.equal(gifHandleOf(handles, { id: 'att9', url: 'https://cdn.discordapp.com/fresh' }, 'attachment'), 'g2');
  assert.equal(gifHandleOf(handles, { id: 'other', url: TENOR }, 'attachment'), null);
  assert.equal(gifHandleOf(handles, { id: TENOR }, 'attachment'), null, 'a url is never taken for a key');
  assert.equal(gifHandleOf(new Map(), { id: 'm1#e0', url: TENOR }, 'link'), null);
  assert.equal(gifHandleOf(undefined, { id: 'm1#e0', url: TENOR }, 'link'), null);
});

// --- the library across places ---------------------------------------------------

const A = 'place:room-1';
const B = 'place:room-2';
const PLACES_T0 = Date.UTC(2026, 10, 1);
const HOUR = 3_600_000;

/** A member's message in `placeId` carrying one GIF embed. */
function linkMessage(id: string, placeId: string, ts: number, url = TENOR, linkId = `${id}#e0`) {
  return {
    id,
    placeId,
    ts,
    attachments: [],
    links: [{ id: linkId, kind: 'gif', site: 'Tenor', title: '', text: '', url }],
  };
}

/** A member's message in `placeId` carrying one attached GIF. */
function attachedMessage(id: string, placeId: string, ts: number, attachmentId: string) {
  return {
    id,
    placeId,
    ts,
    links: [],
    attachments: [{ id: attachmentId, kind: 'gif', name: 'φάση.gif', url: `https://cdn.example/${attachmentId}.gif` }],
  };
}

const library = (messages: Array<ReturnType<typeof linkMessage> | ReturnType<typeof attachedMessage>>) =>
  mergeGifs(null, messages).gifs;

const only = (gifs: unknown) => {
  const entries = Object.values(normalizeGifs(gifs).entries);
  assert.equal(entries.length, 1, 'one entry');
  return entries[0];
};

test('a GIF seen in two places is one entry with a counter for each place', () => {
  const entry = only(
    library([
      linkMessage('m1', A, PLACES_T0),
      linkMessage('m2', A, PLACES_T0 + HOUR),
      linkMessage('m3', B, PLACES_T0 + 2 * HOUR),
    ])
  );
  const { [A]: here, [B]: there } = entry.places;
  assert.equal(here.count, 2);
  assert.equal(there.count, 1);
  assert.equal(here.last, PLACES_T0 + HOUR);
  assert.equal(there.last, PLACES_T0 + 2 * HOUR);
});

test('the entry keeps every native id it was seen under', () => {
  const entry = only(
    library([linkMessage('m1', A, PLACES_T0), linkMessage('m2', B, PLACES_T0 + HOUR, TENOR, 'second-embed')])
  );
  assert.deepEqual(entry.nativeIds, ['m1#e0', 'second-embed']);
  assert.deepEqual(entry.links, [TENOR]);
});

test('the file of a GIF keys its entry by content hash and joins an entry holding the same bytes', () => {
  const two = library([
    attachedMessage('m1', A, PLACES_T0, 'att-1'),
    attachedMessage('m2', B, PLACES_T0 + HOUR, 'att-2'),
  ]);
  const firstHandle = normalizeGifs(two).entries['att-1'].id;
  const joined = withGifFile(withGifFile(two, 'att-1', { hash: 'h1', file: 'media/gifs/h1.gif' }), 'att-2', {
    hash: 'h1',
    file: 'media/gifs/h1.gif',
  });
  const { entries } = normalizeGifs(joined);
  assert.deepEqual(Object.keys(entries), ['h1']);
  assert.equal(entries.h1.id, firstHandle, 'the older handle survives');
  assert.equal(entries.h1.file, 'media/gifs/h1.gif');
  assert.deepEqual(entries.h1.nativeIds, ['att-1', 'att-2']);
  const { [A]: here, [B]: there } = entries.h1.places;
  assert.equal(here.count, 1);
  assert.equal(there.count, 1);
});

test('the same bytes under two links keep both links', () => {
  const other = 'https://giphy.com/gifs/cat-dance';
  const two = library([linkMessage('m1', A, PLACES_T0), linkMessage('m2', B, PLACES_T0, other)]);
  const joined = withGifFile(withGifFile(two, 'm1#e0', { hash: 'h1', file: 'f' }), 'm2#e0', { hash: 'h1', file: 'f' });
  assert.deepEqual(only(joined).links, [TENOR, other]);
});

test('a later sighting under a known native id counts on the hashed entry', () => {
  const hashed = withGifFile(library([attachedMessage('m1', A, PLACES_T0, 'att-1')]), 'att-1', {
    hash: 'h1',
    file: 'media/gifs/h1.gif',
  });
  const entry = only(mergeGifs(hashed, [attachedMessage('m2', B, PLACES_T0 + HOUR, 'att-1')]).gifs);
  const there = entry.places[B];
  assert.equal(there.count, 1);
});

test('withGifFile on an unknown key leaves the library as it is', () => {
  const gifs = library([linkMessage('m1', A, PLACES_T0)]);
  assert.deepEqual(normalizeGifs(withGifFile(gifs, 'nobody', { hash: 'h9', file: 'f' })), normalizeGifs(gifs));
});

test('the global rank is the sum over places', () => {
  const popularHere = 'https://tenor.com/view/here';
  const popularEverywhere = 'https://tenor.com/view/everywhere';
  const gifs = library([
    linkMessage('m1', A, PLACES_T0, popularHere),
    linkMessage('m2', A, PLACES_T0, popularHere),
    linkMessage('m3', A, PLACES_T0, popularHere),
    linkMessage('m4', A, PLACES_T0, popularEverywhere),
    linkMessage('m5', A, PLACES_T0, popularEverywhere),
    linkMessage('m6', B, PLACES_T0, popularEverywhere),
    linkMessage('m7', B, PLACES_T0, popularEverywhere),
  ]);
  assert.deepEqual(
    rankGifs(gifs).map((entry) => entry.url),
    [popularEverywhere, popularHere]
  );
});

test('the slice of a place ranks by that place alone and leaves out what it never saw', () => {
  const here = 'https://tenor.com/view/here';
  const there = 'https://tenor.com/view/there';
  const elsewhere = 'https://tenor.com/view/elsewhere';
  const gifs = library([
    linkMessage('m1', A, PLACES_T0, here),
    linkMessage('m2', A, PLACES_T0, here),
    linkMessage('m3', A, PLACES_T0, there),
    linkMessage('m4', B, PLACES_T0, there),
    linkMessage('m5', B, PLACES_T0, there),
    linkMessage('m6', B, PLACES_T0, elsewhere),
  ]);
  assert.deepEqual(
    gifsOfPlace(gifs, A).map((entry) => [entry.url, entry.count]),
    [
      [here, 2],
      [there, 1],
    ]
  );
});

test('an own post is marked for the place it went to', () => {
  const gifs = library([linkMessage('m1', A, PLACES_T0), linkMessage('m2', B, PLACES_T0)]);
  const key = Object.keys(normalizeGifs(gifs).entries)[0];
  const { gifs: marked, marked: done } = markOwnGif(gifs, key, PLACES_T0 + HOUR, B);
  assert.equal(done, true);
  const entry = only(marked);
  const { [A]: here, [B]: there } = entry.places;
  assert.equal(there.ownLast, PLACES_T0 + HOUR);
  assert.equal(there.ownUses, 1);
  assert.equal(here.ownLast, undefined);
});

test('a recount of one place resets its counter and leaves the others', () => {
  // Bug: a place's recount over a shared library would wipe the counts of every other place.
  const gifs = library([
    linkMessage('m1', A, PLACES_T0),
    linkMessage('m2', B, PLACES_T0),
    linkMessage('m3', B, PLACES_T0),
  ]);
  const handle = only(gifs).id;
  const entry = only(resetGifCounts(gifs, A));
  const { [A]: here, [B]: there } = entry.places;
  assert.equal(here.count, 0);
  assert.equal(there.count, 2);
  assert.equal(entry.count, 2, 'the global count follows');
  assert.equal(entry.id, handle);
});

test('a stored counter that is no number is dropped and the global count is taken from the rest', () => {
  const entry = only({
    nextId: 2,
    entries: {
      k1: {
        id: 'g1',
        kind: 'link',
        url: TENOR,
        count: 99,
        last: PLACES_T0,
        places: { [A]: { count: 'πολλά', last: PLACES_T0 }, [B]: { count: 2, last: PLACES_T0 } },
      },
    },
  });
  assert.deepEqual(Object.keys(entry.places), [B]);
  assert.equal(entry.count, 2);
});

test('past storeMax the lowest global rank is evicted and its handle is never reused', () => {
  const kept = 'https://tenor.com/view/kept';
  const evicted = 'https://tenor.com/view/evicted';
  const gifs = library([
    linkMessage('m1', A, PLACES_T0, kept),
    linkMessage('m2', B, PLACES_T0, kept),
    linkMessage('m3', A, PLACES_T0, evicted),
  ]);
  const evictedHandle = String(rankGifs(gifs).at(-1)?.id);
  const { gifs: cut } = mergeGifs(gifs, [linkMessage('m4', A, PLACES_T0 + HOUR, 'https://tenor.com/view/new')], {
    storeMax: 2,
  });
  assert.equal(Object.keys(normalizeGifs(cut).entries).length, 2);
  assert.equal(findGif(cut, evictedHandle), null);
  const { gifs: again } = mergeGifs(cut, [linkMessage('m5', A, PLACES_T0 + HOUR, 'https://tenor.com/view/newer')]);
  assert.equal(findGif(again, evictedHandle), null);
});

// The candidate search.

/**
 * A library of entries with these texts, held as each entry's `description`, and the vectors the store's reader returns
 * by item id (the ordinary media vector of each row); `g1` is the most used.
 */
function captioned(items: Array<{ caption?: string; vector?: Array<number> }>) {
  const entries: Record<string, object> = {};
  const vectors = new Map<string, Array<number>>();
  items.forEach((item, index) => {
    const itemId = `item-${index + 1}`;
    entries[`k${index + 1}`] = {
      id: `g${index + 1}`,
      kind: 'link',
      url: `https://tenor.com/view/${index + 1}`,
      itemId,
      nativeIds: [itemId],
      count: items.length - index,
      last: PLACES_T0,
      firstSeen: PLACES_T0,
      // A GIF is stored as one text.
      ...(item.caption === undefined ? {} : { description: item.caption }),
    };
    if (item.vector) vectors.set(itemId, item.vector);
  });
  return { gifs: { nextId: items.length + 1, entries }, vectors };
}

const handles = (found: ReturnType<typeof searchGifs>) => found.map(({ entry }) => entry.id);

test('the search returns at most the cap, ordered by score', () => {
  const { gifs, vectors } = captioned(Array.from({ length: 10 }, (_, index) => ({ caption: `γάτα χορεύει ${index}` })));
  const found = searchGifs(gifs, { words: 'γάτα', vector: null, cap: 3, vectors });
  assert.equal(found.length, 3);
  const scores = found.map(({ score }) => score);
  assert.deepEqual(
    scores,
    [...scores].sort((one, two) => two - one)
  );
});

test('a caption that matches by words and by vector comes before one that matches by either', () => {
  const { gifs, vectors } = captioned([
    { caption: 'σκύλος τρέχει', vector: [0.6, 0.8] },
    { caption: 'γάτα κοιμάται', vector: [0, 1] },
    { caption: 'γάτα χορεύει', vector: [1, 0] },
  ]);
  assert.equal(handles(searchGifs(gifs, { words: 'γάτα', vector: [1, 0], cap: 5, vectors }))[0], 'g3');
});

test('a query word matches a caption in any case', () => {
  const { gifs, vectors } = captioned([{ caption: 'ΓΆΤΑ χορεύει' }]);
  assert.deepEqual(handles(searchGifs(gifs, { words: 'γάτα', vector: null, cap: 5, vectors })), ['g1']);
});

test('a vector alone finds a caption that shares no word', () => {
  const { gifs, vectors } = captioned([
    { caption: 'σκύλος', vector: [0, 1] },
    { caption: 'γατάκι', vector: [1, 0] },
  ]);
  assert.deepEqual(handles(searchGifs(gifs, { words: 'χαρά', vector: [1, 0], cap: 5, vectors })), ['g2']);
});

test('an entry with neither a word nor a similar vector is no candidate', () => {
  const { gifs, vectors } = captioned([{ caption: 'σκύλος', vector: [0, 1] }]);
  assert.deepEqual(searchGifs(gifs, { words: 'γάτα', vector: [1, 0], cap: 5, vectors }), []);
});

test('a GIF without a caption is never a candidate', () => {
  const { gifs, vectors } = captioned([{ vector: [1, 0] }]);
  assert.deepEqual(searchGifs(gifs, { words: 'γάτα', vector: [1, 0], cap: 5, vectors }), []);
});

test('equal scores go to the GIF used more', () => {
  const { gifs, vectors } = captioned([{ caption: 'γάτα' }, { caption: 'γάτα' }]);
  assert.deepEqual(handles(searchGifs(gifs, { words: 'γάτα', vector: null, cap: 5, vectors })), ['g1', 'g2']);
});

test('a vector of another dimension counts as no vector', () => {
  // Bug: a change of embedding model leaves old vectors in the library, and a comparison across lengths answers NaN.
  const { gifs, vectors } = captioned([{ caption: 'γάτα', vector: [1, 0, 0] }]);
  const found = searchGifs(gifs, { words: 'γάτα', vector: [1, 0], cap: 5, vectors });
  assert.deepEqual(handles(found), ['g1']);
  assert.ok(Number.isFinite(found[0].score));
});

test('an empty query or a cap of 0 finds nothing', () => {
  const { gifs, vectors } = captioned([{ caption: 'γάτα', vector: [1, 0] }]);
  assert.deepEqual(searchGifs(gifs, { words: ' ', vector: null, cap: 5, vectors }), []);
  assert.deepEqual(searchGifs(gifs, { words: 'γάτα', vector: null, cap: 0, vectors }), []);
});

// Tests of captionOfCached (src/memory/gifs.ts): the text of a cached GIF as a candidate line reads it.

// A GIF is one text, read whole; the join of three fields goes.
test('captionOfCached: the text of a GIF whole and trimmed, a miss or nothing empty', () => {
  const long = `a cat lifts its chin ${'and looks on '.repeat(22)}end`;
  assert.equal(long.length, 310);
  assert.equal(captionOfCached({ text: ` ${long} `, watched: true, gif: true }), long);
  assert.equal(captionOfCached({ miss: 'error', text: 'x' }), '');
  assert.equal(captionOfCached(undefined), '');
});
