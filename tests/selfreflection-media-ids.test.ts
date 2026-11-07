// The ids of her selfreflection pictures leave the old word (plan 2026-11-06-turn-frame, owner's answer 13 of
// 2026-11-07): a picture stored as `media:diary:<entry>-<n>` is `media:selfreflection:<entry>-<n>` after a migration
// appended to `MIGRATIONS`, with every row that names it: the item in `media`, its link in `media_links` and its node in
// `graph_nodes`. The shipped migrations keep the old name. A picture of a line, and everything else of the item, stay
// as they are. A second run of the appended steps changes nothing. Real temporary databases, synthetic data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MIGRATIONS, openMemoryDb } from '../src/memory/db/open.ts';
import { graphNodeId } from '../src/memory/db/graph.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import { tempDir } from './fixtures/tmp.ts';

/** The migrations shipped before this slice; the id move is appended after them. */
const SHIPPED = 37;
const OLD_ID = 'media:diary:e1-1';
const NEW_ID = 'media:selfreflection:e1-1';
const LINE_PICTURE = 'media:held:att-9';
const AT = '2026-11-01T00:00:00.000Z';

/** A database at the shipped version with one picture of an entry under the old id and one picture of a line. */
function seeded(): string {
  const file = path.join(tempDir('nep-media-ids-'), 'memory.db');
  const handle = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, SHIPPED) });
  try {
    const db = dbOf(handle);
    db.prepare(
      "INSERT INTO selfreflection (id, at_ms, kind, gist, text, scope_kind, scope_iface) VALUES ('e1', 1, 'photos', 'g', 't', 'group', 'fake')"
    ).run();
    const media = db.prepare(
      'INSERT INTO media (id, kind, path, availability, owner, description, sha1, mime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    media.run(
      OLD_ID,
      'image',
      'media/selfreflection/e1-1.png',
      'present',
      'e1',
      'μια βάρκα στην ομίχλη',
      'aa',
      'image/png'
    );
    media.run(LINE_PICTURE, 'image', 'media/held/att-9.png', 'present', null, 'ένας φάρος', 'bb', 'image/png');
    const link = db.prepare('INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES (?, ?, ?, ?)');
    link.run('selfreflection', 'e1', 0, OLD_ID);
    link.run('source', 'src1', 0, LINE_PICTURE);
    const node = db.prepare('INSERT INTO graph_nodes (id, kind, row_id, created_at) VALUES (?, ?, ?, ?)');
    node.run(graphNodeId('media', OLD_ID), 'media', OLD_ID, AT);
    node.run(graphNodeId('media', LINE_PICTURE), 'media', LINE_PICTURE, AT);
  } finally {
    handle.close();
  }
  return file;
}

/** Runs `read` over the database opened with every migration. */
function opened<T>(file: string, read: (db: Db) => T): T {
  const handle = openMemoryDb(file);
  try {
    return read(dbOf(handle));
  } finally {
    handle.close();
  }
}

/** The rows of the three tables that name a picture, in a fixed order. */
function pictureRows(db: Db): Record<string, Array<Row>> {
  const all = (sql: string): Array<Row> =>
    db
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  return {
    media: all('SELECT id, kind, path, availability, owner, description, sha1, mime FROM media ORDER BY id'),
    links: all('SELECT owner_kind, owner_id, position, media_id FROM media_links ORDER BY owner_kind, owner_id'),
    nodes: all("SELECT id, row_id FROM graph_nodes WHERE kind = 'media' ORDER BY id"),
  };
}

test('the move of the ids is appended after the shipped migrations', () => {
  // Bug: the move is written into a shipped migration, which a deployment at that version never runs again.
  assert.ok(MIGRATIONS.length > SHIPPED, `${MIGRATIONS.length} migrations`);
});

test('a picture of an entry stored under media:diary: is media:selfreflection: in the item, its link and its node', () => {
  // Bug: the item is renamed and its link or its node keeps the old id, so the entry loses its picture.
  const rows = opened(seeded(), pictureRows);
  assert.deepEqual(
    rows.media.map((row) => row.id),
    [LINE_PICTURE, NEW_ID]
  );
  assert.deepEqual(rows.links.find((row) => row.owner_kind === 'selfreflection')?.media_id, NEW_ID);
  assert.deepEqual(
    rows.nodes.find((row) => row.row_id !== LINE_PICTURE),
    { id: graphNodeId('media', NEW_ID), row_id: NEW_ID }
  );
});

test('the move keeps everything else of the picture and leaves a picture of a line alone', () => {
  // Bug: the move copies the row by position or by a short column list, and the picture loses its file or description.
  const rows = opened(seeded(), pictureRows);
  assert.deepEqual(
    rows.media.find((row) => row.id === NEW_ID),
    {
      id: NEW_ID,
      kind: 'image',
      path: 'media/selfreflection/e1-1.png',
      availability: 'present',
      owner: 'e1',
      description: 'μια βάρκα στην ομίχλη',
      sha1: 'aa',
      mime: 'image/png',
    }
  );
  assert.deepEqual(rows.links.find((row) => row.owner_kind === 'source')?.media_id, LINE_PICTURE);
});

test('a second run of the appended steps changes nothing', () => {
  // Bug: a run over a database already moved fails on the primary key, or renames a second time.
  const file = seeded();
  const first = opened(file, pictureRows);
  assert.ok(
    first.media.some((row) => row.id === NEW_ID),
    'the first run moved the id'
  );
  const again = opened(file, (db) => {
    for (const step of MIGRATIONS.slice(SHIPPED)) {
      if (typeof step === 'function') step(db, {});
      else db.exec(step);
    }
    return pictureRows(db);
  });
  assert.deepEqual(again, first);
});
