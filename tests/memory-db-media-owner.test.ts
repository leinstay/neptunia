// Version step 52 (src/memory/db/media-owner.ts): the rows of a media cache and of the GIF library take their owner
// columns and last use from their units, the describer's saved descriptions move onto their rows and their own rows and
// graph nodes go, and a live row with no graph node gets one. Synthetic rows over a database seeded at version 51 and
// migrated to the latest version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { MIGRATIONS } from '../src/memory/db/schema.ts';
import { BASELINE_VERSION } from '../src/memory/db/schema-baseline.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';
import { NOW, ROOT } from './fixtures/memory-db/place-writes.ts';

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
  // Catches: a cache row or a library row left without its writer and holder, or a saved description left beside its
  // row, once the database migrates past the step, the drop of the units (step 55) included.
  const dataDir = tempDataDir('nep-media-cache-v52-');
  const old = openMemoryDb(path.join(dataDir, 'memory.db'), { migrations: MIGRATIONS.slice(0, 51 - BASELINE_VERSION) });
  try {
    atVersion51(old);
  } finally {
    old.close();
  }
  const second = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  try {
    const db = dbOf(second.memoryDb.readHandle()!);
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
