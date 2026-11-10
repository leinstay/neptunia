// Where the shared GIF library keeps a file and a vector: a `media` row's `path` is null or a file under `media/`, the link
// sits in `extra.url`, and a vector lives in the `vectors` table, outside the library's JSON. Plan
// 2026-11-04-cli-and-memory, stage B7, the owner's structure of one media store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gifLibraryValue, writeGifLibrary } from '../src/memory/db/gif-library.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { present } from './fixtures/loose-types.ts';
import { memDataDir } from './fixtures/store-kit.ts';
import { freshMemoryDb } from './fixtures/memory-db-copy.ts';

const PLACE = 'place:room-1';
const T0 = Date.UTC(2026, 10, 1);
const TENOR = 'https://tenor.com/view/cat-dance-123';

const linkMessage = (id: string) => ({
  id,
  placeId: PLACE,
  ts: T0,
  attachments: [],
  links: [{ id: `${id}#e0`, kind: 'gif', site: 'Tenor', title: '', text: '', url: TENOR }],
});

test('a row keeps the cached file in path and the link in extra', () => {
  const handle = freshMemoryDb();
  const db = dbOf(handle);
  const entry = { id: 'g1', kind: 'link', url: TENOR, count: 1, file: 'media/gifs/h1.gif' };
  writeGifLibrary(db, { put: { h1: entry } }, { iface: 'discord', at: T0 });
  const row = db.prepare("SELECT path, extra FROM media WHERE id = 'media:gif:h1'").get();
  assert.equal(row?.path, 'media/gifs/h1.gif');
  assert.equal((JSON.parse(String(row?.extra)) as { url: string }).url, TENOR);
  handle.close();
});

test('a row with no cached file has no path, and a file outside media/ never becomes one', () => {
  const handle = freshMemoryDb();
  const db = dbOf(handle);
  writeGifLibrary(
    db,
    {
      put: {
        k1: { id: 'g1', kind: 'link', url: TENOR, count: 1 },
        k2: { id: 'g2', kind: 'link', url: TENOR, count: 1, file: '/etc/passwd' },
      },
    },
    { iface: 'discord', at: T0 }
  );
  assert.deepEqual(
    db
      .prepare("SELECT path FROM media WHERE kind = 'gif' ORDER BY id")
      .all()
      .map((row) => row.path),
    [null, null]
  );
  const entries = (gifLibraryValue(db) as unknown as { value: { entries: Record<string, { file?: string }> } }).value
    .entries;
  assert.equal(entries.k2.file, '/etc/passwd', 'the entry still says what it was given');
  handle.close();
});

function rig() {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  store.recordGifs(PLACE, [linkMessage('m1')]);
  const [key] = Object.keys(store.getGifs().entries);
  return { dir, memoryDb, store, key };
}

test('a flush of the library writes no vector bytes', async () => {
  // Bug: 1024 numbers per entry in the unit's JSON made each flush about 2 MB at a full library.
  const { memoryDb, store, key } = rig();
  const sent: Array<string> = [];
  const write = memoryDb.writeGifLibrary.bind(memoryDb);
  memoryDb.writeGifLibrary = (update) => {
    sent.push(JSON.stringify(update));
    return write(update);
  };
  store.setGifCaption(key, { caption: 'μια γάτα', vector: [0.6, 0.8], model: 'm/one' });
  store.flush();
  await store.flushSettled({});
  const values = sent;
  assert.ok(values.length > 0, 'the library was flushed');
  for (const text of values) assert.ok(!text.includes('vector'), text.slice(0, 200));
  const db = dbOf(present(memoryDb.readHandle()));
  const row = db.prepare("SELECT extra FROM media WHERE kind = 'gif'").get();
  assert.ok(!String(row?.extra).includes('vector'));
  assert.ok(!String(row?.extra).includes('0.6'));
});

test('a vector reads back from the vectors table after a restart, with the audience of its library row', async () => {
  const { dir, memoryDb, store, key } = rig();
  store.setGifCaption(key, { caption: 'μια γάτα', vector: [0.6, 0.8], model: 'm/one' });
  store.flush();
  await store.flushSettled({});
  const db = dbOf(present(memoryDb.readHandle()));
  const row = db.prepare("SELECT model, dims, audience_id FROM vectors WHERE chunk_key LIKE 'gif:%'").get();
  const media = db.prepare("SELECT audience_id FROM media WHERE kind = 'gif'").get();
  assert.deepEqual([row?.model, row?.dims], ['m/one', 2]);
  assert.ok(row?.audience_id);
  assert.equal(row?.audience_id, media?.audience_id);
  const again = createStore({ dataDir: dir, memoryDb });
  const vector = again.getGifVectors('m/one').get(again.getGifs().entries[key].itemId);
  assert.ok(vector);
  assert.ok(Math.abs(vector[0] - 0.6) < 0.01 && Math.abs(vector[1] - 0.8) < 0.01, String(vector));
});

test('a vector of another model is none, and the key an entry moves to keeps it', () => {
  const { store, key } = rig();
  const { itemId } = store.getGifs().entries[key];
  store.setGifCaption(key, { caption: 'μια γάτα', vector: [0.6, 0.8], model: 'm/one' });
  assert.equal(store.getGifVectors('m/two').size, 0);
  store.setGifFile(key, { hash: 'h1', file: 'media/gifs/h1.gif' });
  assert.equal(store.getGifs().entries.h1.itemId, itemId);
  assert.ok(store.getGifVectors('m/one').has(itemId));
});

// A write of the GIF library when two of its own rows spell one item reference (media-store.ts, adoptSameItem).

const AT = Date.parse('2026-11-06T04:49:00Z');
const entry = (id: string) => ({
  id,
  kind: 'link',
  url: `https://tenor.com/view/${id}`,
  itemId: 'same-ref',
  count: 1,
  last: 1,
});

test('a write of the library keeps one row when two of its entries share an item reference', () => {
  // Bug: the walk adopted the second row into the first and deleted it, then read the deleted row on its own turn and
  // threw "Cannot read properties of undefined (reading 'extra')", so every write of the library failed.
  const handle = freshMemoryDb();
  const db = dbOf(handle);
  writeGifLibrary(db, { put: { k1: entry('g1') }, rest: { nextId: 2 } }, { iface: 'discord', at: AT });
  // A database that already holds two library rows of one reference, the second with the text and a link.
  db.prepare(
    `INSERT INTO media (id, kind, path, native_ref, scope_kind, scope_iface, extra, owner_key, description)
     SELECT 'media:gif:k2', kind, path, native_ref, scope_kind, scope_iface, extra, owner_key, 'a cat on a keyboard'
     FROM media WHERE id = 'media:gif:k1'`
  ).run();
  db.prepare(
    "INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('source', 't', 0, 'media:gif:k2')"
  ).run();

  writeGifLibrary(db, { put: { k2: entry('g2') }, rest: { nextId: 3 } }, { iface: 'discord', at: AT });

  const rows = db.prepare("SELECT id, description FROM media WHERE kind = 'gif' AND native_ref = 'same-ref'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, 'a cat on a keyboard');
  const link = db.prepare("SELECT media_id FROM media_links WHERE owner_id = 't'").get();
  assert.equal(link?.media_id, rows[0].id);
  handle.close();
});
