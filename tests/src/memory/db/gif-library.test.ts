// Tests for src/memory/db/gif-library.ts: the GIF library as rows of `media`. A write puts and drops entries one row
// each, with the library's writer and holder columns and the row's graph node, and the read rebuilds the library from
// those rows and the library's own operational row. The last section holds where a row keeps its cached file, its link
// and its vector. Synthetic entries over a fresh memory database or a test store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gifLibraryValue, gifMediaVectors, writeGifLibrary } from '../../../../src/memory/db/gif-library.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db, Row } from '../../../../src/memory/db/types.ts';
import { applyMediaEmbed } from '../../../../src/memory/db/media-store.ts';
import { quantize } from '../../../../src/memory/vectors.ts';
import { createStore } from '../../../../src/memory/store.ts';
import { present } from '../../../fixtures/loose-types.ts';
import { memDataDir } from '../../../fixtures/store-kit.ts';
import { freshMemoryDb } from '../../../fixtures/memory-db-copy.ts';
import { join } from 'node:path';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { settle, withFakeCore } from '../../../fixtures/core-over-fake.ts';

const AT = Date.parse('2026-11-10T10:00:00Z');
const HOLDER = 'persona:local';

const entry = (id: string, itemId: string, extra: Row = {}): Row => ({
  id,
  kind: 'link',
  url: `https://tenor.com/view/${id}`,
  itemId,
  messageId: 'm1',
  placeId: 'discord:channel:c1',
  count: 1,
  last: AT,
  firstSeen: AT,
  nativeIds: [itemId],
  links: [`https://tenor.com/view/${id}`],
  places: { 'discord:channel:c1': { count: 1, last: AT } },
  ...extra,
});

/** The entries of the library the database holds. */
function entriesOf(db: Db): Row {
  const read = gifLibraryValue(db);
  assert.ok(read.found, 'the library is stored');
  return read.value.entries as Row;
}

const rowOf = (db: Db, id: string): Row | undefined => db.prepare('SELECT * FROM media WHERE id = ?').get(id);
const nodeOf = (db: Db, id: string): Row | undefined =>
  db.prepare('SELECT * FROM graph_nodes WHERE id = ?').get(`media:${id}`);
/** Whether a row's node is witnessed by itself: what a live row's node has and a retired row's lacks. */
const nodeLive = (db: Db, id: string): boolean =>
  db.prepare('SELECT 1 FROM node_access WHERE node_id = ? AND evidence_id = ?').get(`media:${id}`, `media:${id}`) !==
  undefined;

test('a put writes one row per entry with the library as its writer, the persona as holder and a graph node', () => {
  const handle = freshMemoryDb();
  try {
    const db = dbOf(handle);
    writeGifLibrary(
      db,
      { put: { k1: entry('g1', 'ref-1', { file: 'media/gifs/k1.gif' }) } },
      { iface: 'discord', at: AT }
    );
    const row = rowOf(db, 'media:gif:k1');
    assert.equal(row?.writer, 'gifs');
    assert.equal(row?.holder_id, HOLDER);
    assert.equal(row?.kind, 'gif');
    assert.equal(row?.native_ref, 'ref-1');
    assert.equal(row?.path, 'media/gifs/k1.gif');
    assert.equal(row?.scope_iface, 'discord');
    assert.ok(row?.audience_id);
    assert.equal(row?.retired_at, null);
    assert.ok(nodeOf(db, 'media:gif:k1'), 'the row has its graph node');
    assert.equal(nodeLive(db, 'media:gif:k1'), true);
  } finally {
    handle.close();
  }
});

test('the read rebuilds the entries in the order their rows were made, with the rest of the library', () => {
  const handle = freshMemoryDb();
  try {
    const db = dbOf(handle);
    assert.deepEqual(gifLibraryValue(db), { found: false });
    const k2 = entry('g2', 'ref-2');
    const k1 = entry('g1', 'ref-1', { file: 'media/gifs/k1.gif', caption: 'a cat' });
    const rest = { nextId: 3, backfill: { at: '2026-11-01', channels: 1, messages: 2 }, backfills: {} };
    writeGifLibrary(db, { put: { k2, k1 }, rest }, { iface: 'discord', at: AT });
    const read = gifLibraryValue(db);
    assert.equal(read.found, true);
    const value = (read as { value: Row }).value;
    assert.deepEqual(Object.keys(value.entries as Row), ['k2', 'k1']);
    // A GIF is stored as one text. A caption an entry brings is not kept on its row.
    const kept = Object.fromEntries(Object.entries(k1).filter(([field]) => field !== 'caption'));
    assert.deepEqual((value.entries as Row).k1, kept);
    assert.deepEqual((value.entries as Row).k2, k2);
    assert.equal(value.nextId, 3);
    assert.deepEqual(value.backfill, rest.backfill);
  } finally {
    handle.close();
  }
});

test('a put over a held row keeps what the row knows as an item: its description and cache entries', () => {
  const handle = freshMemoryDb();
  try {
    const db = dbOf(handle);
    writeGifLibrary(db, { put: { k1: entry('g1', 'ref-1') } }, { iface: 'discord', at: AT });
    db.prepare(
      "UPDATE media SET description = 'a dancing cat', extra = json_set(extra, '$.cache', json('{\"ref-1\":{\"ts\":5}}'), '$.textOrigin', 'retelling') WHERE id = 'media:gif:k1'"
    ).run();
    writeGifLibrary(db, { put: { k1: entry('g1', 'ref-1', { count: 2 }) } }, { iface: 'discord', at: AT + 1 });
    const row = rowOf(db, 'media:gif:k1');
    const extra = JSON.parse(String(row?.extra)) as Row;
    assert.equal(row?.description, 'a dancing cat');
    assert.deepEqual(extra.cache, { 'ref-1': { ts: 5 } });
    assert.equal(extra.textOrigin, 'retelling');
    assert.equal(extra.count, 2);
    const read = entriesOf(db).k1 as Row;
    assert.equal(read.count, 2);
    assert.equal(read.cache, undefined, 'the item fields stay out of the entry');
  } finally {
    handle.close();
  }
});

test('a drop retires the row and its node, and the read leaves the entry out', () => {
  const handle = freshMemoryDb();
  try {
    const db = dbOf(handle);
    writeGifLibrary(db, { put: { k1: entry('g1', 'ref-1'), k2: entry('g2', 'ref-2') } }, { iface: 'discord', at: AT });
    const answer = writeGifLibrary(db, { drop: ['k1'] }, { iface: 'discord', at: AT + 1 });
    assert.equal(answer.retired, 1);
    assert.ok(rowOf(db, 'media:gif:k1')?.retired_at);
    assert.equal(nodeLive(db, 'media:gif:k1'), false, 'the node is retired with its row');
    const entries = entriesOf(db);
    assert.deepEqual(Object.keys(entries), ['k2']);
  } finally {
    handle.close();
  }
});

test('a dropped entry whose row a line links stays live, as the whole-value write kept it', () => {
  const handle = freshMemoryDb();
  try {
    const db = dbOf(handle);
    writeGifLibrary(db, { put: { k1: entry('g1', 'ref-1') } }, { iface: 'discord', at: AT });
    db.prepare(
      "INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('source', 'line-1', 0, 'media:gif:k1')"
    ).run();
    assert.equal(writeGifLibrary(db, { drop: ['k1'] }, { iface: 'discord', at: AT + 1 }).retired, 0);
    assert.equal(rowOf(db, 'media:gif:k1')?.retired_at, null);
  } finally {
    handle.close();
  }
});

test('a put of a dropped entry revives its row', () => {
  const handle = freshMemoryDb();
  try {
    const db = dbOf(handle);
    writeGifLibrary(db, { put: { k1: entry('g1', 'ref-1') } }, { iface: 'discord', at: AT });
    writeGifLibrary(db, { drop: ['k1'] }, { iface: 'discord', at: AT + 1 });
    writeGifLibrary(db, { put: { k1: entry('g1', 'ref-1') } }, { iface: 'discord', at: AT + 2 });
    assert.equal(rowOf(db, 'media:gif:k1')?.retired_at, null);
    assert.equal(nodeLive(db, 'media:gif:k1'), true);
  } finally {
    handle.close();
  }
});

test('a put adopts an observed row of the same reference: its links and its text, and the observed row goes', () => {
  const handle = freshMemoryDb();
  try {
    const db = dbOf(handle);
    db.prepare(
      `INSERT INTO media (id, kind, native_ref, availability, extra, description, scope_kind, scope_iface, audience_id)
       VALUES ('media:discord:ref-1', 'gif', 'ref-1', 'present', '{"textOrigin":"retelling"}', 'a cat on a keyboard',
         'group', 'discord', 'aud:group:discord')`
    ).run();
    db.prepare(
      "INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('source', 'line-1', 0, 'media:discord:ref-1')"
    ).run();
    writeGifLibrary(db, { put: { k1: entry('g1', 'ref-1') } }, { iface: 'discord', at: AT });
    assert.equal(rowOf(db, 'media:discord:ref-1'), undefined);
    assert.equal(rowOf(db, 'media:gif:k1')?.description, 'a cat on a keyboard');
    const link = db.prepare("SELECT media_id FROM media_links WHERE owner_id = 'line-1'").get();
    assert.equal(link?.media_id, 'media:gif:k1');
  } finally {
    handle.close();
  }
});

test('an entry moved to a new key keeps one live row of its reference: the new one', () => {
  // Bug: the walk over every row of the library adopted the new row into the retired old one of the same reference and
  // deleted it, so the moved entry left the library at the next restart.
  const handle = freshMemoryDb();
  try {
    const db = dbOf(handle);
    writeGifLibrary(db, { put: { k1: entry('g1', 'ref-1') } }, { iface: 'discord', at: AT });
    db.prepare(
      "INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('source', 'line-1', 0, 'media:gif:k1')"
    ).run();
    writeGifLibrary(
      db,
      { drop: ['k1'], put: { hash1: entry('g1', 'ref-1', { hash: 'hash1', file: 'media/gifs/hash1.gif' }) } },
      { iface: 'discord', at: AT + 1 }
    );
    const live = db.prepare("SELECT id FROM media WHERE native_ref = 'ref-1' AND retired_at IS NULL").all();
    assert.deepEqual(
      live.map((row) => row.id),
      ['media:gif:hash1']
    );
    const link = db.prepare("SELECT media_id FROM media_links WHERE owner_id = 'line-1'").get();
    assert.equal(link?.media_id, 'media:gif:hash1');
    assert.deepEqual(Object.keys(entriesOf(db)), ['hash1']);
  } finally {
    handle.close();
  }
});

test('an entry that is not an object is kept whole and read back as it was', () => {
  const handle = freshMemoryDb();
  try {
    const db = dbOf(handle);
    writeGifLibrary(db, { put: { odd: 'not an entry' } }, { iface: 'discord', at: AT });
    const entries = entriesOf(db);
    assert.equal(entries.odd, 'not an entry');
  } finally {
    handle.close();
  }
});

// Bug: a GIF row keeps two texts, its `description` and `extra.caption`, which differ, and the media pick reads the
// caption. The one text is the row's description, which the read gives the
// entry, and a caption an older write left in `extra` reaches no reader.
test("the read gives a GIF entry its row's description as its one text and no caption", () => {
  const handle = freshMemoryDb();
  try {
    const db = dbOf(handle);
    writeGifLibrary(db, { put: { k1: entry('g1', 'ref-1') } }, { iface: 'discord', at: AT });
    db.prepare(
      "UPDATE media SET description = 'a cat waves', extra = json_set(extra, '$.caption', 'a dog runs') WHERE id = 'media:gif:k1'"
    ).run();
    const k1 = entriesOf(db).k1 as Row;
    assert.deepEqual([k1.description, k1.caption], ['a cat waves', undefined]);
  } finally {
    handle.close();
  }
});

// ---------- where a row keeps its file, its link and its vector ----------

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

// The media pick reads the ordinary media vector of a library row, the one the media embedding writes under
// `media:<row id>`, by the entry's item id.
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

const STORAGE_AT = Date.parse('2026-11-06T04:49:00Z');
const storageEntry = (id: string) => ({
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
  writeGifLibrary(db, { put: { k1: storageEntry('g1') }, rest: { nextId: 2 } }, { iface: 'discord', at: STORAGE_AT });
  // A database that already holds two library rows of one reference, the second with the text and a link.
  db.prepare(
    `INSERT INTO media (id, kind, path, native_ref, scope_kind, scope_iface, extra, description)
     SELECT 'media:gif:k2', kind, path, native_ref, scope_kind, scope_iface, extra, 'a cat on a keyboard'
     FROM media WHERE id = 'media:gif:k1'`
  ).run();
  db.prepare(
    "INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('source', 't', 0, 'media:gif:k2')"
  ).run();

  writeGifLibrary(db, { put: { k2: storageEntry('g2') }, rest: { nextId: 3 } }, { iface: 'discord', at: STORAGE_AT });

  const rows = db.prepare("SELECT id, description FROM media WHERE kind = 'gif' AND native_ref = 'same-ref'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, 'a cat on a keyboard');
  const link = db.prepare("SELECT media_id FROM media_links WHERE owner_id = 't'").get();
  assert.equal(link?.media_id, rows[0].id);
  handle.close();
});

// An entry that gets its file moves to the key of its content hash, a write that drops the old key and puts the new
// one. Bug: the move drops the describer's cache and the media vector of the old row.

const HASH = 'f1e2d3';
const described = (db: ReturnType<typeof dbOf>, key: string, text: string, model: string) => {
  const id = `media:gif:${key}`;
  const row = db.prepare('SELECT extra FROM media WHERE id = ?').get(id);
  const extra = {
    ...(JSON.parse(String(row?.extra)) as object),
    cache: { [key]: { ts: STORAGE_AT, model: 'vision-model' } },
  };
  db.prepare('UPDATE media SET description = ?, extra = ? WHERE id = ?').run(text, JSON.stringify(extra), id);
  const { bytes, scale, norm } = quantize(Float32Array.from([0.6, 0.8]));
  applyMediaEmbed(db, {
    rows: [{ mediaId: id, bytes, scale, norm, dims: 2, model, description: text, now: STORAGE_AT }],
  });
};
const filed = (id: string, itemId: string) => ({
  ...storageEntry(id),
  itemId,
  hash: HASH,
  file: `media/gifs/${HASH}.gif`,
});

test("an entry that moves to its content hash keeps the describer's cache of its row", () => {
  const handle = freshMemoryDb();
  const db = dbOf(handle);
  writeGifLibrary(db, { put: { k1: storageEntry('g1') } }, { iface: 'discord', at: STORAGE_AT });
  described(db, 'k1', 'a cat on a keyboard', 'm/one');
  writeGifLibrary(db, { drop: ['k1'], put: { [HASH]: filed('g1', 'same-ref') } }, { iface: 'discord', at: STORAGE_AT });
  const row = db.prepare('SELECT extra FROM media WHERE id = ?').get(`media:gif:${HASH}`);
  const cache = (JSON.parse(String(row?.extra)) as { cache?: Record<string, { model?: string }> }).cache;
  assert.equal(cache?.k1?.model, 'vision-model');
  handle.close();
});

test('a join of two entries by content hash keeps the description and the vector of the entry that has them', () => {
  const handle = freshMemoryDb();
  const db = dbOf(handle);
  // The older entry already holds the file under the hash; the younger, of another item reference, holds the text.
  writeGifLibrary(db, { put: { [HASH]: filed('g1', 'ref-old') } }, { iface: 'discord', at: STORAGE_AT });
  writeGifLibrary(
    db,
    { put: { k2: { ...storageEntry('g2'), itemId: 'ref-new' } } },
    { iface: 'discord', at: STORAGE_AT }
  );
  described(db, 'k2', 'a dog spins around', 'm/one');
  const joined = { ...filed('g1', 'ref-old'), nativeIds: ['ref-old', 'ref-new'], description: 'a dog spins around' };
  writeGifLibrary(db, { drop: ['k2'], put: { [HASH]: joined } }, { iface: 'discord', at: STORAGE_AT });
  const row = db.prepare('SELECT description FROM media WHERE id = ?').get(`media:gif:${HASH}`);
  assert.equal(row?.description, 'a dog spins around');
  assert.ok(gifMediaVectors(db, 'm/one').get('ref-old'), 'the joined entry is found by meaning');
  handle.close();
});

const LIBRARY_AT = Date.UTC(2026, 10, 18);

/** A library of three link GIFs with descriptions and no files, as a start finds an old one. */
function seedLibrary(dataDir: string): void {
  const handle = openMemoryDb(join(dataDir, 'memory.db'));
  try {
    const db = dbOf(handle);
    const put: Record<string, object> = {};
    for (const n of [1, 2, 3]) {
      put[`k${n}`] = {
        id: `g${n}`,
        kind: 'link',
        url: `https://gifs.example/view/${n}`,
        fileUrl: `https://media.gifs.example/${n}.mp4`,
        itemId: `m${n}#e0`,
        nativeIds: [`m${n}#e0`],
        links: [`https://gifs.example/view/${n}`],
        count: 1,
        last: LIBRARY_AT,
        firstSeen: LIBRARY_AT,
      };
    }
    writeGifLibrary(db, { put }, { iface: 'fake', at: LIBRARY_AT });
  } finally {
    handle.close();
  }
}

test('the start asks no address of a library GIF that has no file', async () => {
  const asked: Array<string> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input: Parameters<typeof fetch>[0]) => {
    const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    asked.push(address);
    return Promise.reject(new Error('no network in a test'));
  };
  try {
    await withFakeCore({ prepare: seedLibrary }, async () => {
      await settle(500);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(
    asked.filter((address) => address.includes('gifs.example')),
    []
  );
});
