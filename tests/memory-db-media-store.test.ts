// The text form of a media row (src/memory/db/media-store.ts): what a line's media written again keeps of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adoptSameItem,
  mediaItemsOf,
  pendingMediaEmbeds,
  sourceLine,
  writeEntryFiles,
  writeLineMedia,
  writeMediaEntry,
} from '../src/memory/db/media-store.ts';
import type { EntryFile, MediaItem } from '../src/memory/db/media-store.ts';
import { graphNodeId, projectRow } from '../src/memory/db/graph.ts';
import { writeGifLibrary } from '../src/memory/db/gif-library.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { freshMemoryDb } from './fixtures/memory-db-copy.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import type { Db } from '../src/memory/db/types.ts';

const PLACE = 'discord:g9:c4';
const AT = '2026-11-08T10:00:00.000Z';
const CLIP = { attachments: [{ id: 'v41', kind: 'video', url: 'https://cdn.example/v41.mp4', name: 'clip.mp4' }] };

test('keeps a watched video retelling when its line is read again', (t) => {
  // Bug: the origin was derived from `extra.watched`, which no writer sets, so the retelling became `frame`.
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  const db = handle.db as Db;
  db.prepare(
    `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, occurred_at, text, scope_iface)
     VALUES ('s1', 'seen', 'discord', 'n1', 1, ?, ?, 'watch this', 'discord')`
  ).run(PLACE, AT);
  const line = sourceLine(db, 's1');
  if (line === undefined) throw new Error('the line was not stored');
  writeLineMedia(db, line, mediaItemsOf(CLIP), { at: AT });
  writeMediaEntry(db, {
    placeId: PLACE,
    iface: 'discord',
    key: 'video:v41',
    entry: { text: 'a dog chases a ball across a lawn', watched: true },
    at: Date.parse(AT) + 1000,
  });
  writeLineMedia(db, line, mediaItemsOf(CLIP), { at: '2026-11-08T11:00:00.000Z' });
  const row = db.prepare("SELECT extra FROM media WHERE kind = 'video'").get();
  const extra = JSON.parse(typeof row?.extra === 'string' ? row.extra : '{}') as { textOrigin?: unknown };
  assert.equal(extra.textOrigin, 'retelling');
});

// Spec 2026-11-18, the library without the keeper: a library row that no line links still gets its ordinary media
// vector, since the media pick reads that one. Bug: the embedding took only rows a line links.
test('a described library row that no line links waits for its media vector', () => {
  const handle = freshMemoryDb();
  try {
    const db = dbOf(handle);
    const entry = { id: 'g1', kind: 'link', url: 'https://gifs.example/view/1', count: 1 };
    writeGifLibrary(db, { put: { k1: entry } }, { iface: 'discord', at: Date.UTC(2026, 10, 18) });
    // The describer's cache writes the row's one text; a library write never does.
    db.prepare("UPDATE media SET description = 'a cat waves' WHERE writer = 'gifs'").run();
    const row = db.prepare("SELECT id FROM media WHERE writer = 'gifs'").get();
    assert.deepEqual(
      pendingMediaEmbeds(db).map((pending) => pending.id),
      [row?.id]
    );
  } finally {
    handle.close();
  }
});

// ---------- the graph follows a media row that goes ----------
// Diagnosis 2026-11-18, graph orphans: a site that deletes a media row or changes its id left the row's node and its
// own `node_access` witness behind, because no projection ran for the old id and a projection of a missing row wrote
// nothing.

const MEDIA_LINE =
  "INSERT INTO sources (id, kind, iface, native_id, revision, place_id, occurred_at, text, scope_iface) VALUES (?, 'seen', 'discord', ?, 1, ?, ?, 'look', 'discord')";

/** How many graph nodes and own witnesses the media row `id` holds, as `[nodes, witnesses]`. */
function graphOf(db: Db, id: string): [number, number] {
  const node = graphNodeId('media', id);
  const nodes = db.prepare('SELECT COUNT(*) AS n FROM graph_nodes WHERE id = ?').get(node)?.n;
  const witnesses = db.prepare('SELECT COUNT(*) AS n FROM node_access WHERE node_id = ?').get(node)?.n;
  return [Number(nodes), Number(witnesses)];
}

const imageItem = (nativeRef: string | null): MediaItem => ({
  kind: 'image',
  nativeRef,
  availability: 'unknown',
  description: null,
  origin: null,
  extra: {},
});

test('a placeholder renamed to its item leaves no node under its old id and the item has its node', (t) => {
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  const db = handle.db as Db;
  db.prepare(MEDIA_LINE).run('s7', 'n7', PLACE, AT);
  const line = sourceLine(db, 's7');
  if (line === undefined) throw new Error('the line was not stored');
  writeLineMedia(db, line, [imageItem(null)], { at: AT });
  const bare = String(db.prepare("SELECT media_id FROM media_links WHERE owner_id = 's7'").get()?.media_id);
  projectRow(db, 'media', { id: bare }, { at: AT });
  assert.deepEqual(graphOf(db, bare), [1, 1]);
  writeLineMedia(db, line, [imageItem('att71')], { at: AT });
  const renamed = String(db.prepare("SELECT media_id FROM media_links WHERE owner_id = 's7'").get()?.media_id);
  assert.notEqual(renamed, bare);
  assert.deepEqual(graphOf(db, bare), [0, 0]);
  assert.equal(graphOf(db, renamed)[0], 1);
});

test('a placeholder that gives way to an item the reference already names leaves no node behind', (t) => {
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  const db = handle.db as Db;
  db.prepare(MEDIA_LINE).run('s8', 'n8', PLACE, AT);
  const line = sourceLine(db, 's8');
  if (line === undefined) throw new Error('the line was not stored');
  writeLineMedia(db, line, [imageItem(null)], { at: AT });
  const bare = String(db.prepare("SELECT media_id FROM media_links WHERE owner_id = 's8'").get()?.media_id);
  projectRow(db, 'media', { id: bare }, { at: AT });
  db.prepare(
    "INSERT INTO media (id, kind, native_ref, scope_iface) VALUES ('media:discord:att81', 'image', 'att81', 'discord')"
  ).run();
  writeLineMedia(db, line, [imageItem('att81')], { at: AT });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media WHERE id = ?').get(bare)?.n, 0);
  assert.deepEqual(graphOf(db, bare), [0, 0]);
});

test('a diary picture dropped as the twin of the attachment it became leaves no node behind', (t) => {
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  const db = handle.db as Db;
  const entry = { id: 'diary:e5', scope_iface: 'discord' };
  const file = (id: string, attachmentId: string | null): EntryFile => ({
    id,
    position: 0,
    path: 'media/p5.png',
    attachmentId,
    messageId: null,
    url: null,
    description: null,
    sha1: 'h5',
    bytes: 10,
    mime: 'image/png',
    extra: {},
  });
  writeEntryFiles(db, entry, [file('media:diary:e5:0', null)], AT);
  assert.deepEqual(graphOf(db, 'media:diary:e5:0'), [1, 1]);
  db.prepare(
    `INSERT INTO media (id, kind, native_ref, path, sha1, scope_iface)
     VALUES ('media:discord:att55', 'image', 'att55', 'media/p5.png', 'h5', 'discord')`
  ).run();
  writeEntryFiles(db, entry, [file('media:diary:e5:0', 'att55')], AT);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM media WHERE id = 'media:diary:e5:0'").get()?.n, 0);
  assert.deepEqual(graphOf(db, 'media:diary:e5:0'), [0, 0]);
  assert.equal(graphOf(db, 'media:discord:att55')[0], 1);
});

test('a row adopted into the library row of the same item leaves no node behind and the library row keeps its own', (t) => {
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  const db = handle.db as Db;
  const insert = db.prepare(
    "INSERT INTO media (id, kind, native_ref, scope_iface) VALUES (?, 'gif', 'g61', 'discord')"
  );
  insert.run('media:gif:keep');
  insert.run('media:discord:g61');
  projectRow(db, 'media', { id: 'media:gif:keep' }, { at: AT });
  projectRow(db, 'media', { id: 'media:discord:g61' }, { at: AT });
  adoptSameItem(db, 'media:gif:keep', AT);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM media WHERE id = 'media:discord:g61'").get()?.n, 0);
  assert.deepEqual(graphOf(db, 'media:discord:g61'), [0, 0]);
  assert.deepEqual(graphOf(db, 'media:gif:keep'), [1, 1]);
});
