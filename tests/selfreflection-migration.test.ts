// B10 of the master plan, the data half: the memory database of a deployment that still holds the diary under its old
// names (schema 33, tests/fixtures/diary-database.ts) is opened by the engine that knows only `selfreflection`. The
// appended migration renames the two tables with their indexes, trigger and `diary_id` column, the storage unit of
// the persona's entries (whose id is a hash of its kind, so every row that points at it follows), and the stored
// discriminators that said `diary`. It changes no content and keeps every id, every audience, every timestamp. The
// shipped migrations stay as they were. Real temporary databases, synthetic data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIGRATIONS, openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import { ensureUnit } from '../src/memory/db/storage-units.ts';
import { personaKey } from '../src/memory/db/storage-keys.ts';
import { publicationByKey, publicationKey } from '../src/memory/db/publish.ts';
import { mirrorRows, unpublishedSince } from '../src/memory/db/mirror-config.ts';
import { ENTRIES, PLACE, SHIPPED, keyJsonOf, seedDiaryDatabase, unitIdOf } from './fixtures/diary-database.ts';

const OLD_UNIT = unitIdOf('diary');
const NEW_UNIT = unitIdOf('selfreflection');
/** Tables that change name, with the column that changes in the second. */
const RENAMED: Readonly<Record<string, string>> = { diary: 'selfreflection', diary_mirrors: 'selfreflection_mirrors' };

/** Opens `file` with the engine's own migrations and runs `read` on its connection. */
function reading<T>(file: string, read: (db: Db, handle: ReturnType<typeof openMemoryDb>) => T): T {
  const handle = openMemoryDb(file);
  try {
    return read(dbOf(handle), handle);
  } finally {
    handle.close();
  }
}

/** The user tables of a database, without the full-text shadow tables. */
function tablesOf(db: Db): Array<string> {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String(row.name))
    .filter((name) => !/_(?:fts|tri)(?:_|$)/.test(name));
}

/** Every row of a table, as plain objects. */
const rowsOf = (db: Db, table: string): Array<Row> =>
  db
    .prepare(`SELECT * FROM "${table}"`)
    .all()
    .map((row) => ({ ...row }));

/** Rows in a fixed order, so that two tables compare by content and not by where a copy put each row. */
const canon = (rows: ReadonlyArray<Row>): Array<string> => rows.map((row) => JSON.stringify(row)).sort();

/** The rows of every table, keyed by the table's name before the rename. */
function snapshot(db: Db): Record<string, Array<Row>> {
  const out: Record<string, Array<Row>> = {};
  for (const table of tablesOf(db)) {
    if (table === 'schema_version') continue;
    out[table] = rowsOf(db, table);
  }
  return out;
}

/** The old database, snapshotted before the engine opens it. */
function oldSnapshot(file: string): Record<string, Array<Row>> {
  const handle = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, SHIPPED) });
  try {
    return snapshot(dbOf(handle));
  } finally {
    handle.close();
  }
}

test('the rename is appended after the shipped migrations and the database reaches it', () => {
  // Bug: the rename is written into a shipped migration, which a deployment at that version never runs again.
  assert.ok(MIGRATIONS.length > SHIPPED);
  const file = seedDiaryDatabase();
  const version = reading(file, (db) => Number(db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v));
  assert.equal(version, MIGRATIONS.length);
});

test('no table, index, trigger or constraint is named for the diary any more, and the new ones keep their shape', () => {
  // Bug: an index or a trigger keeps the old name, and a later rename or a restore trips on it.
  const file = seedDiaryDatabase();
  reading(file, (db) => {
    const left = db.prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%diary%' OR name LIKE '%diary%'").all();
    assert.deepEqual(left, []);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'selfreflection%' ORDER BY name").all();
    assert.deepEqual(
      names.map((row) => row.name),
      [
        'selfreflection',
        'selfreflection_mirrors',
        'selfreflection_mirrors_id',
        'selfreflection_mirrors_id_fill',
        'selfreflection_mirrors_owner',
        'selfreflection_mirrors_selfreflection',
        'selfreflection_mirrors_storage_owner',
        'selfreflection_owner',
        'selfreflection_storage_owner',
      ]
    );
    const columns = db
      .prepare('PRAGMA table_info(selfreflection_mirrors)')
      .all()
      .map((column) => column.name);
    assert.deepEqual(columns, [
      'selfreflection_id',
      'iface',
      'place_id',
      'native_ids',
      'posted_at',
      'retired_at',
      'owner_file',
      'id',
      'owner_key',
    ]);
  });
});

test('every row of the entries and of their mirror history is kept, whole, under the new names', () => {
  // Bug: the migration copies columns by position and an entry loses its audience, its text or its place in the order.
  const file = seedDiaryDatabase();
  const before = oldSnapshot(file);
  reading(file, (db) => {
    const entries = rowsOf(db, 'selfreflection');
    assert.deepEqual(canon(entries), canon((before.diary ?? []).map((row) => ({ ...row, owner_key: NEW_UNIT }))));
    assert.deepEqual(
      db
        .prepare('SELECT id FROM selfreflection ORDER BY position')
        .all()
        .map((row) => row.id),
      ENTRIES.map((entry) => entry.id)
    );
    const history = rowsOf(db, 'selfreflection_mirrors');
    assert.deepEqual(
      canon(history),
      canon(
        (before.diary_mirrors ?? []).map(({ diary_id: entry, ...row }) => ({
          selfreflection_id: entry,
          ...row,
          owner_key: NEW_UNIT,
        }))
      )
    );
  });
});

test('every other table has the rows it had, and the ones that said diary say selfreflection and nothing else changed', () => {
  // Bug: the rewrite of a discriminator touches the row's id, its key, its time or its receipts.
  const file = seedDiaryDatabase();
  const before = oldSnapshot(file);
  const expected: Record<string, (row: Row) => Row> = {
    mirrors: (row) => ({ ...row, row_kind: 'selfreflection' }),
    publications: (row) => ({
      ...row,
      row_kind: 'selfreflection',
      idempotency_key: `selfreflection:dy-e1:${PLACE}`,
      owner_key: NEW_UNIT,
    }),
    publication_grants: (row) => ({ ...row, row_kind: 'selfreflection' }),
    turn_reads: (row) => ({ ...row, row_kind: 'selfreflection' }),
    // The specifier's map renamed every node; a database at schema 33 also holds the shipped interface and authority nodes.
    graph_nodes: (row) => (row.kind === 'diary' ? { ...row, kind: 'selfreflection', id: 'selfreflection:dy-e1' } : row),
    media_links: (row) => (row.owner_kind === 'diary' ? { ...row, owner_kind: 'selfreflection' } : row),
    operational: (row) => (row.kind === 'diary' ? { ...row, kind: 'selfreflection', owner_key: NEW_UNIT } : row),
    files: (row) => ({ ...row, kind: 'selfreflection' }),
    // A category is no place, the owner's word of 2026-11-06.
    places: (row) => {
      const { category, ...kept } = row;
      void category;
      return kept;
    },
    legacy_unit_aliases: (row) => ({ ...row, unit_id: NEW_UNIT }),
    storage_units: (row) =>
      row.id === OLD_UNIT
        ? { ...row, id: NEW_UNIT, kind: 'selfreflection', key_json: keyJsonOf('selfreflection') }
        : row,
  };
  reading(file, (db) => {
    const after = snapshot(db);
    for (const table of Object.keys(before)) {
      if (table in RENAMED || table === 'meta') continue;
      const map = expected[table] ?? ((row: Row) => row);
      assert.deepEqual(canon(after[table] ?? []), canon((before[table] ?? []).map(map)), table);
    }
  });
});

test('the pending marks of the data steps keep their meaning under the new name', () => {
  // Bug: a mark left for the first open that knows the channel is lost, and the mirror is never seeded.
  const file = seedDiaryDatabase();
  reading(file, (db) => {
    const keys = db
      .prepare("SELECT key FROM meta WHERE key LIKE '%pending%' ORDER BY key")
      .all()
      .map((row) => row.key);
    assert.deepEqual(keys, ['selfreflection_destination_pending', 'selfreflection_mirror_pending']);
  });
});

test('the storage unit of the entries has the id the catalog derives from the new kind, and every pointer follows', () => {
  // Bug: the unit keeps its old hash while the code asks for the new one, so every entry reads as owned by nobody.
  const file = seedDiaryDatabase();
  reading(file, (db) => {
    // The specifier compared node:sqlite's null-prototype rows with a plain object, which strict equality refuses.
    assert.deepEqual(
      db
        .prepare("SELECT id, kind, key_json FROM storage_units WHERE kind IN ('diary', 'selfreflection')")
        .all()
        .map((row) => ({ ...row })),
      [{ id: NEW_UNIT, kind: 'selfreflection', key_json: keyJsonOf('selfreflection') }]
    );
    assert.equal(ensureUnit(db, personaKey('selfreflection')), NEW_UNIT);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM storage_units').get()?.n, 2);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    // The other unit and the rows pointing at it are as they were.
    assert.equal(
      db.prepare("SELECT owner_key FROM operational WHERE kind = 'state'").get()?.owner_key,
      unitIdOf('state')
    );
  });
});

test('no column of any table holds the bare word diary any more, but the block name the persona reads', () => {
  // Bug: one table keeps the old discriminator and the reader that asks for the new one finds nothing.
  const file = seedDiaryDatabase();
  reading(file, (db) => {
    const found: Array<string> = [];
    for (const table of tablesOf(db)) {
      for (const column of db.prepare(`PRAGMA table_info("${table}")`).all()) {
        const name = String(column.name);
        if (table === 'turn_reads' && name === 'block') continue;
        const n = db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE CAST("${name}" AS TEXT) = 'diary'`).get()?.n;
        if (Number(n) > 0) found.push(`${table}.${name}`);
      }
    }
    assert.deepEqual(found, []);
  });
});

test('media links take the new owner kind and refuse the old one', () => {
  // Bug: the CHECK constraint still lists `diary`, so the first picture of a new entry cannot be linked.
  const file = seedDiaryDatabase();
  reading(file, (db) => {
    const insert = db.prepare('INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES (?, ?, 0, ?)');
    insert.run('selfreflection', 'dy-e2', 'media:new');
    insert.run('source', 'src2', 'media:other');
    assert.throws(() => insert.run('diary', 'dy-e2', 'media:old'));
  });
});

test('a mirror row written without an id gets one built from the new column', () => {
  // Bug: the id-filling trigger is dropped with the table or still reads `diary_id`.
  const file = seedDiaryDatabase();
  reading(file, (db) => {
    db.prepare(
      "INSERT INTO selfreflection_mirrors (selfreflection_id, iface, place_id, native_ids) VALUES ('dy-e2', 'fake', ?, '[]')"
    ).run(PLACE);
    const made = db.prepare("SELECT id FROM selfreflection_mirrors WHERE selfreflection_id = 'dy-e2'").get();
    assert.equal(made?.id, `mirror:dy-e2:fake:${PLACE}`);
  });
});

test('the mirror, its publications, the backfill scan and the audience refusals work on the migrated database', async () => {
  // Bug: the entries are renamed and the code that publishes, scans or refuses them still finds none.
  const file = seedDiaryDatabase();
  const { refusedEntries } = await import('../src/memory/db/selfreflection-audience.ts');
  reading(file, (db, handle) => {
    const mirrors = mirrorRows(handle);
    assert.deepEqual(
      mirrors.map((mirror) => [mirror.id, mirror.placeId, mirror.enabled]),
      [[`mirror:diary:${PLACE}`, PLACE, true]]
    );
    const [mirror] = mirrors;
    assert.ok(mirror);
    // Open and unpublished: yes. Published, kept for another interface, malformed audience, retired: no.
    assert.deepEqual(
      unpublishedSince(handle, mirror).map((entry) => entry.id),
      ['dy-e2']
    );
    assert.deepEqual(refusedEntries(dbOf(handle)), [{ entryId: 'dy-e4', reason: 'audience-malformed' }]);
    const sent = publicationByKey(handle, publicationKey('selfreflection', 'dy-e1', PLACE));
    assert.equal(sent?.id, 'pub:one');
    assert.equal(sent?.status, 'sent');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM publications').get()?.n, 1);
  });
});

test('the audience of every entry is the one it had', () => {
  // Bug: a restricted entry comes out of the migration unrestricted, and the next mirror posts it.
  const file = seedDiaryDatabase();
  const before = oldSnapshot(file);
  reading(file, (db) => {
    const read = (rows: Array<Row>) =>
      rows.map((row) => JSON.stringify([row.id, row.audience_id, row.extra, row.retired_at]));
    assert.deepEqual(read(rowsOf(db, 'selfreflection')).sort(), read(before.diary ?? []).sort());
  });
});

test('opening the migrated database again changes nothing', () => {
  // Bug: the migration runs a second time on a start and renames what is already renamed, or fails on it.
  const file = seedDiaryDatabase();
  const first = reading(file, (db) => JSON.stringify(snapshot(db)));
  const second = reading(file, (db) => JSON.stringify(snapshot(db)));
  assert.ok(Object.hasOwn(JSON.parse(first) as object, 'selfreflection'), 'the first open renamed the table');
  assert.equal(second, first);
});

test('a database that never had a diary row opens to the same names', () => {
  // Bug: the rename assumes a storage unit and a mirror exist and throws on a fresh install.
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%diary%'").all(), []);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM selfreflection').get()?.n, 0);
  } finally {
    handle.close();
  }
});
