// The describer's cache as rows of `media` (src/memory/db/media-store.ts): an entry lives on the row of its item and
// nowhere else, written by the write kind `media-entry` one row at a time and read by its key with one query, through
// the store's `putMediaEntry`, `dropMediaEntry`, `mediaEntry`, `mediaEntries` and `getMediaDescription`. The tests cover
// the store over a reopen, a read in the tick of its write, the row a write leaves (its owner columns and its graph
// node), a drop, the trim by last use, a saved description of a trimmed row, and version step 52, which gives the rows
// of the media caches and the GIF library their owner columns and folds the media descriptions into their rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MEDIA_CACHE_ENTRIES } from '../src/memory/db/media-store.ts';
import { ownMediaRows } from '../src/memory/db/media-owner.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';
import { NOW, ROOT, copyOf, seededPlaces } from './fixtures/memory-db/place-writes.ts';

const DESCRIBED = { text: 'a cat on a synthetic sofa', ts: NOW - 1000, describedAt: NOW - 1000, model: 'vision-model' };

const put = (handle: MemoryHandle, key: string, entry: Row, now = NOW): unknown =>
  applyMemoryWrite(handle, { kind: 'media-entry', op: 'put', placeId: ROOT, key, entry, iface: 'discord', now });

const rowsHolding = (db: Db, key: string): Array<Row> =>
  db
    .prepare('SELECT * FROM media ORDER BY rowid')
    .all()
    .filter((row) =>
      Object.hasOwn((JSON.parse(typeof row.extra === 'string' ? row.extra : '{}') as { cache?: Row }).cache ?? {}, key)
    );

test('an entry written through the store is read back by a new store on the same database', async () => {
  const dataDir = tempDataDir('nep-media-cache-reopen-');
  const first = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: first.memoryDb });
    store.putMediaEntry(ROOT, 'att-1', DESCRIBED);
    store.putMediaEntry(ROOT, 'video:att-2', { miss: true, ts: NOW, reason: 'size' });
    await store.flushSettled({});
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: second.memoryDb });
    assert.deepEqual(store.mediaEntry(ROOT, 'att-1'), DESCRIBED);
    assert.deepEqual(store.mediaEntries(ROOT, ['att-1', 'video:att-2', 'att-9']), {
      'att-1': DESCRIBED,
      'video:att-2': { miss: true, ts: NOW, reason: 'size' },
    });
    assert.deepEqual(Object.keys(store.mediaEntries(ROOT)).sort(), ['att-1', 'video:att-2']);
  } finally {
    await second.close();
  }
});

test('a read in the tick of its write answers the written entry', async () => {
  const opened = await openTestMemory({ now: () => NOW, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir: opened.dataDir, memoryDb: opened.memoryDb });
    store.putMediaEntry(ROOT, 'att-1', DESCRIBED);
    assert.deepEqual(store.mediaEntry(ROOT, 'att-1'), DESCRIBED);
    store.dropMediaEntry(ROOT, 'att-1');
    assert.equal(store.mediaEntry(ROOT, 'att-1'), undefined);
    await store.flushSettled({});
    assert.equal(store.mediaEntry(ROOT, 'att-1'), undefined);
  } finally {
    await opened.close();
  }
});

test('a written entry is one row of its item, with the writer, the holder and its graph node', () => {
  // Bug (tracker row 25): a row the cache wrote got no graph node until a reproject.
  const handle = copyOf(seededPlaces());
  try {
    put(handle, 'att-1', DESCRIBED);
    put(handle, 'att-1', { ...DESCRIBED, usedAt: NOW + 5 }, NOW + 5);
    const db = dbOf(handle);
    const rows = rowsHolding(db, 'att-1');
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.deepEqual(
      [row.writer, row.holder_id, row.used_at, row.description],
      ['media', ROOT, NOW + 5, DESCRIBED.text]
    );
    assert.equal(db.prepare('SELECT kind FROM graph_nodes WHERE id = ?').get(`media:${String(row.id)}`)?.kind, 'media');
  } finally {
    handle.close();
  }
});

test('a dropped key leaves its row, and a row that holds no other key and no link is retired', () => {
  const handle = copyOf(seededPlaces());
  try {
    put(handle, 'att-1', DESCRIBED);
    put(handle, 'video:att-1', { text: 'a watched cat', ts: NOW, watched: true });
    applyMemoryWrite(handle, {
      kind: 'media-entry',
      op: 'drop',
      placeId: ROOT,
      key: 'att-1',
      iface: 'discord',
      now: NOW,
    });
    const db = dbOf(handle);
    const [kept] = rowsHolding(db, 'video:att-1');
    assert.equal(kept.retired_at, null);
    assert.deepEqual(rowsHolding(db, 'att-1'), []);
    applyMemoryWrite(handle, {
      kind: 'media-entry',
      op: 'drop',
      placeId: ROOT,
      key: 'video:att-1',
      iface: 'discord',
      now: NOW,
    });
    const after = db.prepare('SELECT retired_at FROM media WHERE id = ?').get(kept.id);
    assert.equal(after?.retired_at, new Date(NOW).toISOString());
  } finally {
    handle.close();
  }
});

test('past the cap the least recently used row nothing links is retired, a linked row and a library row stay', () => {
  const handle = copyOf(seededPlaces());
  try {
    const db = dbOf(handle);
    const insert = db.prepare(
      `INSERT INTO media (id, kind, native_ref, availability, extra, scope_kind, scope_iface, audience_id, writer, holder_id, used_at)
       VALUES (?, 'image', ?, 'unknown', ?, 'group', 'discord', 'aud:group:discord', ?, ?, ?)`
    );
    db.exec('BEGIN');
    for (let n = 0; n < MEDIA_CACHE_ENTRIES; n += 1) {
      const ref = `old-${n}`;
      insert.run(
        `media:discord:${ref}`,
        ref,
        JSON.stringify({ cache: { [ref]: { text: 't', ts: n } } }),
        'media',
        ROOT,
        n
      );
    }
    // The library's row is not the cache's to trim, however old.
    insert.run(
      'media:gif:g1',
      'g-ref',
      JSON.stringify({ cache: { 'g-ref': { text: 'g', ts: 0 } } }),
      'gifs',
      'persona:local',
      -1
    );
    db.exec('COMMIT');
    db.prepare(
      "INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('source', 'src:linked', 0, 'media:discord:old-0')"
    ).run();
    put(handle, 'new-1', DESCRIBED);
    const retired = db
      .prepare('SELECT id FROM media WHERE retired_at IS NOT NULL ORDER BY id')
      .all()
      .map((row) => row.id);
    assert.deepEqual(retired, ['media:discord:old-1']);
    const live = db
      .prepare("SELECT count(*) AS n FROM media WHERE writer = 'media' AND holder_id = ? AND retired_at IS NULL")
      .get(ROOT);
    assert.equal(live?.n, MEDIA_CACHE_ENTRIES);
  } finally {
    handle.close();
  }
});

test('the saved description of a trimmed row is answered, and its write brings the row back', async () => {
  const dataDir = tempDataDir('nep-media-cache-saved-');
  const first = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: first.memoryDb });
    store.putMediaEntry(ROOT, 'att-1', DESCRIBED);
    store.putMediaEntry(ROOT, 'att-2', { miss: true, ts: NOW });
    await store.flushSettled({});
  } finally {
    await first.close();
  }
  // The trim's retirement, as a cap past its rows leaves them.
  const handle = openMemoryDb(path.join(dataDir, 'memory.db'));
  try {
    dbOf(handle).prepare("UPDATE media SET retired_at = '2026-11-09T09:00:00.000Z' WHERE writer = 'media'").run();
  } finally {
    handle.close();
  }
  const second = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: second.memoryDb });
    assert.equal(store.mediaEntry(ROOT, 'att-1'), undefined);
    assert.deepEqual(store.getMediaDescription(ROOT, 'att-1'), DESCRIBED);
    assert.equal(store.getMediaDescription(ROOT, 'att-2'), null);
    store.putMediaEntry(ROOT, 'att-1', { ...DESCRIBED, usedAt: NOW });
    await store.flushSettled({});
    assert.deepEqual(store.mediaEntry(ROOT, 'att-1'), { ...DESCRIBED, usedAt: NOW });
    const [row] = rowsHolding(dbOf(second.memoryDb.readHandle()!), 'att-1');
    assert.equal(row?.retired_at, null);
  } finally {
    await second.close();
  }
});

/** A database whose media rows a media unit, a GIF unit and a media description own, as version 51 left them. */
function atVersion51(handle: MemoryHandle): Db {
  const db = dbOf(handle);
  const unit = db.prepare(
    'INSERT INTO storage_units (id, kind, subject_type, subject_id, key_json) VALUES (?, ?, ?, ?, ?)'
  );
  unit.run('unit:media-root', 'media', 'place', ROOT, '{"kind":"media"}');
  unit.run('unit:gifs', 'gifs', 'persona', 'persona:local', '{"kind":"gifs"}');
  const row = db.prepare(
    `INSERT INTO media (id, kind, native_ref, availability, extra, description, scope_kind, scope_iface, audience_id, owner_key)
     VALUES (?, ?, ?, 'present', ?, ?, 'group', 'discord', 'aud:group:discord', ?)`
  );
  row.run(
    'media:discord:att-1',
    'video',
    'att-1',
    JSON.stringify({ cache: { 'att-1': { ts: 10 }, 'video:att-1': { ts: 20, usedAt: 30 } } }),
    'a watched cat',
    'unit:media-root'
  );
  row.run(
    'media:gif:g1',
    'gif',
    'g-ref',
    JSON.stringify({ id: 'g1', cache: { 'g-ref': { ts: 5 } } }),
    'a gif',
    'unit:gifs'
  );
  row.run('media:discord:line', 'image', 'line-ref', '{}', null, null);
  // The describer's saved description of a key no row holds, and of one a row holds.
  const describe = (key: string, entry: Row): void => {
    const id = `desc:media:${key}`;
    const holder = `${ROOT}/media/${key}`;
    db.prepare(
      `INSERT INTO description_versions (id, description_id, text, written_at, origin, extra, writer, holder_id, position)
       VALUES (?, ?, ?, '2026-11-01T00:00:00.000Z', 'media', ?, 'versions', ?, 1)`
    ).run(`${id}:v1`, id, String(entry.text), JSON.stringify({ entry }), holder);
    db.prepare(
      `INSERT INTO descriptions (id, subject_kind, subject_id, field, current_version, scope_kind, scope_iface, writer, holder_id)
       VALUES (?, 'media', ?, 'description', ?, 'group', 'discord', 'versions', ?)`
    ).run(id, key, `${id}:v1`, holder);
    db.prepare(
      "INSERT INTO operational (kind, owner, value, writer, holder_id) VALUES ('versions', ?, '{}', 'versions', ?)"
    ).run(`unit:versions:${key}`, holder);
    db.prepare("INSERT INTO graph_nodes (id, kind, row_id, created_at) VALUES (?, 'description', ?, '2026-11-01')").run(
      `description:${id}`,
      id
    );
  };
  describe('att-1', { text: 'a still frame', ts: 10 });
  describe('att-7', { text: 'a saved picture', ts: 7, describedAt: 7, model: 'vision-model' });
  db.exec("DELETE FROM graph_nodes WHERE kind = 'media'");
  return db;
}

test('version step 52 names each row of a media cache and of the GIF library by its unit and folds the descriptions', async () => {
  const dataDir = tempDataDir('nep-media-cache-v52-');
  const first = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  await first.close();
  const handle = openMemoryDb(path.join(dataDir, 'memory.db'));
  try {
    const db = atVersion51(handle);
    ownMediaRows(db);
    const owners = db
      .prepare('SELECT id, writer, holder_id, used_at FROM media ORDER BY id')
      .all()
      .map((row) => [row.id, row.writer, row.holder_id, row.used_at]);
    assert.deepEqual(
      owners.filter(([id]) => id !== 'media:discord:att-7'),
      [
        ['media:discord:att-1', 'media', ROOT, 30],
        ['media:discord:line', null, null, null],
        ['media:gif:g1', 'gifs', 'persona:local', 5],
      ]
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM descriptions WHERE subject_kind = 'media'").get()?.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM description_versions WHERE origin = 'media'").get()?.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM operational WHERE holder_id LIKE '%/media/%'").get()?.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM graph_nodes WHERE row_id LIKE 'desc:media:%'").get()?.n, 0);
    // A live row of the media cache with no node gets one.
    assert.equal(
      db.prepare("SELECT kind FROM graph_nodes WHERE id = 'media:media:discord:att-1'").get()?.kind,
      'media'
    );
  } finally {
    handle.close();
  }
  const second = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: second.memoryDb });
    // The row's own entry stays what the cache read gave; the saved description of a key no row held is a row now.
    assert.deepEqual(store.mediaEntry(ROOT, 'att-1'), { text: 'a watched cat', ts: 10 });
    assert.deepEqual(store.mediaEntry(ROOT, 'att-7'), {
      text: 'a saved picture',
      ts: 7,
      describedAt: 7,
      model: 'vision-model',
    });
  } finally {
    await second.close();
  }
});
