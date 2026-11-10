// Version step 53 (src/memory/db/gif-library.ts#ownGifRows): the GIF library leaves its unit. Every row of a library
// entry is the library's, the one a media cache's unit took too, and the library's operational row is the persona's,
// so the library reads the same rows after the step with no unit. Synthetic rows over a test memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gifLibraryValue, ownGifRows } from '../src/memory/db/gif-library.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import { freshMemoryDb } from './fixtures/memory-db-copy.ts';

const GUILD = 'discord:guild:g1';

/** A database as version 52 left it: library rows of the persona's unit, one of a media cache's unit, a retired one. */
function atVersion52(db: Db): void {
  const unit = db.prepare(
    'INSERT INTO storage_units (id, kind, subject_type, subject_id, key_json, retired_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  unit.run('unit:gifs', 'gifs', 'persona', 'persona:local', '{"kind":"gifs","subject":"persona"}', null);
  unit.run('unit:gifs-guild', 'gifs', 'place', GUILD, '{"kind":"gifs","subject":"guild"}', '2026-11-05T00:00:00.000Z');
  unit.run('unit:media-guild', 'media', 'place', GUILD, '{"kind":"media","subject":"guild"}', null);
  db.prepare("INSERT INTO legacy_unit_aliases (path, unit_id) VALUES ('guilds/g1/gifs.json', 'unit:gifs-guild')").run();
  const row = db.prepare(
    `INSERT INTO media (id, kind, native_ref, availability, extra, scope_kind, scope_iface, audience_id, owner_key, writer,
       holder_id, retired_at)
     VALUES (?, 'gif', ?, 'unknown', ?, 'group', 'discord', 'aud:group:discord', ?, ?, ?, ?)`
  );
  const extra = (id: string, more: Row = {}) => JSON.stringify({ id, kind: 'link', url: `https://t/${id}`, ...more });
  row.run('media:gif:k1', 'ref-1', extra('g1'), 'unit:gifs', 'gifs', 'persona:local', null);
  row.run(
    'media:gif:k2',
    'ref-2',
    extra('g2', { cache: { 'ref-2': { ts: 1 } } }),
    'unit:media-guild',
    'media',
    GUILD,
    null
  );
  row.run('media:gif:k3', 'ref-3', extra('g3'), 'unit:gifs-guild', 'gifs', GUILD, '2026-11-05T00:00:00.000Z');
  // A cache row of an item that is no library entry.
  row.run('media:discord:ref-9', 'ref-9', '{"cache":{"ref-9":{"ts":1}}}', 'unit:media-guild', 'media', GUILD, null);
  db.prepare(
    "INSERT INTO operational (kind, owner, value, owner_key) VALUES ('gifs', 'unit:gifs', '{\"nextId\":4,\"$has\":[\"entries\"]}', 'unit:gifs')"
  ).run();
}

test('version step 53 gives every library row the library as writer and the persona as holder, and no unit', () => {
  const handle = freshMemoryDb();
  try {
    const db = dbOf(handle);
    atVersion52(db);
    ownGifRows(db);
    const rows = db.prepare('SELECT id, writer, holder_id, owner_key, retired_at FROM media ORDER BY id').all();
    assert.deepEqual(
      rows.map((one) => [one.id, one.writer, one.holder_id, one.owner_key]),
      [
        ['media:discord:ref-9', 'media', GUILD, 'unit:media-guild'],
        ['media:gif:k1', 'gifs', 'persona:local', null],
        ['media:gif:k2', 'gifs', 'persona:local', null],
        ['media:gif:k3', 'gifs', 'persona:local', null],
      ]
    );
    assert.ok(rows.find((one) => one.id === 'media:gif:k3')?.retired_at, 'a retired row stays retired');
    const operational = db.prepare("SELECT owner, owner_key FROM operational WHERE kind = 'gifs'").all();
    assert.deepEqual(
      operational.map((one) => [one.owner, one.owner_key]),
      [['persona:local', null]]
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM storage_units WHERE kind = 'gifs'").get()?.n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM legacy_unit_aliases').get()?.n, 0);
  } finally {
    handle.close();
  }
});

test('after version step 53 the library reads the entry a media cache held, with its handle and nextId', () => {
  const handle = freshMemoryDb();
  try {
    const db = dbOf(handle);
    atVersion52(db);
    ownGifRows(db);
    const read = gifLibraryValue(db) as { found: true; value: { nextId: number; entries: Record<string, Row> } };
    assert.equal(read.found, true);
    const { nextId, entries } = read.value;
    assert.equal(nextId, 4);
    assert.deepEqual(Object.keys(entries), ['k1', 'k2']);
    assert.equal(entries.k2.id, 'g2');
    assert.equal(entries.k2.cache, undefined);
  } finally {
    handle.close();
  }
});
