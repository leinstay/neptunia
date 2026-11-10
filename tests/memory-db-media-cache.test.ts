// The describer's cache as rows of `media` (src/memory/db/media-store.ts): an entry lives on the row of its item and
// nowhere else, written by the write kind `media-entry` one row at a time. The tests cover the row a write leaves (its
// owner columns and its graph node), a drop, and the trim by last use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEDIA_CACHE_ENTRIES } from '../src/memory/db/media-store.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../src/memory/db/types.ts';
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
