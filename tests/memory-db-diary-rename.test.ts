// Schema step 61 (src/memory/db/schema.ts) on a database written at version 60: the stored word `selfreflection`
// becomes `diary` wherever it stands in a value code compares against, inside ids and paths too. The two tables,
// their column, indexes and trigger take the new name; `media_links` accepts the owner kind `diary` and no other
// spelling; the discriminators, the writers, every row id that carries the word with every column that references
// it, the picture paths, the graph's nodes and edges, the operational row's owner, the codes in the journal and the
// receipts, and the archive's service and purpose follow. The vectors the first rename left under `media:diary:` with
// a live twin go first, since the twin takes their key. A renamed id, path or key that meets an existing one stops
// the step. Each test builds a version 60 file with the steps above the baseline up to 60, fills it with raw SQL the
// way production holds it, and opens it with the current code. Temporary files, synthetic rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, inTransaction, openMemoryDb } from '../src/memory/db/open.ts';
import { BASELINE_VERSION } from '../src/memory/db/schema-baseline.ts';
import { edgeIdOf, projectionKey } from '../src/memory/db/graph.ts';
import { PERSONA_ID } from '../src/memory/db/ids.ts';
import { collectionId, personaKey } from '../src/memory/db/unit-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import { filledRows, schemaShape } from './fixtures/memory-db/schema-shape.ts';
import { tempDir } from './fixtures/tmp.ts';

/** The owner the operational row of her entries was stored under: the id `collectionId` gave the old kind. */
const OLD_OWNER = `unit:${createHash('sha256')
  .update(JSON.stringify({ kind: 'selfreflection', subject: { type: 'persona', id: PERSONA_ID } }))
  .digest('hex')
  .slice(0, 32)}`;

const AT = '2026-11-10T10:00:00.000Z';

// Entry e1's mirror row and its publication share one id, as deriveMirrorPublication writes them.
const OLD_MIRROR_PUB = 'mirror:selfreflection:e1:discord:place:p1';
const NEW_MIRROR_PUB = 'mirror:diary:e1:discord:place:p1';

// The graph of entry e1: its node, the nodes of its publication and its picture, the two edges and the witnesses.
const OLD = {
  entry: 'selfreflection:selfreflection:e1',
  oldIdEntry: 'selfreflection:diary:old1',
  publication: `publication:${OLD_MIRROR_PUB}`,
  picture: 'media:media:selfreflection:selfreflection_e1-1',
};
const NEW = {
  entry: 'diary:diary:e1',
  oldIdEntry: 'diary:diary:old1',
  publication: `publication:${NEW_MIRROR_PUB}`,
  picture: 'media:media:diary:diary_e1-1',
};
const OLD_PUBLISHED = edgeIdOf('published_as', OLD.entry, OLD.publication, null);
const OLD_ILLUSTRATED = edgeIdOf('illustrated_by', OLD.entry, OLD.picture, null);
const NEW_PUBLISHED = edgeIdOf('published_as', NEW.entry, NEW.publication, null);
const NEW_ILLUSTRATED = edgeIdOf('illustrated_by', NEW.entry, NEW.picture, null);

/** Two entries, one minted under `selfreflection:` and one the first rename left under `diary:`, with every row
 * that names them. */
const ENTRIES = `
INSERT OR IGNORE INTO audiences (id, kind) VALUES ('aud:internal', 'internal');
INSERT INTO places (id, iface, kind, native_id) VALUES ('place:p1', 'discord', 'channel', 'n-1'),
  ('place:p2', 'discord', 'channel', 'n-2');
INSERT INTO selfreflection (id, at_ms, kind, gist, text, status, scope_kind, writer, holder_id) VALUES
  ('selfreflection:e1', 2000, 'thought', 'rain on the roof', 'It rained all day.', 'done', 'group', 'selfreflection',
   '${PERSONA_ID}'),
  ('diary:old1', 1000, 'status', 'a quiet morning', 'Nothing happened.', 'done', 'group', 'selfreflection',
   '${PERSONA_ID}');
INSERT INTO selfreflection_mirrors (selfreflection_id, iface, place_id, native_ids, posted_at, id, writer, holder_id)
  VALUES ('selfreflection:e1', 'discord', 'place:p1', '["m-1"]', '${AT}', '${OLD_MIRROR_PUB}', 'selfreflection',
   '${PERSONA_ID}');
INSERT INTO operational (kind, owner, value, writer, holder_id) VALUES
  ('selfreflection', '${OLD_OWNER}', '{"$has":["posts"],"updatedAt":2000}', 'selfreflection', '${PERSONA_ID}');
INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by) VALUES
  ('mirror:diary:place:p1', 'selfreflection', 'place:p1', 1, '${AT}', 'owner'),
  ('mirror:selfreflection:place:p2', 'selfreflection', 'place:p2', 1, '${AT}', 'owner');
INSERT INTO publication_grants (id, row_kind, row_id, content_hash, destinations, approved_by, approved_at) VALUES
  ('grant:selfreflection:e1', 'selfreflection', 'selfreflection:e1', 'h-1', '["place:p1"]', 'owner', '${AT}');
INSERT INTO publications (id, row_kind, row_id, destination_place_id, grant_id, status, idempotency_key, created_at,
  writer, holder_id) VALUES
  ('${OLD_MIRROR_PUB}', 'selfreflection', 'selfreflection:e1', 'place:p1', 'grant:selfreflection:e1', 'sent',
   'selfreflection:selfreflection:e1:place:p1', '${AT}', 'selfreflection', '${PERSONA_ID}'),
  ('pub:0002', 'selfreflection', 'diary:old1', 'place:p1', NULL, 'sent', 'selfreflection:diary:old1:place:p1', '${AT}',
   'selfreflection', '${PERSONA_ID}');
`;

/** The pictures of both entries, their links and vectors, and an orphan vector the first rename left behind. */
const PICTURES = `
INSERT INTO media (id, kind, path, owner, mime, scope_kind) VALUES
  ('media:selfreflection:selfreflection_e1-1', 'image', 'media/selfreflection/selfreflection_e1-1.png',
   'selfreflection:e1', 'image/png', 'group'),
  ('media:selfreflection:diary_old1-1', 'image', 'media/selfreflection/diary_old1-1.png', 'diary:old1', 'image/png',
   'group');
INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES
  ('selfreflection', 'selfreflection:e1', 0, 'media:selfreflection:selfreflection_e1-1'),
  ('selfreflection', 'diary:old1', 0, 'media:selfreflection:diary_old1-1'),
  ('source', 'src:1', 0, 'media:other-1');
INSERT INTO vectors (item_id, chunk_key, model, dims, kind) VALUES
  ('media:selfreflection:selfreflection_e1-1', 'media:media:selfreflection:selfreflection_e1-1', 'm', 2, 'media'),
  ('media:selfreflection:diary_old1-1', 'media:media:selfreflection:diary_old1-1', 'm', 2, 'media'),
  ('media:diary:diary_old1-1', 'media:media:diary:diary_old1-1', 'orphan', 2, 'media');
`;

const GRAPH = `
INSERT INTO graph_nodes (id, kind, row_id, created_at) VALUES
  ('${OLD.entry}', 'selfreflection', 'selfreflection:e1', '${AT}'),
  ('${OLD.oldIdEntry}', 'selfreflection', 'diary:old1', '${AT}'),
  ('${OLD.publication}', 'publication', '${OLD_MIRROR_PUB}', '${AT}'),
  ('${OLD.picture}', 'media', 'media:selfreflection:selfreflection_e1-1', '${AT}');
INSERT INTO graph_edges (id, src, predicate, dst, audience_id, evidence_id, recorded_at, projection_key, owner_key)
  VALUES
  ('${OLD_PUBLISHED}', '${OLD.entry}', 'published_as', '${OLD.publication}', 'aud:internal', NULL, '${AT}',
   '${projectionKey('published_as', OLD.entry, OLD.publication)}', 'publications:${OLD_MIRROR_PUB}'),
  ('${OLD_ILLUSTRATED}', '${OLD.entry}', 'illustrated_by', '${OLD.picture}', 'aud:internal', NULL, '${AT}',
   '${projectionKey('illustrated_by', OLD.entry, OLD.picture)}', 'selfreflection:selfreflection:e1');
INSERT INTO node_access (node_id, audience_id, evidence_id) VALUES
  ('${OLD.entry}', 'aud:internal', '${OLD.entry}'),
  ('${OLD.oldIdEntry}', 'aud:internal', '${OLD.oldIdEntry}'),
  ('${OLD.picture}', 'aud:internal', '${OLD_ILLUSTRATED}'),
  ('${OLD.publication}', 'aud:internal', '${OLD_PUBLISHED}');
`;

/** The engine words the journal, a delivery receipt and the request archive keep. */
const HISTORY = `
INSERT INTO day (id, at, what, extra) VALUES
  ('day:1', '${AT}', 'turn', '{"mode":"selfreflection","result":{"code":"selfreflection-mirror"},"actions":[{"code":"selfreflection-draw-only"},{"code":"ok"}]}'),
  ('day:2', '${AT}', 'turn', '{"mode":"reply","result":{"code":"ok"}}');
INSERT INTO wakes (id, kind, queued_at, payload, state) VALUES ('w-1', 'heartbeat', 1, '{}', 'handled');
INSERT INTO deliveries (key, wake_id, payload, state, queued_at, receipt) VALUES
  ('del:1', 'w-1', '{}', 'failed', 1, '{"code":"selfreflection-mirror","ok":false}');
INSERT INTO model_requests (id, schema_version, status, started_at, messages, service, purpose) VALUES
  ('mr:1', 1, 'ok', '${AT}', '[]', 'selfreflection', 'selfreflection-planner'),
  ('mr:2', 1, 'ok', '${AT}', '[]', 'core', 'reply');
`;

const ALL = ENTRIES + PICTURES + GRAPH + HISTORY;

/** The step that brings a database from 60 to 61. */
const step61 = MIGRATIONS[61 - BASELINE_VERSION - 1];

/** A database file at schema version 60 holding `sql`, written with raw SQL after the steps up to 60. */
function at60(sql: string): string {
  const file = path.join(tempDir('nep-diary-61-'), 'memory.db');
  openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 60 - BASELINE_VERSION) }).close();
  const raw = new DatabaseSync(file);
  try {
    assert.equal(raw.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v, 60);
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

/** Reads `read` from `file` opened raw, without the current code. */
function rawRead<TResult>(file: string, read: (db: Db) => TResult): TResult {
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    return read(raw);
  } finally {
    raw.close();
  }
}

const rows = (db: Db, sql: string): Array<Row> =>
  db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
const values = (db: Db, sql: string): Array<unknown> => rows(db, sql).map((row) => Object.values(row)[0]);
/** A stored JSON text as a value. */
const parsed = (text: unknown): unknown => JSON.parse(String(text));
const versionOf = (db: Db): number => Number(db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v);
/** The whole database: its objects and every row. */
const everything = (db: Db): unknown => ({ shape: schemaShape(db), rows: filledRows(db) });

test('a database at version 60 opens at version 61', () => {
  // Bug: a step that runs but records no version, so the next open runs it again over the renamed tables.
  const file = at60(ALL);
  assert.equal(opened(file, versionOf), 61);
});

test('step 61 renames the two tables and the column and keeps every entry and mirror row', () => {
  // Bug: a rename that copies the tables and loses a row, or leaves the column under the old name, so every SQL of
  // diary-entries.ts and place-owner.ts that reads `diary_mirrors.diary_id` throws.
  const file = at60(ALL);
  const after = opened(file, (db) => ({
    entries: values(db, 'SELECT id FROM diary ORDER BY at_ms'),
    mirrors: rows(db, 'SELECT id, diary_id, iface, place_id, native_ids FROM diary_mirrors'),
  }));
  assert.deepEqual(after, {
    entries: ['diary:old1', 'diary:e1'],
    mirrors: [
      { id: NEW_MIRROR_PUB, diary_id: 'diary:e1', iface: 'discord', place_id: 'place:p1', native_ids: '["m-1"]' },
    ],
  });
});

test('after step 61 no table, index or trigger is named after selfreflection or names it in its SQL', () => {
  // Bug: SQLite keeps an index's and a trigger's name through a table rename, and the trigger's body still names the
  // old table, so the first insert into diary_mirrors fails.
  const file = at60(ALL);
  const left = opened(file, (db) =>
    rows(db, "SELECT type, name FROM sqlite_master WHERE name LIKE '%selfreflection%' OR sql LIKE '%selfreflection%'")
  );
  assert.deepEqual(left, []);
  const objects = opened(file, (db) =>
    values(
      db,
      "SELECT name FROM sqlite_master WHERE tbl_name IN ('diary', 'diary_mirrors') AND type <> 'table' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name"
    )
  );
  assert.deepEqual(objects, [
    'diary_holder',
    'diary_mirrors_diary',
    'diary_mirrors_holder',
    'diary_mirrors_id',
    'diary_mirrors_id_fill',
  ]);
});

test('after step 61 no row of a migrated database holds the old word in any form', () => {
  // Bug: a rename that misses one id, path, key or JSON word, which code then compares against `diary` and never
  // finds. Every seeded value that holds the word is one code compares against.
  const file = at60(ALL);
  const left = opened(file, (db) =>
    Object.entries(filledRows(db)).flatMap(([table, all]) =>
      all.filter((row) => /selfreflection/i.test(row)).map((row) => `${table} ${row}`)
    )
  );
  assert.deepEqual(left, []);
});

test("after step 61 a mirror row written with no id gets the trigger's id from the renamed column", () => {
  // Bug: the recreated trigger reads the old column, so a new mirror row's id is `mirror:::` or the insert throws.
  const file = at60(ALL);
  const id = opened(file, (db) => {
    db.prepare(
      "INSERT INTO diary_mirrors (diary_id, iface, place_id) VALUES ('diary:e9', 'discord', 'place:p2')"
    ).run();
    return db.prepare("SELECT id FROM diary_mirrors WHERE diary_id = 'diary:e9'").get()?.id;
  });
  assert.equal(id, 'mirror:diary:e9:discord:place:p2');
});

test('after step 61 media_links takes the owner kind diary and refuses selfreflection', () => {
  // Bug: the rebuild keeps the old CHECK, so the next picture link of a diary entry fails, or loses the links.
  const file = at60(ALL);
  opened(file, (db) => {
    assert.deepEqual(rows(db, 'SELECT owner_kind, owner_id, media_id FROM media_links ORDER BY owner_id'), [
      { owner_kind: 'diary', owner_id: 'diary:e1', media_id: 'media:diary:diary_e1-1' },
      { owner_kind: 'diary', owner_id: 'diary:old1', media_id: 'media:diary:diary_old1-1' },
      { owner_kind: 'source', owner_id: 'src:1', media_id: 'media:other-1' },
    ]);
    const link = db.prepare('INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES (?, ?, 1, ?)');
    link.run('diary', 'diary:e1', 'media:x');
    assert.throws(() => link.run('selfreflection', 'diary:e1', 'media:y'), /CHECK constraint/);
  });
});

test('step 61 renames the entry ids under selfreflection: and keeps those already under diary:', () => {
  // Bug: the store mints `diary:<uuid>` and finds none of her older entries, or a blind replace turns an id the
  // first rename left as `diary:old1` into something else.
  const file = at60(ALL);
  const ids = opened(file, (db) => ({
    entries: values(db, 'SELECT id FROM diary ORDER BY id'),
    publications: values(db, 'SELECT row_id FROM publications ORDER BY row_id'),
    grants: values(db, 'SELECT row_id FROM publication_grants'),
    media: values(db, 'SELECT owner FROM media ORDER BY owner'),
  }));
  assert.deepEqual(ids, {
    entries: ['diary:e1', 'diary:old1'],
    publications: ['diary:e1', 'diary:old1'],
    grants: ['diary:e1'],
    media: ['diary:e1', 'diary:old1'],
  });
});

test('step 61 renames the publications id, kind, key, grant and writer', () => {
  // Bug: the mirrors' drain selects `row_kind = 'diary'` and sends nothing, a key that keeps the old word lets the
  // publisher queue the same post twice, or a mirror's publication no longer carries its mirror row's id.
  const file = at60(ALL);
  const after = opened(file, (db) =>
    rows(db, 'SELECT id, row_kind, idempotency_key, grant_id, writer FROM publications ORDER BY id')
  );
  assert.deepEqual(after, [
    {
      id: NEW_MIRROR_PUB,
      row_kind: 'diary',
      idempotency_key: 'diary:diary:e1:place:p1',
      grant_id: 'grant:diary:e1',
      writer: 'diary',
    },
    {
      id: 'pub:0002',
      row_kind: 'diary',
      idempotency_key: 'diary:diary:old1:place:p1',
      grant_id: null,
      writer: 'diary',
    },
  ]);
});

test('step 61 renames the publication grant its id and kind', () => {
  // Bug: preparePublication looks the grant up by `row_kind = 'diary'` and the entry, finds none, and refuses the post.
  const file = at60(ALL);
  const after = opened(file, (db) => rows(db, 'SELECT id, row_kind, row_id FROM publication_grants'));
  assert.deepEqual(after, [{ id: 'grant:diary:e1', row_kind: 'diary', row_id: 'diary:e1' }]);
});

test('after step 61 the publications and grants guards refuse a changed key and a delete again', () => {
  // Bug: the step drops the guards to update the keys and does not put them back.
  const file = at60(ALL);
  opened(file, (db) => {
    assert.throws(
      () => db.prepare("UPDATE publications SET idempotency_key = 'x' WHERE row_kind = 'diary'").run(),
      /keeps its row and its key/
    );
    assert.throws(() => db.prepare("DELETE FROM publications WHERE row_kind = 'diary'").run(), /never deleted/);
    assert.throws(() => db.prepare("UPDATE publication_grants SET row_id = 'x' WHERE row_kind = 'diary'").run());
    assert.throws(() => db.prepare("DELETE FROM publication_grants WHERE row_kind = 'diary'").run());
  });
});

test('step 61 renames the writer of the entries, their mirrors and the operational row', () => {
  // Bug: place-owner.ts finds the persona's rows by the writer `diary`, so rows left under the old writer are
  // never read and the next save writes a second set beside them.
  const file = at60(ALL);
  const writers = opened(file, (db) => ({
    entries: values(db, 'SELECT DISTINCT writer FROM diary'),
    mirrors: values(db, 'SELECT DISTINCT writer FROM diary_mirrors'),
    operational: values(db, "SELECT writer FROM operational WHERE owner LIKE 'unit:%'"),
  }));
  assert.deepEqual(writers, { entries: ['diary'], mirrors: ['diary'], operational: ['diary'] });
});

test('step 61 moves the operational row to the kind diary and the owner collectionId gives that kind', () => {
  // Bug: the store reads the row by `kind = 'diary'`, and a row whose owner still hashes the old kind is a second
  // value the persona's unit never finds.
  const file = at60(ALL);
  const after = opened(file, (db) => rows(db, "SELECT kind, owner, value FROM operational WHERE writer = 'diary'"));
  assert.deepEqual(after, [
    { kind: 'diary', owner: collectionId(personaKey('diary')), value: '{"$has":["posts"],"updatedAt":2000}' },
  ]);
});

test('step 61 renames the mirrors kind and ids and keeps an id the first rename left as mirror:diary:', () => {
  // Bug: mirror-config.ts looks a mirror up by `row_kind = 'diary'` and the place, so a row left under the old
  // kind is a mirror she never posts to, and a second one is registered beside it.
  const file = at60(ALL);
  const after = opened(file, (db) => rows(db, 'SELECT id, place_id, row_kind FROM mirrors ORDER BY place_id'));
  assert.deepEqual(after, [
    { id: 'mirror:diary:place:p1', place_id: 'place:p1', row_kind: 'diary' },
    { id: 'mirror:diary:place:p2', place_id: 'place:p2', row_kind: 'diary' },
  ]);
});

test('step 61 renames the picture ids, their paths and their vectors in folder and file name', () => {
  // Bug: the media job mints `media:diary:diary_<id>-<n>` for a renamed entry and writes a second row and file beside
  // the stored one, or a path that keeps the old folder reads as missing once the folder is moved.
  const file = at60(ALL);
  const after = opened(file, (db) => ({
    media: rows(db, 'SELECT id, path FROM media ORDER BY id'),
    vectors: rows(db, 'SELECT item_id, chunk_key FROM vectors ORDER BY item_id'),
  }));
  assert.deepEqual(after, {
    media: [
      { id: 'media:diary:diary_e1-1', path: 'media/diary/diary_e1-1.png' },
      { id: 'media:diary:diary_old1-1', path: 'media/diary/diary_old1-1.png' },
    ],
    vectors: [
      { item_id: 'media:diary:diary_e1-1', chunk_key: 'media:media:diary:diary_e1-1' },
      { item_id: 'media:diary:diary_old1-1', chunk_key: 'media:media:diary:diary_old1-1' },
    ],
  });
});

test('step 61 deletes an orphan media:diary: vector whose media:selfreflection: twin is live', () => {
  // Bug: the rename of the twin's chunk_key hits the UNIQUE key of the orphan and the whole open fails.
  const file = at60(ALL);
  // The orphan's model is `orphan` and the twin's `m`, so the row left under the new key shows which one stayed.
  const before = rawRead(file, (db) =>
    rows(db, "SELECT item_id, model FROM vectors WHERE item_id LIKE 'media:%diary_old1-1' ORDER BY item_id")
  );
  assert.deepEqual(before, [
    { item_id: 'media:diary:diary_old1-1', model: 'orphan' },
    { item_id: 'media:selfreflection:diary_old1-1', model: 'm' },
  ]);
  const after = opened(file, (db) =>
    rows(db, "SELECT item_id, chunk_key, model FROM vectors WHERE item_id LIKE 'media:%diary_old1-1'")
  );
  assert.deepEqual(after, [
    { item_id: 'media:diary:diary_old1-1', chunk_key: 'media:media:diary:diary_old1-1', model: 'm' },
  ]);
});

test('step 61 renames the graph nodes of the entries, the publication and the picture with their row ids', () => {
  // Bug: graph.ts projects a diary entry to `diary:<id>` and finds the old node, so it writes a second node and the
  // first keeps the entry's witnesses.
  const file = at60(ALL);
  const nodes = opened(file, (db) =>
    rows(db, "SELECT id, kind, row_id FROM graph_nodes WHERE kind IN ('diary', 'media', 'publication') ORDER BY id")
  );
  assert.deepEqual(nodes, [
    { id: NEW.entry, kind: 'diary', row_id: 'diary:e1' },
    { id: NEW.oldIdEntry, kind: 'diary', row_id: 'diary:old1' },
    { id: NEW.picture, kind: 'media', row_id: 'media:diary:diary_e1-1' },
    { id: NEW.publication, kind: 'publication', row_id: NEW_MIRROR_PUB },
  ]);
});

test('step 61 moves the edges to the renamed ends with their keys, owners and ids recomputed', () => {
  // Bug: the projection recomputes an edge's id from its ends and finds none under the old hash, writes a second
  // edge that hits the UNIQUE projection_key, or retires the edges of an owner key it no longer recognises.
  const file = at60(ALL);
  const edges = opened(file, (db) =>
    rows(db, 'SELECT id, src, dst, projection_key, owner_key FROM graph_edges ORDER BY predicate')
  );
  assert.deepEqual(edges, [
    {
      id: NEW_ILLUSTRATED,
      src: NEW.entry,
      dst: NEW.picture,
      projection_key: projectionKey('illustrated_by', NEW.entry, NEW.picture),
      owner_key: 'diary:diary:e1',
    },
    {
      id: NEW_PUBLISHED,
      src: NEW.entry,
      dst: NEW.publication,
      projection_key: projectionKey('published_as', NEW.entry, NEW.publication),
      owner_key: `publications:${NEW_MIRROR_PUB}`,
    },
  ]);
});

test('step 61 moves the witnesses of the renamed nodes and of the recomputed edges', () => {
  // Bug: node_access keeps the old node ids and edge ids, so the audience check finds no witness and hides the entry.
  const file = at60(ALL);
  const access = opened(file, (db) => rows(db, 'SELECT node_id, evidence_id FROM node_access ORDER BY node_id'));
  assert.deepEqual(access, [
    { node_id: NEW.entry, evidence_id: NEW.entry },
    { node_id: NEW.oldIdEntry, evidence_id: NEW.oldIdEntry },
    { node_id: NEW.picture, evidence_id: NEW_ILLUSTRATED },
    { node_id: NEW.publication, evidence_id: NEW_PUBLISHED },
  ]);
});

test('after step 61 every column that references a renamed id finds the row it names', () => {
  // Bug: an id renamed in its own table and not in a column that points at it, which leaves a dangling reference the
  // reader joins on and loses: an entry's mirror, publication, grant, picture or link, a picture's vector, a mirror's
  // publication, a node's row, an edge's end or owner, or a witness.
  const file = at60(ALL);
  const dangling = opened(file, (db) => {
    const count = (sql: string): number => Number(values(db, `SELECT COUNT(*) FROM ${sql}`)[0]);
    return {
      'diary_mirrors.diary_id': count('diary_mirrors m WHERE m.diary_id NOT IN (SELECT id FROM diary)'),
      'diary_mirrors.id = publications.id': count('diary_mirrors m WHERE m.id NOT IN (SELECT id FROM publications)'),
      'publications.row_id': count('publications p WHERE p.row_id NOT IN (SELECT id FROM diary)'),
      'publications.grant_id': count(
        'publications p WHERE p.grant_id IS NOT NULL AND p.grant_id NOT IN (SELECT id FROM publication_grants)'
      ),
      'publication_grants.row_id': count('publication_grants g WHERE g.row_id NOT IN (SELECT id FROM diary)'),
      'media.owner': count('media m WHERE m.owner NOT IN (SELECT id FROM diary)'),
      'media_links.owner_id': count(
        "media_links l WHERE l.owner_kind = 'diary' AND l.owner_id NOT IN (SELECT id FROM diary)"
      ),
      'media_links.media_id': count(
        "media_links l WHERE l.owner_kind = 'diary' AND l.media_id NOT IN (SELECT id FROM media)"
      ),
      'vectors.item_id': count("vectors v WHERE v.kind = 'media' AND v.item_id NOT IN (SELECT id FROM media)"),
      'vectors.chunk_key': count(
        "vectors v WHERE v.kind = 'media' AND v.chunk_key NOT IN (SELECT 'media:' || id FROM media)"
      ),
      'graph_nodes.row_id': count(
        `graph_nodes n WHERE (n.kind = 'diary' AND n.row_id NOT IN (SELECT id FROM diary))
          OR (n.kind = 'publication' AND n.row_id NOT IN (SELECT id FROM publications))
          OR (n.kind = 'media' AND n.row_id NOT IN (SELECT id FROM media))`
      ),
      'graph_nodes.id': count("graph_nodes n WHERE n.id <> n.kind || ':' || n.row_id"),
      'graph_edges.src': count('graph_edges e WHERE e.src NOT IN (SELECT id FROM graph_nodes)'),
      'graph_edges.dst': count('graph_edges e WHERE e.dst NOT IN (SELECT id FROM graph_nodes)'),
      'graph_edges.owner_key': count(
        `graph_edges e WHERE e.owner_key NOT IN (SELECT 'diary:' || id FROM diary)
          AND e.owner_key NOT IN (SELECT 'publications:' || id FROM publications)`
      ),
      'node_access.node_id': count('node_access a WHERE a.node_id NOT IN (SELECT id FROM graph_nodes)'),
      'node_access.evidence_id': count(
        `node_access a WHERE a.evidence_id NOT IN (SELECT id FROM graph_nodes)
          AND a.evidence_id NOT IN (SELECT id FROM graph_edges)`
      ),
    };
  });
  assert.deepEqual(
    Object.entries(dangling).filter(([, n]) => n > 0),
    []
  );
});

test("step 61 renames the journal's mode and codes and a receipt's code, and leaves other words alone", () => {
  // Bug: the label lookup tools.result.reasons[<code>] finds no `selfreflection-mirror` any more and shows her a raw
  // code, or the step rewrites a mode or code that never held the word.
  const file = at60(ALL);
  const after = opened(file, (db) => ({
    day: values(db, 'SELECT extra FROM day ORDER BY id').map(parsed),
    receipt: parsed(values(db, "SELECT receipt FROM deliveries WHERE key = 'del:1'")[0]),
  }));
  assert.deepEqual(after, {
    day: [
      { mode: 'diary', result: { code: 'diary-mirror' }, actions: [{ code: 'diary-draw-only' }, { code: 'ok' }] },
      { mode: 'reply', result: { code: 'ok' } },
    ],
    receipt: { code: 'diary-mirror', ok: false },
  });
});

test("step 61 renames the archive's service and purpose of a diary request and no other request's", () => {
  // Bug: the usage report groups by service and purpose, so the diary's old requests stand apart from its new ones.
  const file = at60(ALL);
  const after = opened(file, (db) => rows(db, 'SELECT id, service, purpose FROM model_requests ORDER BY id'));
  assert.deepEqual(after, [
    { id: 'mr:1', service: 'diary', purpose: 'diary-planner' },
    { id: 'mr:2', service: 'core', purpose: 'reply' },
  ]);
});

test('step 61 throws and leaves the file at 60 when a renamed entry id already exists', () => {
  // Bug: the rename overwrites or merges two entries whose ids meet under the new word, and her diary loses one.
  const file = at60(
    `${ENTRIES}
    INSERT INTO selfreflection (id, at_ms, kind, status, scope_kind) VALUES ('selfreflection:twin', 3000, 'thought',
      'done', 'group'), ('diary:twin', 3001, 'thought', 'done', 'group');`
  );
  assert.throws(() => openMemoryDb(file).close());
  const left = rawRead(file, (db) => ({
    version: versionOf(db),
    entries: values(db, "SELECT id FROM selfreflection WHERE id LIKE '%twin' ORDER BY id"),
  }));
  assert.deepEqual(left, { version: 60, entries: ['diary:twin', 'selfreflection:twin'] });
});

test('step 61 throws and leaves the file at 60 when a renamed picture id already exists', () => {
  // Bug: a picture's new id meets a live row under media:diary:, and the rename drops one of the two pictures.
  const file = at60(
    `${ENTRIES}${PICTURES}
    INSERT INTO media (id, kind, path, owner, scope_kind) VALUES
      ('media:diary:diary_e1-1', 'image', 'media/diary/other-1.png', 'diary:old1', 'group');`
  );
  assert.throws(() => openMemoryDb(file).close());
  assert.equal(rawRead(file, versionOf), 60);
});

test('step 61 throws and leaves the file at 60 when a renamed picture path already exists', () => {
  // Bug: two rows come to name one file, and the deploy's rename of the files overwrites one picture with another.
  const file = at60(
    `${ENTRIES}${PICTURES}
    INSERT INTO media (id, kind, path, owner, scope_kind) VALUES
      ('media:other-2', 'image', 'media/diary/diary_e1-1.png', NULL, 'group');`
  );
  assert.throws(() => openMemoryDb(file).close());
  assert.equal(rawRead(file, versionOf), 60);
});

test('step 61 throws and leaves the file at 60 when a renamed publication key already exists', () => {
  // Bug: a renamed key meets a publication already under it, and one post's delivery record is lost or merged.
  const file = at60(
    `${ENTRIES}
    INSERT INTO publications (id, row_kind, row_id, status, idempotency_key, created_at) VALUES
      ('pub:0003', 'diary', 'diary:e1', 'sent', 'diary:diary:e1:place:p1', '${AT}');`
  );
  assert.throws(() => openMemoryDb(file).close());
  assert.equal(rawRead(file, versionOf), 60);
});

test('a collision on one renamed id rolls the whole step back and changes nothing in the file', () => {
  // Bug: the step renames the tables, the graph or the pictures before it meets the collision, and the throw leaves
  // a half-renamed database that the next open can neither migrate nor read.
  const file = at60(
    `${ALL}
    INSERT INTO selfreflection (id, at_ms, kind, status, scope_kind) VALUES ('diary:e1', 4000, 'thought', 'done', 'group');`
  );
  const before = rawRead(file, everything);
  assert.throws(() => openMemoryDb(file).close());
  assert.deepEqual(rawRead(file, everything), before);
});

test('a fresh database and one brought from 60 by step 61 have the same shape', () => {
  // Bug: the step recreates an index, the trigger or media_links in a form the baseline plus the steps does not
  // give a new database, so the two drift apart and the next step meets two shapes.
  const file = at60(ALL);
  const migrated = opened(file, schemaShape);
  const fresh = opened(path.join(tempDir('nep-diary-61-fresh-'), 'memory.db'), schemaShape);
  assert.ok('table diary' in fresh, 'a fresh database has the table diary');
  assert.deepEqual(migrated, fresh);
});

test('step 61 run a second time on a migrated database changes no table, index or row', () => {
  // Bug: a step written so that a second run renames again, fails on the tables it already moved, or deletes the
  // vectors it renamed.
  const file = at60(ALL);
  const handle = openMemoryDb(file);
  try {
    const db = dbOf(handle);
    assert.equal(versionOf(db), 61);
    const first = everything(db);
    if (step61 === undefined) assert.fail('MIGRATIONS holds no step 61');
    inTransaction(db, () => (typeof step61 === 'function' ? step61(db) : db.exec(step61)));
    assert.deepEqual(everything(db), first);
  } finally {
    handle.close();
  }
});
