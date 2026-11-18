// Where the shared GIF library keeps a file and a vector: a `media` row's `path` is null or a file under `media/`, the link
// sits in `extra.url`, and the row's vector is its ordinary media vector in the `vectors` table. Plan
// 2026-11-04-cli-and-memory, stage B7, the owner's structure of one media store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gifLibraryValue, gifMediaVectors, writeGifLibrary } from '../src/memory/db/gif-library.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { applyMediaEmbed } from '../src/memory/db/media-store.ts';
import { quantize } from '../src/memory/vectors.ts';
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

// Spec 2026-11-18, the library without the keeper: the media pick reads the ordinary media vector of a library row, the
// one the media embedding writes under `media:<row id>`, by the entry's item id.
test("the library's media vectors are read by item id from the ordinary media vector of each row", async () => {
  const { memoryDb, store, key } = rig();
  const { itemId } = store.getGifs().entries[key];
  store.putMediaEntry(PLACE, itemId, { text: 'μια γάτα χορεύει', ts: T0 });
  store.flush();
  await store.flushSettled({});
  const db = dbOf(present(memoryDb.database()));
  const row = db.prepare("SELECT id, description FROM media WHERE writer = 'gifs'").get();
  assert.ok(row?.description, 'the library row holds the description');
  const { bytes, scale, norm } = quantize(Float32Array.from([0.6, 0.8]));
  applyMediaEmbed(present(memoryDb.database()), {
    rows: [{ mediaId: row.id, bytes, scale, norm, dims: 2, model: 'm/one', description: row.description, now: T0 }],
  });
  const vector = store.gifMediaVectors('m/one').get(itemId);
  assert.ok(vector, 'the row is found by its item id');
  assert.ok(Math.abs(vector[0] - 0.6) < 0.02 && Math.abs(vector[1] - 0.8) < 0.02, String(vector));
  assert.equal(store.gifMediaVectors('m/two').size, 0, 'a vector of another model is none');
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
    `INSERT INTO media (id, kind, path, native_ref, scope_kind, scope_iface, extra, description)
     SELECT 'media:gif:k2', kind, path, native_ref, scope_kind, scope_iface, extra, 'a cat on a keyboard'
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

// Report 2026-11-18 gif-files-backfill: an entry that gets its file moves to the key of its content hash, a write that
// drops the old key and puts the new one. The move dropped the describer's cache and the media vector of the old row.

const HASH = 'f1e2d3';
const described = (db: ReturnType<typeof dbOf>, key: string, text: string, model: string) => {
  const id = `media:gif:${key}`;
  const row = db.prepare('SELECT extra FROM media WHERE id = ?').get(id);
  const extra = { ...(JSON.parse(String(row?.extra)) as object), cache: { [key]: { ts: AT, model: 'vision-model' } } };
  db.prepare('UPDATE media SET description = ?, extra = ? WHERE id = ?').run(text, JSON.stringify(extra), id);
  const { bytes, scale, norm } = quantize(Float32Array.from([0.6, 0.8]));
  applyMediaEmbed(db, {
    rows: [{ mediaId: id, bytes, scale, norm, dims: 2, model, description: text, now: AT }],
  });
};
const filed = (id: string, itemId: string) => ({ ...entry(id), itemId, hash: HASH, file: `media/gifs/${HASH}.gif` });

test("an entry that moves to its content hash keeps the describer's cache of its row", () => {
  const handle = freshMemoryDb();
  const db = dbOf(handle);
  writeGifLibrary(db, { put: { k1: entry('g1') } }, { iface: 'discord', at: AT });
  described(db, 'k1', 'a cat on a keyboard', 'm/one');
  writeGifLibrary(db, { drop: ['k1'], put: { [HASH]: filed('g1', 'same-ref') } }, { iface: 'discord', at: AT });
  const row = db.prepare('SELECT extra FROM media WHERE id = ?').get(`media:gif:${HASH}`);
  const cache = (JSON.parse(String(row?.extra)) as { cache?: Record<string, { model?: string }> }).cache;
  assert.equal(cache?.k1?.model, 'vision-model');
  handle.close();
});

test('a join of two entries by content hash keeps the description and the vector of the entry that has them', () => {
  const handle = freshMemoryDb();
  const db = dbOf(handle);
  // The older entry already holds the file under the hash; the younger, of another item reference, holds the text.
  writeGifLibrary(db, { put: { [HASH]: filed('g1', 'ref-old') } }, { iface: 'discord', at: AT });
  writeGifLibrary(db, { put: { k2: { ...entry('g2'), itemId: 'ref-new' } } }, { iface: 'discord', at: AT });
  described(db, 'k2', 'a dog spins around', 'm/one');
  const joined = { ...filed('g1', 'ref-old'), nativeIds: ['ref-old', 'ref-new'], description: 'a dog spins around' };
  writeGifLibrary(db, { drop: ['k2'], put: { [HASH]: joined } }, { iface: 'discord', at: AT });
  const row = db.prepare('SELECT description FROM media WHERE id = ?').get(`media:gif:${HASH}`);
  assert.equal(row?.description, 'a dog spins around');
  assert.ok(gifMediaVectors(db, 'm/one').get('ref-old'), 'the joined entry is found by meaning');
  handle.close();
});
