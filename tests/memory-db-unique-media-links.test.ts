// Schema step 64 (src/memory/db/schema.ts) on a database written at version 63: one link per media of an owner. The key
// `(owner_kind, owner_id, media_id)` of `media_links` refuses a second link of one media to one owner, and the step
// keeps the first link of each pair, closes the gaps in the owner's positions in their old order, and changes nothing
// else. Each test builds a version 63 file with the steps above the baseline up to 63, fills it with raw SQL, and opens
// it with the current code. Temporary files, invented ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, openMemoryDb } from '../src/memory/db/open.ts';
import { BASELINE_VERSION } from '../src/memory/db/schema-baseline.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import { filledRows } from './fixtures/memory-db/schema-shape.ts';
import { tempDir } from './fixtures/tmp.ts';

/** Four media rows and the links of three owners, two of them holding one media more than once. */
const ROWS = `
INSERT INTO media (id, kind, native_ref, scope_kind, scope_iface) VALUES
  ('media:fake:e1', 'emoji', 'e1', 'group', 'fake'),
  ('media:fake:e2', 'emoji', 'e2', 'group', 'fake'),
  ('media:fake:s1', 'sticker', 's1', 'group', 'fake'),
  ('media:fake:a1', 'image', 'a1', 'group', 'fake');
INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES
  ('source', 'src:l1', 0, 'media:fake:e1'),
  ('source', 'src:l1', 1, 'media:fake:e2'),
  ('source', 'src:l1', 2, 'media:fake:e1'),
  ('source', 'src:l1', 3, 'media:fake:s1'),
  ('source', 'src:l1', 4, 'media:fake:e1'),
  ('source', 'src:l2', 0, 'media:fake:s1'),
  ('source', 'src:l2', 1, 'media:fake:s1'),
  ('diary', 'diary:d1', 0, 'media:fake:a1'),
  ('diary', 'diary:d1', 1, 'media:fake:e1');
`;

/** A database file at schema version 63 holding `sql`, written with raw SQL after the steps up to 63. */
function at63(sql: string): string {
  const file = path.join(tempDir('nep-links-64-'), 'memory.db');
  openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 63 - BASELINE_VERSION) }).close();
  const raw = new DatabaseSync(file);
  try {
    assert.equal(raw.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v, 63);
    raw.exec(sql);
  } finally {
    raw.close();
  }
  return file;
}

/** Opens `file` with the current code, then `read` on its connection. */
function opened<TResult>(file: string, read: (db: Db) => TResult): TResult {
  const handle = openMemoryDb(file);
  try {
    return read(dbOf(handle));
  } finally {
    handle.close();
  }
}

const rows = (db: Db, sql: string): Array<Row> =>
  db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));

/** The links of every owner as `kind owner position media`, in key order. */
const linkRows = (db: Db): Array<string> =>
  rows(
    db,
    'SELECT owner_kind, owner_id, position, media_id FROM media_links ORDER BY owner_kind, owner_id, position'
  ).map((row) => `${String(row.owner_kind)} ${String(row.owner_id)} ${String(row.position)} ${String(row.media_id)}`);

test('refuses a second link of one media to one owner after the step', () => {
  // Bug: only the item builder keeps a line to one link per media, so any other writer can still double a link.
  const file = at63('');
  opened(file, (db) => {
    const insert = db.prepare('INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES (?, ?, ?, ?)');
    insert.run('source', 'src:l9', 0, 'media:fake:e9');
    assert.throws(() => insert.run('source', 'src:l9', 1, 'media:fake:e9'), /UNIQUE constraint failed/);
  });
});

test('keeps one link per owner and media, with the remaining positions contiguous in their old order', () => {
  // Bug: the step leaves a doubled link, keeps a later copy instead of the first, or leaves a gap in the positions.
  const file = at63(ROWS);
  assert.deepEqual(opened(file, linkRows), [
    'diary diary:d1 0 media:fake:a1',
    'diary diary:d1 1 media:fake:e1',
    'source src:l1 0 media:fake:e1',
    'source src:l1 1 media:fake:e2',
    'source src:l1 2 media:fake:s1',
    'source src:l2 0 media:fake:s1',
  ]);
});

test('changes no row outside media_links when it removes doubled links', () => {
  // Bug: the step drops a media row whose doubled link it removed, or touches another table.
  const file = at63(ROWS);
  const raw = new DatabaseSync(file);
  const before = filledRows(raw, ['media_links', 'schema_version']);
  raw.close();
  assert.deepEqual(
    opened(file, (db) => filledRows(db, ['media_links', 'schema_version'])),
    before
  );
});
