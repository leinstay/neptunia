// Tests for src/behavior/pull.ts: the age rail of a read of another conversation and the pictures of its lines that may
// get a caption. No I/O: the clock is passed in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTooOld, pullPictures } from '../src/behavior/pull.ts';

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
// The owner's example: the channel's last message was at 10:00 two days ago.
const LAST = Date.UTC(2026, 9, 3, 10, 0, 0);

/** A normalized message of another member; `channels` are its explicit `<#id>` mentions. */
function msg(
  id: string,
  ts: number,
  {
    channels = [],
    content = 'καλημέρα',
    attachments = [],
    links = [],
    stickers = [],
    emojis = [],
    bot = false,
    self = false,
  }: {
    channels?: Array<unknown>;
    content?: string;
    attachments?: Array<unknown>;
    links?: Array<unknown>;
    stickers?: Array<unknown>;
    emojis?: Array<unknown>;
    bot?: boolean;
    self?: boolean;
  } = {}
) {
  return {
    id,
    ts,
    placeId: 'ch-there',
    authorId: `u-${id}`,
    authorName: `Zoé ${id}`,
    self,
    bot,
    content,
    mentionedChannelIds: channels,
    attachments,
    links,
    stickers,
    emojis,
  };
}

/** A custom emoji as interfaces/discord/collect.ts normalizes it. */
function emoji(id: string) {
  return { id, name: `έμοτζι_${id}`, animated: false, url: `https://cdn.example/emojis/${id}.png` };
}

/** `minutes` before the anchor `LAST`. */
function at(minutes: number) {
  return LAST - minutes * MIN;
}

function image(id: string) {
  return { id, kind: 'image', url: `https://cdn.example/${id}.png`, name: `${id}.png` };
}

test('isTooOld: maxAgeDays 0 never refuses, a positive one refuses only past it', () => {
  assert.equal(isTooOld(NOW - 900 * DAY, { maxAgeDays: 0, now: NOW }), false);
  assert.equal(isTooOld(NOW - 900 * DAY, { now: NOW }), false, 'the default is no limit');
  assert.equal(isTooOld(NOW - 2 * DAY, { maxAgeDays: 2, now: NOW }), false, 'exactly maxAgeDays old is still pulled');
  assert.equal(isTooOld(NOW - 2 * DAY - 1, { maxAgeDays: 2, now: NOW }), true);
  assert.equal(isTooOld(null, { maxAgeDays: 2, now: NOW }), false, 'an unknown age is not judged here');
});

// ---- pullPictures ----------------------------------------------------------------

test('pullPictures: newest first, at most maxPictures, the rest counted', () => {
  const messages = [
    msg('m1', at(30), { attachments: [image('a1'), image('a2')] }),
    msg('m2', at(20), {
      links: [{ id: 'link:λ', kind: 'link', thumbnailUrl: 'https://cdn.example/l.png', title: 'Café' }],
      stickers: [{ id: 's1', name: 'σ', url: 'https://cdn.example/s1.png' }],
    }),
    msg('m3', at(10), { attachments: [image('c1'), image('c2'), image('c3')] }),
  ];
  const { items, rest, overflow } = pullPictures(messages, 4);
  assert.deepEqual(
    items.map((item) => item.itemId),
    ['c1', 'c2', 'c3', 'link:λ'],
    'newest message first, each message in its own order'
  );
  assert.equal(items[0].messageId, 'm3');
  assert.deepEqual(
    rest.map((item) => item.itemId),
    ['sticker:s1', 'a1', 'a2']
  );
  assert.equal(overflow, 3, 'the sticker of m2 and both pictures of m1');

  assert.deepEqual(pullPictures(messages, 0).items, []);
  assert.equal(pullPictures(messages, 0).rest.length, 7);
  assert.equal(pullPictures(messages, 0).overflow, 7);
  assert.equal(pullPictures(messages, 2.5).items.length, 2, 'a fractional maxPictures is floored');
});

test('pullPictures: pictures past maxPictures are returned for the cache, not only counted', () => {
  const same = { id: 'link:same', kind: 'link', thumbnailUrl: 'https://cdn.example/same.png', title: 'Crème' };
  const messages = Array.from({ length: 12 }, (_, i) =>
    msg(`m${i}`, at(60 - i), { attachments: [image(`p${i}`)], links: i === 0 || i === 11 ? [same] : [] })
  );
  const { items, rest, overflow } = pullPictures(messages, 10);
  assert.deepEqual(
    items.map((item) => item.itemId),
    ['p11', 'link:same', 'p10', 'p9', 'p8', 'p7', 'p6', 'p5', 'p4', 'p3']
  );
  assert.deepEqual(
    rest.map((item) => [item.itemId, item.messageId]),
    [
      ['p2', 'm2'],
      ['p1', 'm1'],
      ['p0', 'm0'],
    ],
    'same order, the repeated link only once, at its newest message'
  );
  assert.equal(overflow, rest.length);
  assert.equal(
    new Set([...items, ...rest].map((item) => item.itemId)).size,
    13,
    'every picture of the window, each once'
  );
});

test('pullPictures: custom emoji come apart from the pictures, each once at its newest message', () => {
  const messages = [
    msg('m1', at(20), { emojis: [emoji('e1'), emoji('e2')], attachments: [image('a1')] }),
    msg('m2', at(10), { emojis: [emoji('e1')], attachments: [image('b1')] }),
  ];
  const { items, rest, overflow, emoji: emojiItems } = pullPictures(messages, 1);
  assert.deepEqual(
    items.map((item) => item.itemId),
    ['b1']
  );
  assert.deepEqual(
    rest.map((item) => item.itemId),
    ['a1']
  );
  assert.equal(overflow, 1, 'emoji never count toward maxPictures or the overflow');
  assert.deepEqual(
    emojiItems.map((item) => [item.itemId, item.messageId, item.kind]),
    [
      ['emoji:e1', 'm2', 'emoji'],
      ['emoji:e2', 'm1', 'emoji'],
    ]
  );
  assert.deepEqual(pullPictures(messages, 0).emoji.length, 2, 'emoji are returned whatever maxPictures says');
});

test('pullPictures: only describable pictures, each picture once', () => {
  const link = { id: 'link:same', kind: 'link', thumbnailUrl: 'https://cdn.example/same.png', title: 'Crème' };
  const messages = [
    msg('m1', at(20), { links: [link], content: 'ü' }),
    msg('m2', at(10), {
      links: [link, { id: 'link:rich', kind: 'rich', thumbnailUrl: 'https://cdn.example/rich.png' }],
      attachments: [{ id: 'f1', kind: 'file', url: 'https://cdn.example/f1.zip', name: 'f1.zip' }],
    }),
  ];
  const { items, overflow } = pullPictures(messages, 10);
  assert.deepEqual(
    items.map((item) => [item.itemId, item.messageId]),
    [['link:same', 'm2']],
    'the same link twice is one picture, at its newest message'
  );
  assert.equal(overflow, 0);
});
