// A write of the GIF library when two of its own rows spell one item reference (media-store.ts, adoptLibraryRows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyUnitWrite } from '../src/memory/db/unit-write.ts';
import { personaKey } from '../src/memory/db/storage-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { freshMemoryDb } from './fixtures/memory-db-copy.ts';

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
  const key = personaKey('gifs');
  applyUnitWrite(handle, { op: 'value', key, now: AT, value: { nextId: 2, entries: { k1: entry('g1') } } });
  // A database that already holds two library rows of one reference, the second with the text and a link.
  db.prepare(
    `INSERT INTO media (id, kind, path, native_ref, scope_kind, scope_iface, extra, owner_key, description)
     SELECT 'media:gif:k2', kind, path, native_ref, scope_kind, scope_iface, extra, owner_key, 'a cat on a keyboard'
     FROM media WHERE id = 'media:gif:k1'`
  ).run();
  db.prepare(
    "INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('source', 't', 0, 'media:gif:k2')"
  ).run();

  applyUnitWrite(handle, {
    op: 'value',
    key,
    now: AT,
    value: { nextId: 3, entries: { k1: entry('g1'), k2: entry('g2') } },
  });

  const rows = db.prepare("SELECT id, description FROM media WHERE kind = 'gif' AND native_ref = 'same-ref'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, 'a cat on a keyboard');
  const link = db.prepare("SELECT media_id FROM media_links WHERE owner_id = 't'").get();
  assert.equal(link?.media_id, rows[0].id);
  handle.close();
});
