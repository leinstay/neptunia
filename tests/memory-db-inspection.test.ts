// src/memory/db/inspection.ts: the owner's exhaustive storage catalog and row reader. The live connection defines what
// exists, so a table nobody registered is still listed and readable, and every row stays reachable: retired, internal,
// unowned, keyless and derived rows alike. Reading writes nothing, because read evidence (`node_access`, `turn_reads`)
// would otherwise be written by inspection. Plan 2026-11-04-cli-and-memory task 6; S9 reruns this reader over the semantic
// tables. Contract:
//   catalog(db: Db): InspectionCatalog
//   readRows(db: Db, request: InspectionRead): InspectionPage
//   readRow(db: Db, request: { table: string; locator: RowLocator }): InspectionRow
// `InspectionTable` carries `storageClass: 'domain' | 'operational' | 'derived' | 'metadata' | 'unclassified'`. A refusal
// throws an Error whose `code` is INSPECTION_UNKNOWN_TABLE, INSPECTION_UNKNOWN_COLUMN, INSPECTION_AMBIGUOUS_LOCATOR,
// INSPECTION_ROW_NOT_FOUND, INSPECTION_BAD_LIMIT or INSPECTION_BAD_CURSOR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { boardVersion } from '../src/board/schema.ts';
import { catalog, readRow, readRows } from '../src/memory/db/inspection.ts';
import type { InspectionPage, InspectionRead, InspectionRow, RowLocator } from '../src/memory/db/inspection.ts';
import type { InspectionValue } from '../src/memory/db/inspection-values.ts';
import { openMemoryDb, schemaVersion } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import {
  actualTableNames,
  addAuthority,
  addEdge,
  addPlace,
  addSource,
  cell,
  countOf,
  databaseDigest,
} from './fixtures/memory-db/browser-world.ts';
import { tempDir } from './fixtures/tmp.ts';

function withDb(body: (db: Db) => void): void {
  const handle = openMemoryDb(':memory:');
  try {
    body(dbOf(handle));
  } finally {
    handle.close();
  }
}

/** Rows in every family the reader must not hide: live and retired, internal, unowned, with an FTS index behind them. */
function seed(db: Db): void {
  addAuthority(db, 'zeta', 'zeta/one');
  addPlace(db, { id: 'place:room', iface: 'zeta', authority: 'zeta/one' });
  addSource(db, {
    id: 'source:1',
    place: 'place:room',
    iface: 'zeta',
    audience: 'aud:group:zeta',
    text: 'κουνέλι κήπο',
  });
  addSource(db, {
    id: 'source:retired',
    place: 'place:room',
    iface: 'zeta',
    audience: 'aud:group:zeta',
    text: 'retired line',
    retiredAt: '2026-11-02T00:00:00.000Z',
  });
  db.prepare(
    `INSERT INTO claims (id, subject_kind, subject_id, kind, text, truth, shown, audience_id, scope_kind, retired_at, created_at)
     VALUES ('claim:retired', 'place', 'place:room', 'detail', 'retired claim', 'current', 1, 'aud:internal', 'internal',
       '2026-11-03T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`
  ).run();
  db.prepare(
    `INSERT INTO claims (id, subject_kind, subject_id, kind, text, truth, shown, audience_id, scope_kind, created_at)
     VALUES ('claim:hidden-unowned', 'place', 'place:room', 'detail', 'unowned internal claim', 'current', 0, 'aud:internal',
       'internal', '2026-11-01T00:00:00.000Z')`
  ).run();
  addEdge(db, { src: 'source:1', dst: 'place:room', predicate: 'located_in', audience: 'aud:group:zeta' });
  db.prepare(
    `INSERT INTO turn_reads (turn_id, step, context_id, row_kind, row_id, block, ord, reader_kind)
     VALUES ('turn:1', '0', '', 'claim', 'claim:retired', 'memory', 0, 'turn')`
  ).run();
}

/** Every row of `table`, following `next` until it ends; a small page makes every multi-page path run. */
function allRows(db: Db, table: string, limit = 7): Array<InspectionRow> {
  const rows: Array<InspectionRow> = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 100_000; pages += 1) {
    const page: InspectionPage = readRows(db, { table, filters: [], limit, cursor });
    rows.push(...page.items);
    if (page.next === null) return rows;
    cursor = page.next;
  }
  throw new Error(`the pages of ${table} never end`);
}

const first = (db: Db, table: string, filters: InspectionRead['filters'], limit = 5): InspectionPage =>
  readRows(db, { table, filters, limit, cursor: null });
const text = (value: string): InspectionValue => ({ kind: 'text', value });
const integer = (value: string): InspectionValue => ({ kind: 'integer', value });
const isText = (value: InspectionValue, wanted: string): boolean => value.kind === 'text' && value.value === wanted;

// ---------- the catalog ----------

test('the catalog lists exactly the tables of the schema', () => {
  // Bug: a hand-kept list of tables, so a migration's new table is silently missing from the owner's view.
  withDb((db) => {
    const actual = actualTableNames(db);
    assert.ok(
      actual.includes('node_access') && actual.includes('sqlite_sequence') && actual.includes('sources_fts_idx')
    );
    assert.deepEqual(new Set(catalog(db).tables.map((table) => table.name)), new Set(actual));
  });
});

test('a new table appears readable without a registry change, marked unclassified', () => {
  // Bug: the catalog joins a classification map and drops what the map does not name.
  withDb((db) => {
    db.exec(
      "CREATE TABLE future_family (id TEXT PRIMARY KEY, body TEXT); INSERT INTO future_family VALUES ('f1', 'ζωή');"
    );
    const table = catalog(db).tables.find((one) => one.name === 'future_family');
    assert.equal(table?.storageClass, 'unclassified');
    assert.equal(table?.kind, 'table');
    assert.deepEqual(cell(first(db, 'future_family', []).items[0], 'body'), text('ζωή'));
  });
});

test('virtual, shadow and SQLite tables carry the kind SQLite gives them', () => {
  // Bug: the eight FTS shadows and sqlite_sequence are filtered out as internals, as the backup's table list does.
  withDb((db) => {
    const truth = new Map(
      db
        .prepare("SELECT name, type FROM pragma_table_list WHERE schema = 'main'")
        .all()
        .map((row) => [String(row.name), String(row.type)])
    );
    const tables = catalog(db).tables;
    assert.ok(tables.filter((table) => table.kind === 'shadow').length >= 8);
    for (const table of tables) {
      const expected = table.name.startsWith('sqlite_') ? 'sqlite' : truth.get(table.name);
      assert.equal(table.kind, expected, table.name);
    }
  });
});

test('every column of every table is reported as table_xinfo gives it, hidden ones included', () => {
  // Bug: `PRAGMA table_info` hides the FTS columns `sources_fts` and `rank`, and generated columns.
  withDb((db) => {
    db.exec('CREATE TABLE computed (a INTEGER, b INTEGER GENERATED ALWAYS AS (a + 1) VIRTUAL)');
    for (const table of catalog(db).tables) {
      const expected = db
        .prepare('SELECT * FROM pragma_table_xinfo(?)')
        .all(table.name)
        .map((column) => ({
          name: column.name,
          declaredType: column.type,
          primaryOrder: column.pk,
          isNullable: column.notnull === 0,
          hiddenKind: column.hidden,
        }));
      assert.deepEqual(
        table.columns.map((column) => ({ ...column })),
        expected,
        table.name
      );
    }
  });
});

test('every table reports its DDL, foreign keys, indexes and triggers', () => {
  // Bug: the schema view summarises columns and the owner never sees a trigger or a foreign key.
  withDb((db) => {
    const tables = catalog(db).tables;
    for (const table of tables) {
      const ddl = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table.name)?.sql;
      assert.equal(table.ddl, ddl ?? null, table.name);
      const keys = db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(table.name);
      assert.deepEqual(
        table.foreignKeys.map((key) => ({ ...key })),
        keys.map((key) => ({ ...key })),
        table.name
      );
      const indexes = db.prepare('SELECT name FROM pragma_index_list(?)').all(table.name);
      assert.deepEqual(
        new Set(table.indexes.map((one) => one.name)),
        new Set(indexes.map((one) => one.name)),
        table.name
      );
      const triggers = db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?")
        .all(table.name);
      assert.deepEqual(
        new Set(table.triggers.map((one) => one.name)),
        new Set(triggers.map((one) => one.name)),
        table.name
      );
    }
    assert.ok(tables.find((table) => table.name === 'sources')?.triggers.some((one) => one.name === 'sources_ai'));
    assert.ok(tables.find((table) => table.name === 'graph_edges')?.foreignKeys.length);
  });
});

test('catalog objects list every schema object, and sqlite_schema reads like a table', () => {
  // Bug: indexes, triggers and views have no reader because they hold no rows of their own.
  withDb((db) => {
    db.exec('CREATE VIEW future_view AS SELECT id FROM people');
    const direct = db.prepare('SELECT type, name FROM sqlite_schema').all();
    const label = (one: { type?: unknown; name?: unknown }): string => `${String(one.type)} ${String(one.name)}`;
    const objects = catalog(db).objects;
    assert.deepEqual(new Set(objects.map(label)), new Set(direct.map(label)));
    assert.ok(objects.some((one) => one.type === 'view' && one.name === 'future_view'));
    const rows = allRows(db, 'sqlite_schema', 50);
    assert.equal(rows.length, direct.length);
    assert.ok(rows.some((row) => isText(cell(row, 'name'), 'sources_ai')));
  });
});

test('the catalog reports the memory and board versions of the connection', () => {
  // Bug: the versions come from the code's migration lists, so an older snapshot reports a schema it does not have.
  withDb((db) => {
    assert.equal(catalog(db).boardVersion, boardVersion(db));
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(schemaVersion(db) + 7);
    assert.equal(catalog(db).memoryVersion, schemaVersion(db));
  });
});

test('a database with no migrations gives a catalog of what exists and zero versions', () => {
  const handle = openMemoryDb(':memory:', { migrations: [], boardMigrations: [] });
  try {
    const db = dbOf(handle);
    const result = catalog(db);
    assert.deepEqual(new Set(result.tables.map((table) => table.name)), new Set(actualTableNames(db)));
    assert.equal(result.memoryVersion, 0);
    assert.equal(result.boardVersion, 0);
  } finally {
    handle.close();
  }
});

test('storage is classed as domain, operational, derived or metadata and no class is hidden', () => {
  // Bug: a browser that drops `derived` rows from the listing, or calls an FTS shadow a business record.
  withDb((db) => {
    const classOf = new Map(catalog(db).tables.map((table) => [table.name, table.storageClass]));
    assert.equal(classOf.get('claims'), 'domain');
    assert.equal(classOf.get('leases'), 'operational');
    assert.equal(classOf.get('board_tasks'), 'operational');
    assert.equal(classOf.get('node_access'), 'derived');
    assert.equal(classOf.get('sources_fts'), 'derived');
    assert.equal(classOf.get('sources_fts_data'), 'derived');
    assert.equal(classOf.get('schema_version'), 'metadata');
    assert.equal(classOf.get('sqlite_sequence'), 'metadata');
  });
});

// ---------- rows ----------

test('retired, unshown and unowned rows are read by default', () => {
  // Bug: the reader borrows the domain view's `retired_at IS NULL`, so a retired claim is gone from the owner's view.
  withDb((db) => {
    seed(db);
    const rows = allRows(db, 'claims');
    assert.deepEqual(
      new Set(rows.map((row) => JSON.stringify(cell(row, 'id')))),
      new Set([JSON.stringify(text('claim:retired')), JSON.stringify(text('claim:hidden-unowned'))])
    );
    const retired = rows.find((row) => isText(cell(row, 'id'), 'claim:retired'));
    assert.ok(retired);
    assert.deepEqual(cell(retired, 'retired_at'), text('2026-11-03T00:00:00.000Z'));
    assert.deepEqual(cell(retired, 'owner_file'), { kind: 'null' });
  });
});

test('every storage class survives a row read exactly', () => {
  // Bug: `row.value` from a default statement rounds the integer, and JSON columns are re-serialized.
  withDb((db) => {
    db.exec('CREATE TABLE typed (id INTEGER PRIMARY KEY, v)');
    const insert = db.prepare('INSERT INTO typed (id, v) VALUES (?, ?)');
    const stored = ' {"z" : 1,\n "a":[ 1,2 ]} ';
    insert.run(1, null);
    insert.run(2, '');
    insert.run(3, stored);
    insert.run(4, 'ζωή é 🌿');
    insert.run(5, 9223372036854775807n);
    insert.run(6, -9223372036854775808n);
    insert.run(7, 1.5);
    db.exec('INSERT INTO typed (id, v) VALUES (8, 42.0)');
    insert.run(9, Uint8Array.from([0, 255, 128]));
    insert.run(10, new Uint8Array(0));
    insert.run(11, 9007199254740993n);
    assert.deepEqual(
      allRows(db, 'typed', 100).map((row) => cell(row, 'v')),
      [
        { kind: 'null' },
        text(''),
        text(stored),
        text('ζωή é 🌿'),
        integer('9223372036854775807'),
        integer('-9223372036854775808'),
        { kind: 'real', value: 1.5 },
        { kind: 'real', value: 42 },
        { kind: 'blob', encoding: 'base64', value: Buffer.from([0, 255, 128]).toString('base64') },
        { kind: 'blob', encoding: 'base64', value: '' },
        integer('9007199254740993'),
      ]
    );
  });
});

test('values come in column order with every visible column', () => {
  withDb((db) => {
    db.exec("CREATE TABLE ordered (z TEXT, a TEXT, m TEXT); INSERT INTO ordered VALUES ('1', '2', '3');");
    assert.deepEqual(
      first(db, 'ordered', []).items[0].values.map((one) => one.column),
      ['z', 'a', 'm']
    );
  });
});

test('a composite key locates its row by a typed tuple in key order', () => {
  // Bug: the locator joins a tuple with a delimiter, so ('x|y', 'z') and ('x', 'y|z') are one row.
  withDb((db) => {
    db.exec(`CREATE TABLE pairs (a TEXT, b TEXT, v TEXT, PRIMARY KEY (b, a));
      INSERT INTO pairs VALUES ('x|y', 'z', 'first'), ('x', 'y|z', 'second');`);
    const rows = allRows(db, 'pairs');
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.ok(row.locator.kind === 'primary');
      assert.deepEqual(
        row.locator.values.map((one) => one.column),
        ['b', 'a']
      );
      assert.deepEqual(readRow(db, { table: 'pairs', locator: row.locator }).values, row.values);
    }
  });
});

test('rows with a NULL in a nullable primary key stay apart by their rowid', () => {
  // Bug: SQLite lets several rows share a NULL key, and a locator of the key opens the first one for each.
  withDb((db) => {
    db.exec(`CREATE TABLE nullable (k TEXT PRIMARY KEY, v TEXT);
      INSERT INTO nullable VALUES ('x', 'keyed'), (NULL, 'one'), (NULL, 'two');`);
    const rows = allRows(db, 'nullable');
    assert.equal(rows.length, 3);
    assert.equal(rows.find((row) => isText(cell(row, 'v'), 'keyed'))?.locator.kind, 'primary');
    const open = rows.filter((row) => !isText(cell(row, 'v'), 'keyed'));
    assert.deepEqual(
      open.map((row) => row.locator.kind),
      ['rowid', 'rowid']
    );
    assert.notDeepEqual(open[0].locator, open[1].locator);
    for (const row of open)
      assert.deepEqual(readRow(db, { table: 'nullable', locator: row.locator }).values, row.values);
  });
});

test('a key tuple holding NULL is ambiguous and opens nothing', () => {
  // Bug: `WHERE k IS NULL LIMIT 1` answers with one of the matching rows as if it were the row asked for.
  withDb((db) => {
    db.exec(
      "CREATE TABLE nullable (k TEXT PRIMARY KEY, v TEXT); INSERT INTO nullable VALUES (NULL, 'one'), (NULL, 'two');"
    );
    const locator: RowLocator = { kind: 'primary', values: [{ column: 'k', value: { kind: 'null' } }] };
    assert.throws(() => readRow(db, { table: 'nullable', locator }), { code: 'INSPECTION_AMBIGUOUS_LOCATOR' });
  });
});

test('a locator that names part of a composite key, or another column, is refused', () => {
  withDb((db) => {
    db.exec(
      "CREATE TABLE pairs (a TEXT, b TEXT, PRIMARY KEY (a, b)); INSERT INTO pairs VALUES ('1', '2'), ('1', '3');"
    );
    const part: RowLocator = { kind: 'primary', values: [{ column: 'a', value: text('1') }] };
    assert.throws(() => readRow(db, { table: 'pairs', locator: part }), { code: 'INSPECTION_AMBIGUOUS_LOCATOR' });
    const other: RowLocator = {
      kind: 'primary',
      values: [
        { column: 'a', value: text('1') },
        { column: 'nope', value: text('2') },
      ],
    };
    assert.throws(() => readRow(db, { table: 'pairs', locator: other }), { code: 'INSPECTION_UNKNOWN_COLUMN' });
  });
});

test('a locator of a row that is gone is refused and not answered with an empty row', () => {
  withDb((db) => {
    db.exec('CREATE TABLE one (id INTEGER PRIMARY KEY)');
    const locator: RowLocator = { kind: 'primary', values: [{ column: 'id', value: integer('1') }] };
    assert.throws(() => readRow(db, { table: 'one', locator }), { code: 'INSPECTION_ROW_NOT_FOUND' });
  });
});

test('identical rows of a table with no key both come back, with rowids that open each', () => {
  // Bug: `SELECT DISTINCT` or a dedup on the row's values loses a duplicate of a `claim_sources`-shaped table.
  withDb((db) => {
    db.exec("CREATE TABLE twins (a TEXT, b TEXT); INSERT INTO twins VALUES ('same', 'same'), ('same', 'same');");
    const rows = allRows(db, 'twins');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].locator.kind, 'rowid');
    assert.notDeepEqual(rows[0].locator, rows[1].locator);
    assert.deepEqual(readRow(db, { table: 'twins', locator: rows[1].locator }).values, rows[1].values);
  });
});

test('a rowid locator uses an alias no column shadows', () => {
  // Bug: `SELECT rowid` reads the user's own `rowid` column, and two rows get the same locator.
  withDb((db) => {
    db.exec("CREATE TABLE shadowing (rowid TEXT, v TEXT); INSERT INTO shadowing VALUES ('same', 'a'), ('same', 'b');");
    const rows = allRows(db, 'shadowing');
    assert.ok(rows[0].locator.kind === 'rowid');
    assert.notEqual(rows[0].locator.alias, 'rowid');
    assert.notDeepEqual(rows[0].locator, rows[1].locator);
    assert.deepEqual(cell(readRow(db, { table: 'shadowing', locator: rows[1].locator }), 'v'), text('b'));
  });
});

test('a table that shadows every rowid alias is still read whole, by position', () => {
  // Bug: a table without a usable identity is refused, so its rows become unreachable.
  withDb((db) => {
    db.exec(`CREATE TABLE no_identity (rowid TEXT, _rowid_ TEXT, oid TEXT);
      INSERT INTO no_identity VALUES ('a', 'a', 'a'), ('a', 'a', 'a'), ('b', 'b', 'b');`);
    const rows = allRows(db, 'no_identity', 2);
    assert.equal(rows.length, 3);
    const positions = rows.map((row) => (row.locator.kind === 'snapshot-position' ? row.locator.position : ''));
    assert.ok(positions.every((position) => position !== ''));
    assert.equal(new Set(positions).size, 3);
  });
});

test('a WITHOUT ROWID table and an INTEGER PRIMARY KEY named rowid locate by their key', () => {
  // Bug: `sources` declares a column called rowid, and the reader treats it as the hidden alias of a keyless table.
  withDb((db) => {
    db.exec(`CREATE TABLE strict_pairs (a TEXT, b TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID;
      INSERT INTO strict_pairs VALUES ('1', '2');`);
    const [strict] = allRows(db, 'strict_pairs');
    assert.equal(strict.locator.kind, 'primary');
    assert.deepEqual(readRow(db, { table: 'strict_pairs', locator: strict.locator }).values, strict.values);
    seed(db);
    const [source] = allRows(db, 'sources');
    assert.ok(source.locator.kind === 'primary');
    assert.deepEqual(
      source.locator.values.map((one) => one.column),
      ['rowid']
    );
    assert.deepEqual(cell(readRow(db, { table: 'sources', locator: source.locator }), 'id'), cell(source, 'id'));
  });
});

test('identifiers with quotes, spaces and semicolons are read through the catalog', () => {
  withDb((db) => {
    db.exec(
      `CREATE TABLE "odd ""name""; x" ("a col;" TEXT, "b""c" TEXT); INSERT INTO "odd ""name""; x" VALUES ('v1', 'v2');`
    );
    const name = 'odd "name"; x';
    assert.ok(catalog(db).tables.some((table) => table.name === name));
    const [row] = first(db, name, [{ column: 'a col;', value: text('v1') }]).items;
    assert.deepEqual(cell(row, 'b"c'), text('v2'));
  });
});

test('every row of every table is reached across pages exactly once', () => {
  // Bug: a page order that is not total, or a per-table reader that fails on FTS and its shadows.
  withDb((db) => {
    seed(db);
    assert.ok(countOf(db, 'sources_fts_data') > 0, 'the fixture filled the FTS shadows');
    assert.ok(countOf(db, 'node_access') > 0, 'the fixture filled the witnesses');
    for (const table of catalog(db).tables) {
      const rows = allRows(db, table.name, 3);
      assert.equal(rows.length, countOf(db, table.name), table.name);
      const locators = rows.map((row) => JSON.stringify(row.locator));
      assert.equal(new Set(locators).size, locators.length, `${table.name}: a locator repeats`);
    }
  });
});

test('a page reports what it left out', () => {
  // Bug: the owner reads a full-looking list with no sign of the rows past the limit.
  withDb((db) => {
    db.exec('CREATE TABLE five (id INTEGER PRIMARY KEY); INSERT INTO five VALUES (1), (2), (3), (4), (5);');
    const part = first(db, 'five', [], 2);
    assert.equal(part.items.length, 2);
    assert.equal(part.total, 5);
    assert.equal(part.truncated, true);
    assert.equal(part.reason, 'page');
    assert.equal(readRows(db, { table: 'five', filters: [], limit: 5, cursor: part.next }).items.length, 3);
    const whole = first(db, 'five', [], 5);
    assert.equal(whole.truncated, false);
    assert.equal(whole.reason, null);
    assert.equal(whole.next, null);
  });
});

test('an empty table is an empty complete page', () => {
  withDb((db) => {
    const page = first(db, 'leases', []);
    assert.deepEqual([page.items, page.total, page.next, page.truncated], [[], 0, null, false]);
  });
});

test('filters are typed equality, bound, and applied before the count and the page', () => {
  // Bug: the total counts the whole table, or the value is spliced into the SQL.
  withDb((db) => {
    db.exec(`CREATE TABLE tagged (id INTEGER PRIMARY KEY, tag TEXT, n);
      INSERT INTO tagged (id, tag, n) VALUES (1, 'a''b', 9007199254740992), (2, 'a''b', 9007199254740993), (3, 'c', NULL), (4, NULL, NULL);`);
    const ids = (page: InspectionPage): Array<InspectionValue> => page.items.map((row) => cell(row, 'id'));
    const tag = first(db, 'tagged', [{ column: 'tag', value: text("a'b") }], 1);
    assert.equal(tag.total, 2);
    assert.equal(tag.items.length, 1);
    assert.deepEqual(ids(first(db, 'tagged', [{ column: 'n', value: integer('9007199254740993') }])), [integer('2')]);
    assert.deepEqual(ids(first(db, 'tagged', [{ column: 'tag', value: { kind: 'null' } }])), [integer('4')]);
    const both = first(db, 'tagged', [
      { column: 'tag', value: text("a'b") },
      { column: 'n', value: integer('9007199254740992') },
    ]);
    assert.deepEqual(ids(both), [integer('1')]);
  });
});

for (const name of ['nope', 'claims; DROP TABLE claims', 'claims" --', '']) {
  test(`a table named ${JSON.stringify(name)} is refused and nothing else runs`, () => {
    // Bug: a name reaches the SQL before the catalog has seen it.
    withDb((db) => {
      const before = databaseDigest(db);
      assert.throws(() => first(db, name, []), { code: 'INSPECTION_UNKNOWN_TABLE' });
      assert.throws(() => readRow(db, { table: name, locator: { kind: 'rowid', alias: 'rowid', value: '1' } }), {
        code: 'INSPECTION_UNKNOWN_TABLE',
      });
      assert.deepEqual(databaseDigest(db), before);
    });
  });
}

test('a filter on a column the table lacks is refused', () => {
  withDb((db) => {
    for (const column of ['nope', 'id" OR 1=1 --'])
      assert.throws(() => first(db, 'claims', [{ column, value: text('x') }]), { code: 'INSPECTION_UNKNOWN_COLUMN' });
  });
});

for (const limit of [0, -1, 1.5, Number.NaN]) {
  test(`a page limit of ${limit} is refused`, () => {
    withDb((db) => {
      assert.throws(() => first(db, 'claims', [], limit), { code: 'INSPECTION_BAD_LIMIT' });
    });
  });
}

test('a cursor that is no cursor is refused rather than starting over', () => {
  // Bug: an unreadable cursor falls back to the first page, and a script reads the first page forever.
  withDb((db) => {
    assert.throws(() => readRows(db, { table: 'claims', filters: [], limit: 5, cursor: 'garbage' }), {
      code: 'INSPECTION_BAD_CURSOR',
    });
  });
});

// ---------- reading writes nothing ----------

test('catalog and row reads change no row of any table, node_access and turn_reads included', () => {
  // Bug: a read records evidence through the turn-read path or witnesses a node, so inspecting memory rewrites it.
  withDb((db) => {
    seed(db);
    assert.ok(countOf(db, 'node_access') > 0);
    assert.ok(countOf(db, 'turn_reads') > 0);
    const before = databaseDigest(db);
    const changes = Number(db.prepare('SELECT total_changes() AS n').get()?.n);
    for (const table of catalog(db).tables) {
      for (const row of allRows(db, table.name)) {
        if (row.locator.kind !== 'snapshot-position') readRow(db, { table: table.name, locator: row.locator });
      }
    }
    assert.equal(Number(db.prepare('SELECT total_changes() AS n').get()?.n), changes);
    assert.deepEqual(databaseDigest(db), before);
  });
});

test('both readers work over a read-only connection, so they need no write path', () => {
  // Bug: a TEMP table, a `CREATE INDEX IF NOT EXISTS` or a savepoint write makes the reader fail on the read connection.
  const file = join(tempDir('nep-inspect-'), 'memory.db');
  const writer = openMemoryDb(file);
  seed(dbOf(writer));
  writer.close();
  const reader = openMemoryDb(file, { readOnly: true });
  try {
    const db = dbOf(reader);
    const before = databaseDigest(db);
    const tables = catalog(db).tables;
    assert.deepEqual(new Set(tables.map((table) => table.name)), new Set(actualTableNames(db)));
    for (const table of tables) assert.equal(allRows(db, table.name).length, countOf(db, table.name), table.name);
    assert.deepEqual(databaseDigest(db), before);
  } finally {
    reader.close();
  }
});

test('a row keeps the column names and values a direct read gives', () => {
  // Bug: the row reader maps a domain shape over the table, renaming or dropping a stored column.
  withDb((db) => {
    seed(db);
    const direct = db.prepare("SELECT * FROM sources WHERE id = 'source:1'").get();
    const [row] = first(db, 'sources', [{ column: 'id', value: text('source:1') }]).items;
    assert.deepEqual(
      row.values.map((one) => one.column),
      Object.keys(direct ?? {})
    );
    assert.deepEqual(cell(row, 'text'), text(String(direct?.text)));
    assert.deepEqual(cell(row, 'audience_id'), text(String(direct?.audience_id)));
  });
});
