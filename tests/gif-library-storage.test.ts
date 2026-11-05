// Where the shared GIF library keeps a file and a vector: a `media` row's `path` is null or a file under `media/`, the link
// sits in `extra.url`, and a vector lives in the `vectors` table, outside the library's JSON. Plan
// 2026-11-04-cli-and-memory, stage B7, the owner's structure of one media store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toRows } from '../src/memory/db/map/gifs.ts';
import { migrateMediaStore } from '../src/memory/db/media-store.ts';
import { mergeGifLibraries } from '../src/memory/db/gif-library-merge.ts';
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
  const entry = { id: 'g1', kind: 'link', url: TENOR, count: 1, file: 'media/gifs/h1.gif' };
  const [row] = toRows('gifs', { nextId: 2, entries: { h1: entry } }).media;
  assert.equal(row.path, 'media/gifs/h1.gif');
  assert.equal((JSON.parse(String(row.extra)) as { url: string }).url, TENOR);
});

test('a row with no cached file has no path, and a file outside media/ never becomes one', () => {
  const rows = toRows('gifs', {
    nextId: 3,
    entries: {
      k1: { id: 'g1', kind: 'link', url: TENOR, count: 1 },
      k2: { id: 'g2', kind: 'link', url: TENOR, count: 1, file: '/etc/passwd' },
    },
  }).media;
  assert.deepEqual(
    rows.map((row) => row.path),
    [null, null]
  );
});

test('an old row with a link in path, live or retired, moves it to extra and the library reads the same', () => {
  const handle = freshMemoryDb();
  const db = dbOf(handle);
  // Rows of the old table: the store's own table refuses a link in `path`, so the one migration moves them.
  db.exec(`DROP TABLE media_links; DROP TABLE media; ALTER TABLE sources ADD COLUMN media TEXT;
    CREATE TABLE media (id TEXT PRIMARY KEY, kind TEXT, owner TEXT, path TEXT, native_ref TEXT, description TEXT, described_at TEXT,
      sha1 TEXT, bytes INTEGER, mime TEXT, scope_kind TEXT, scope_iface TEXT, scope_dm TEXT, audience_id TEXT, extra JSON, owner_file TEXT, retired_at TEXT, owner_key TEXT);`);
  const insert = db.prepare(
    `INSERT INTO media (id, kind, path, scope_kind, scope_iface, extra, retired_at) VALUES (?, 'gif', ?, 'group', 'discord', ?, ?)`
  );
  insert.run('media:gif:live', TENOR, JSON.stringify({ id: 'g1', kind: 'link', count: 2 }), null);
  insert.run('media:gif:old', 'https://tenor.com/view/gone', null, '2026-01-01T00:00:00.000Z');
  insert.run('media:gif:cached', 'media/gifs/h.gif', JSON.stringify({ url: TENOR }), null);
  migrateMediaStore(db);
  mergeGifLibraries(db);
  const rows = db.prepare("SELECT id, path, extra FROM media WHERE kind = 'gif' ORDER BY id").all();
  const urlOf = (row: Record<string, unknown>) => (JSON.parse(String(row.extra)) as { url?: string }).url;
  assert.deepEqual(
    rows.map((row) => [row.id, row.path, urlOf(row)]),
    [
      ['media:gif:cached', 'media/gifs/h.gif', TENOR],
      ['media:gif:live', null, TENOR],
      ['media:gif:old', null, 'https://tenor.com/view/gone'],
    ]
  );
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
  const write = memoryDb.writeUnit.bind(memoryDb);
  memoryDb.writeUnit = (update: unknown) => {
    sent.push(JSON.stringify(update));
    return write(update);
  };
  store.setGifCaption(key, { caption: 'μια γάτα', vector: [0.6, 0.8], model: 'm/one' });
  store.flush();
  await store.flushSettled({});
  const values = sent.filter((text) => (JSON.parse(text) as { op?: string }).op === 'value');
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
