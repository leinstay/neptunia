// The text form of a media row (src/memory/db/media-store.ts): what a line's media written again keeps of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mediaItemsOf,
  pendingMediaEmbeds,
  sourceLine,
  writeLineMedia,
  writeMediaEntry,
} from '../src/memory/db/media-store.ts';
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
