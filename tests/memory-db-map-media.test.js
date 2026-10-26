// Round trips of media.js (attachment descriptions) and gifs.js (gifs and their counts) through the real schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as media from '../src/memory/db/map/media.js';
import * as gifs from '../src/memory/db/map/gifs.js';
import { assertRoundTrip } from './fixtures/memory-db/roundtrip.js';

test('media: each key is an attachment row with its description', () => {
  const file = {
    '1555006398444736533': { text: 'a photo of a café', ts: 1792000000000 },
    '1555006398444736534#a1': { ts: 1792000000001 },
    'link:f50d45f5a334fe43': { text: 'a page about moths', ts: 1792000000002 },
  };
  const rows = assertRoundTrip(media, 'media.json', file);
  assert.equal(rows.media.length, 3);
  const [first] = rows.media;
  assert.equal(first.id, 'media:attachment:1555006398444736533');
  assert.equal(first.kind, 'attachment');
  assert.equal(first.native_ref, '1555006398444736533');
  assert.equal(first.description, 'a photo of a café');
  assert.equal(first.scope_kind, 'group');
  assert.deepEqual(JSON.parse(first.extra), { ts: 1792000000000 });
  assert.equal(rows.media[1].description, null);
});

test('media: odd entries and an empty file survive', () => {
  assertRoundTrip(media, 'media.json', {});
  assertRoundTrip(media, 'media.json', {
    a: 'string',
    b: null,
    c: 5,
    d: { text: 5, ts: 'x' },
    e: { text: '', ts: 0 },
    f: [1],
  });
});

const gifEntry = (key, extra = {}) => ({
  id: key,
  kind: 'gif',
  url: 'https://example.test/g.gif',
  site: 'example',
  messageId: '400000000000000001',
  channelId: '200000000000000001',
  itemId: `gif-${key}`,
  name: 'dancing cat',
  firstSeen: 1792000000000,
  last: 1792000001000,
  count: 3,
  ...extra,
});

test('gifs: entries become gif rows and the counter stays operational', () => {
  const file = {
    nextId: 4,
    entries: { '1#e0': gifEntry('1#e0', { ownUses: 2, ownLast: 5 }), '2#e0': gifEntry('2#e0', { name: undefined }) },
  };
  delete file.entries['2#e0'].name;
  const rows = assertRoundTrip(gifs, 'gifs.json', file);
  assert.equal(rows.media.length, 2);
  const [first] = rows.media;
  assert.equal(first.id, 'media:gif:1#e0');
  assert.equal(first.kind, 'gif');
  assert.equal(first.path, 'https://example.test/g.gif');
  assert.equal(first.native_ref, '400000000000000001');
  assert.equal(first.description, 'dancing cat');
  assert.equal(rows.operational[0].kind, 'gifs');
  assert.deepEqual(JSON.parse(rows.operational[0].value), { nextId: 4, $has: ['entries'] });
});

test('gifs: odd entries and files survive', () => {
  assertRoundTrip(gifs, 'gifs.json', { nextId: 1, entries: {} });
  assertRoundTrip(gifs, 'gifs.json', { nextId: 1, entries: { a: 'x', b: { url: 5 }, c: null } });
  assertRoundTrip(gifs, 'gifs.json', { entries: [1, 2], nextId: 'x' });
  assertRoundTrip(gifs, 'gifs.json', {});
});
