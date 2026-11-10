// The GIF library as rows of `media` (src/memory/db/gif-library.ts): a write puts and drops entries one row each, with
// the library's owner columns and the row's graph node, and the read rebuilds the library from those rows and the
// library's own operational row. Synthetic entries over a fresh memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gifLibraryValue, writeGifLibrary } from '../src/memory/db/gif-library.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import { freshMemoryDb } from './fixtures/memory-db-copy.ts';

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
    assert.equal(row?.owner_key, null);
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
    assert.deepEqual((value.entries as Row).k1, k1);
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
