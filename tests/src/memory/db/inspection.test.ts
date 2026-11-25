// Tests for src/memory/db/inspection.ts: the owner's exhaustive storage catalog and row reader. The live connection
// defines what exists, so a table nobody registered is still listed and readable, and every row stays reachable:
// retired, internal, unowned, keyless and derived rows alike. Reading writes nothing, because read evidence
// (`node_access`, `turn_reads`) would otherwise be written by inspection. Contract:
//   catalog(db: Db): InspectionCatalog
//   readRows(db: Db, request: InspectionRead): InspectionPage
// `InspectionTable` carries `storageClass: 'domain' | 'operational' | 'derived' | 'metadata' | 'unclassified'`. A refusal
// throws an Error whose `code` is INSPECTION_UNKNOWN_TABLE, INSPECTION_UNKNOWN_COLUMN, INSPECTION_AMBIGUOUS_LOCATOR,
// INSPECTION_ROW_NOT_FOUND, INSPECTION_BAD_LIMIT or INSPECTION_BAD_CURSOR.
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boardVersion } from '../../../../src/board/schema.ts';
import { catalog, readRows } from '../../../../src/memory/db/inspection.ts';
import type {
  InspectionPage,
  InspectionRead,
  InspectionRow,
  InspectionCatalog,
  InspectionTable,
} from '../../../../src/memory/db/inspection.ts';
import type { InspectionValue } from '../../../../src/memory/db/inspection-values.ts';
import { openMemoryDb, schemaVersion } from '../../../../src/memory/db/open.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db } from '../../../../src/memory/db/types.ts';
import {
  actualTableNames,
  addAuthority,
  addEdge,
  addPlace,
  addSource,
  cell,
  countOf,
  databaseDigest,
} from '../../../fixtures/memory-db/browser-world.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { mkdirSync } from 'node:fs';
import { createConsole } from '../../../../src/interface/commands/console.ts';
import type { Answer } from '../../../../src/interface/commands/console.ts';
import { parseCommandWords, parseCommandLine } from '../../../../src/interface/commands/table.ts';
import { openTestMemory } from '../../../fixtures/memory-db/service.ts';
import type { TestMemory } from '../../../fixtures/memory-db/service.ts';
import { parseRequest } from '../../../../bin/neptunia-request.ts';
import {
  ALEX,
  KAI,
  MIRA,
  ROOM,
  addEntity,
  addSource as semanticAddSource,
  candidate,
  commit,
  sameAs,
  semanticWorld,
  successor,
  worksOn,
} from '../../../fixtures/memory-db/semantic-world.ts';
import type { World } from '../../../fixtures/memory-db/semantic-world.ts';

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
const isText = (typed: InspectionValue, wanted: string): boolean => typed.kind === 'text' && typed.value === wanted;

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
  // A new database always starts at the baseline, so the empty one is a bare node:sqlite connection, which has every
  // method Db names.
  const handle = new DatabaseSync(':memory:');
  try {
    const db = handle as unknown as Db;
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
    const [row] = first(db, 'ordered', []).items;
    assert.deepEqual(
      row.values.map((one) => one.column),
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
      const { locator } = row;
      assert.ok(locator.kind === 'primary');
      assert.deepEqual(
        locator.values.map((one) => one.column),
        ['b', 'a']
      );
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
  });
});

test('identical rows of a table with no key both come back, with rowids that open each', () => {
  // Bug: `SELECT DISTINCT` or a dedup on the row's values loses a duplicate of a `claim_sources`-shaped table.
  withDb((db) => {
    db.exec("CREATE TABLE twins (a TEXT, b TEXT); INSERT INTO twins VALUES ('same', 'same'), ('same', 'same');");
    const rows = allRows(db, 'twins');
    assert.equal(rows.length, 2);
    const [firstTwin, secondTwin] = rows;
    assert.equal(firstTwin.locator.kind, 'rowid');
    assert.notDeepEqual(firstTwin.locator, secondTwin.locator);
  });
});

test('a rowid locator uses an alias no column shadows', () => {
  // Bug: `SELECT rowid` reads the user's own `rowid` column, and two rows get the same locator.
  withDb((db) => {
    db.exec("CREATE TABLE shadowing (rowid TEXT, v TEXT); INSERT INTO shadowing VALUES ('same', 'a'), ('same', 'b');");
    const rows = allRows(db, 'shadowing');
    const [firstRow, secondRow] = rows;
    assert.ok(firstRow.locator.kind === 'rowid');
    assert.notEqual(firstRow.locator.alias, 'rowid');
    assert.notDeepEqual(firstRow.locator, secondRow.locator);
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
    seed(db);
    const [source] = allRows(db, 'sources');
    const { locator } = source;
    assert.ok(locator.kind === 'primary');
    assert.deepEqual(
      locator.values.map((one) => one.column),
      ['rowid']
    );
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
      allRows(db, table.name);
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

// ---------- a text that is not UTF-8 ----------

// A stored text that is not valid UTF-8 cannot be a JavaScript string without losing bytes, and an export must lose none. The
// cell keeps its readable `value` and names the exact stored bytes beside it. A valid text carries nothing extra, even one
// that holds the replacement character itself.
const UTF8_SEED = `CREATE TABLE raw (id INTEGER PRIMARY KEY, body TEXT);
  INSERT INTO raw VALUES (1, CAST(x'61FF62' AS TEXT)), (2, 'ζ�ζ');`;
const UTF8_EXACT = Buffer.from([0x61, 0xff, 0x62]).toString('base64');

function withUtf8Db(body: (db: Db) => void): void {
  const handle = openMemoryDb(':memory:');
  try {
    dbOf(handle).exec(UTF8_SEED);
    body(dbOf(handle));
  } finally {
    handle.close();
  }
}

const bodyOf = (row: { values: ReadonlyArray<{ column: string; exactBytes?: string }> }): string | undefined =>
  row.values.find((one) => one.column === 'body')?.exactBytes;

test('a page names the exact bytes of a text that is not UTF-8', () => {
  // Bug: the bad byte reads as a replacement character, and the owner takes that for what is stored.
  withUtf8Db((db) => {
    const [bad] = readRows(db, { table: 'raw', filters: [], limit: 5, cursor: null }).items;
    assert.equal(bodyOf(bad), UTF8_EXACT);
  });
});

test('a valid text holding the replacement character carries nothing extra', () => {
  withUtf8Db((db) => {
    const good = readRows(db, { table: 'raw', filters: [], limit: 5, cursor: null }).items[1];
    assert.equal(bodyOf(good), undefined);
  });
});

// ---------- a real that JSON has no number for ----------

// A REAL that JSON has no number for: SQLite stores infinities, and `JSON.stringify(Infinity)` writes null, so an export
// would turn the stored value into a missing one. The value carries the word that names it instead. `sqlValueOf` gives
// the number back, so the word also filters.

test('a stored infinity reads as its word and a filter by it finds the row', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    db.exec('CREATE TABLE edge (id INTEGER PRIMARY KEY, v REAL); INSERT INTO edge VALUES (1, 9e999), (2, -9e999);');
    const page = readRows(db, { table: 'edge', filters: [], limit: 5, cursor: null });
    assert.deepEqual(
      page.items.map((row) => cell(row, 'v')),
      [
        { kind: 'real', text: 'Infinity' },
        { kind: 'real', text: '-Infinity' },
      ]
    );
    const found = readRows(db, {
      table: 'edge',
      filters: [{ column: 'v', value: { kind: 'real', text: '-Infinity' } }],
      limit: 5,
      cursor: null,
    });
    assert.deepEqual(
      found.items.map((row) => cell(row, 'id')),
      [{ kind: 'integer', value: '2' }]
    );
  } finally {
    handle.close();
  }
});

const T0 = Date.parse('2026-11-05T12:00:00.000Z');
const BOUNDS = { pageRows: 25, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 8 };
const BIG = 'ζ'.repeat(3 * 1024 * 1024);

type Rig = {
  memory: TestMemory;
  db: Db;
  ops: Array<string>;
  clock: { at: number };
  dir: string;
  /** One command as argv words, so a JSON word keeps its quotes and spaces. */
  say(...words: Array<string>): Promise<Answer>;
};

const rigs: Array<TestMemory> = [];

function inspectSeed(db: Db): void {
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
    id: 'source:gone',
    place: 'place:room',
    iface: 'zeta',
    audience: 'aud:group:zeta',
    text: 'retired',
    retiredAt: '2026-11-02T00:00:00.000Z',
  });
  addEdge(db, { src: 'source:source:1', dst: 'place:place:room', predicate: 'located_in', audience: 'aud:group:zeta' });
  db.prepare(
    `INSERT INTO source_relations (id, source_id, predicate, target_key, recorded_at)
     VALUES (1, 'source:1', 'references', 'unresolved-native-key', '2026-11-01T00:00:00.000Z')`
  ).run();
  db.prepare(
    `INSERT INTO claims (id, subject_kind, subject_id, kind, text, truth, shown, audience_id, scope_kind, retired_at, created_at)
     VALUES ('claim:retired', 'place', 'place:room', 'detail', 'retired claim', 'current', 1, 'aud:internal', 'internal', '2026-11-03T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`
  ).run();
  db.exec('CREATE TABLE zz_big (id INTEGER PRIMARY KEY, body TEXT)');
  db.prepare('INSERT INTO zz_big VALUES (1, ?)').run(BIG);
}

/** The real service, on the calling thread, with its bounds in the live config; its own connection seeds the rows. */
async function rig(): Promise<Rig> {
  const clock = { at: T0 };
  const dir = tempDir('nep-commands-inspect-');
  mkdirSync(join(dir, 'config'), { recursive: true });
  const memory = await openTestMemory({
    config: { memoryDb: { inspection: BOUNDS } },
    now: () => clock.at,
  });
  rigs.push(memory);
  const handle = memory.memoryDb.database();
  assert.ok(handle);
  inspectSeed(writable(memory));
  const ops: Array<string> = [];
  const desk = createConsole({
    runOp: (op) => {
      ops.push(op);
      return Promise.resolve({ status: 'failed', code: 'NOT_FOR_AN_INSPECTION', summary: '', data: null });
    },
    ownerReads: { lessons: () => '' },
    places: () => [],
    selfId: () => null,
    hot: memory.hot,
    privateDir: dir,
    dataDir: memory.dataDir,
    memoryDb: memory.memoryDb,
    usage: null,
    metrics: { samples: () => [] },
    chatLines: () => [],
    now: () => clock.at,
  });
  return {
    memory,
    db: handle,
    ops,
    clock,
    dir,
    say: async (...words) => {
      const parsed = parseCommandWords(words);
      assert.ok(parsed.ok, parsed.ok ? '' : `${words.join(' ')}: ${parsed.reason}`);
      const real = globalThis.fetch;
      globalThis.fetch = () => Promise.reject(new Error('an inspection reached the network'));
      try {
        return await desk.run(parsed.name, parsed.args, { id: 'owner' });
      } finally {
        globalThis.fetch = real;
      }
    },
  };
}

/** The service opens its database with the writer on this thread (`worker: false`), so its handle takes the seed's writes. */
function writable(memory: TestMemory): Db {
  const handle = memory.memoryDb.readHandle();
  assert.ok(handle);
  return dbOf(handle);
}

function data<TData>(answer: Answer): TData {
  assert.equal(answer.status, 'ok', answer.text.slice(0, 300));
  return JSON.parse(answer.text) as TData;
}

type TablesAnswer = { snapshot: string; catalog: InspectionCatalog };
type SchemaAnswer = { snapshot: string; table: InspectionTable };
type RowAnswer = { snapshot: string; row: InspectionRow };

async function everyRow(
  one: Rig,
  table: string,
  limit = '7'
): Promise<{ rows: Array<InspectionRow>; snapshot: string }> {
  const rows: Array<InspectionRow> = [];
  let page = data<InspectionPage>(await one.say('memory', 'inspect', 'rows', table, '--limit', limit));
  rows.push(...page.items);
  const snapshot = page.snapshot;
  while (page.next !== null) {
    page = data<InspectionPage>(
      await one.say('memory', 'inspect', 'rows', table, '--snapshot', snapshot, '--limit', limit, '--cursor', page.next)
    );
    rows.push(...page.items);
  }
  await one.say('memory', 'inspect', 'close', snapshot);
  return { rows, snapshot };
}

describe('commands memory inspect', () => {
  after(async () => {
    for (const memory of rigs) await memory.close();
  });

  // ---------- completeness ----------

  test('/memory inspect tables lists exactly the tables of the database', async () => {
    // Bug: the owner's menu is the domain list, so a table no menu names cannot be found.
    const one = await rig();
    const { catalog } = data<TablesAnswer>(await one.say('memory', 'inspect', 'tables'));
    assert.deepEqual(new Set(catalog.tables.map((table) => table.name)), new Set(actualTableNames(one.db)));
  });

  test('a table added later appears, reads whole, and is reported as unclassified', async () => {
    // Bug: a future table needs a registry entry before the owner can see it, or it is silently classed as something.
    const one = await rig();
    writable(one.memory).exec(
      "CREATE TABLE future_family (id TEXT PRIMARY KEY, body TEXT); INSERT INTO future_family VALUES ('f1', 'ζωή');"
    );
    const { catalog } = data<TablesAnswer>(await one.say('memory', 'inspect', 'tables'));
    assert.equal(catalog.tables.find((table) => table.name === 'future_family')?.storageClass, 'unclassified');
    const { rows } = await everyRow(one, 'future_family');
    assert.deepEqual(cell(rows[0], 'body'), { kind: 'text', value: 'ζωή' });
  });

  test('every row of every table is read through the command, and the counts reconcile', async () => {
    // Bug: the command reads some tables through a domain view, so FTS shadows, the board and metadata fail or come up short.
    const one = await rig();
    const { catalog } = data<TablesAnswer>(await one.say('memory', 'inspect', 'tables'));
    assert.ok(countOf(one.db, 'node_access') > 0 && countOf(one.db, 'sources_fts_data') > 0);
    for (const table of catalog.tables) {
      if (table.name === 'zz_big') continue;
      const { rows } = await everyRow(one, table.name);
      assert.equal(rows.length, countOf(one.db, table.name), table.name);
    }
  });

  test('a relation the graph does not project stays readable through inspection', async () => {
    // Bug: an unresolved `references` row has no graph edge and no menu, so it is simply unreachable.
    const one = await rig();
    const page = data<InspectionPage>(
      await one.say(
        'memory',
        'inspect',
        'rows',
        'source_relations',
        '--filters',
        JSON.stringify([{ column: 'predicate', value: { kind: 'text', value: 'references' } }])
      )
    );
    assert.deepEqual(cell(page.items[0], 'target_key'), { kind: 'text', value: 'unresolved-native-key' });
    assert.equal(page.total, 1);
  });

  test('/memory inspect schema answers the catalog entry of one table', async () => {
    const one = await rig();
    const { table } = data<SchemaAnswer>(await one.say('memory', 'inspect', 'schema', 'node_access'));
    assert.deepEqual(
      table.columns.map((column) => column.name),
      ['node_id', 'audience_id', 'evidence_id']
    );
    assert.ok(table.storageClass === 'derived');
  });

  test('/memory inspect row opens a row by the locator its page gave', async () => {
    const one = await rig();
    const { rows } = await everyRow(one, 'claims');
    const opened = data<RowAnswer>(
      await one.say('memory', 'inspect', 'row', 'claims', JSON.stringify(rows[0].locator))
    );
    assert.deepEqual(opened.row, rows[0]);
  });

  for (const [label, words, code] of [
    ['an unknown table', ['memory', 'inspect', 'rows', 'nope'], 'INSPECTION_UNKNOWN_TABLE'],
    ['an injected table', ['memory', 'inspect', 'rows', 'claims; DROP TABLE claims'], 'INSPECTION_UNKNOWN_TABLE'],
    [
      'an unknown column in a filter',
      ['memory', 'inspect', 'rows', 'claims', '--filters', '[{"column":"nope","value":{"kind":"null"}}]'],
      'INSPECTION_UNKNOWN_COLUMN',
    ],
    [
      'a filter list that is no JSON',
      ['memory', 'inspect', 'rows', 'claims', '--filters', 'nope'],
      'INSPECTION_BAD_FILTER',
    ],
    [
      'a filter value of no known kind',
      ['memory', 'inspect', 'rows', 'claims', '--filters', '[{"column":"id","value":{"kind":"date"}}]'],
      'INSPECTION_BAD_FILTER',
    ],
    ['a locator that is no JSON', ['memory', 'inspect', 'row', 'claims', 'nope'], 'INSPECTION_BAD_LOCATOR'],
    ['a bad cursor', ['memory', 'inspect', 'rows', 'claims', '--cursor', 'garbage'], 'INSPECTION_BAD_CURSOR'],
    ['a limit that is no number', ['memory', 'inspect', 'rows', 'claims', '--limit', 'many'], 'INSPECTION_BAD_LIMIT'],
  ] as const) {
    test(`/memory inspect refuses ${label} with ${code}, with no partial answer`, async () => {
      // Bug: a bad word becomes an empty table, which reads as a fact about the persona's memory.
      const one = await rig();
      const before = databaseDigest(one.db);
      const answer = await one.say(...words);
      assert.equal(answer.status, 'invalid');
      assert.equal(answer.code, code);
      assert.deepEqual(databaseDigest(one.db), before);
    });
  }

  test('a catalog row count and a direct count agree through a quoted name', async () => {
    const one = await rig();
    writable(one.memory).exec(`CREATE TABLE "odd ""name""" (id TEXT); INSERT INTO "odd ""name""" VALUES ('x');`);
    const { rows } = await everyRow(one, 'odd "name"');
    assert.equal(rows.length, countOf(one.db, 'odd "name"'));
  });
});

type Version = { claimId: string; versionId: string };
const written = (result: object): Version => result as Version;

/** What the seed wrote, by name, and the contexts the core would issue for the group and the two DMs. */
type Seeded = {
  open: string;
  secret: string;
  edited: string;
  lumen: string;
  orbis: string;
  hidden: string;
  lumenName: Version;
  hiddenName: Version;
  moth: Version;
  works1: Version;
  works2: Version;
  kai: Version;
  mira: Version;
  event: Version;
  dmMeeting: Version;
  hiddenWork: Version;
  kite: string;
  kyte: string;
  contexts: World['contexts'];
};

type SemanticRig = {
  memory: TestMemory;
  db: Db;
  ops: Array<string>;
  dir: string;
  seeded: Seeded;
  /** One command as argv words, as `neptunia memory ...` hands them over. */
  say(...words: Array<string>): Promise<Answer>;
  /** One command as the chat's line. */
  line(semanticText: string): Promise<Answer>;
  run(command: { name: string; args: Record<string, unknown> }): Promise<Answer>;
};

const label = (entityId: string, role: 'alias', semanticText: string, sources: Array<string>) =>
  candidate(
    'entity.label',
    'label',
    [
      { role: 'entity', position: 0, ref: { kind: 'entity', id: entityId } },
      { role, position: 0, literal: semanticText },
      { role: 'language', position: 0, literal: 'en' },
    ],
    sources
  );

/**
 * A public project, a public event and a project only Alex's DM knows; a DM alias; a relation changed from positive to
 * negative; a public and a private inference resting on its first version; an event with four roles held in the room; a
 * DM meeting in the room; two public concepts declared the same; and an edited revision of the public line the facts cite.
 */
function semanticSeed(world: World): Seeded {
  const open = semanticAddSource(world, 'public', 'Alex works on Lumen; Orbis met in the room with Mira speaking');
  const secret = semanticAddSource(world, 'alex', 'Mira helps on Lumen; Hidden is mine');
  const lumen = addEntity(world, 'project', 'Lumen', [open]);
  const orbis = addEntity(world, 'event', 'Orbis', [open]);
  const hidden = addEntity(world, 'project', 'Hidden', [secret], world.contexts.alex);
  const moth = written(commit(world, label(lumen.entityId, 'alias', 'Moth', [secret]), world.contexts.alex));
  const works1 = written(commit(world, worksOn(ALEX, lumen.entityId, [open])));
  const inferred = { how: 'inferred', dependencies: [{ versionId: works1.versionId, role: 'supports' as const }] };
  const kai = written(commit(world, worksOn(KAI, lumen.entityId, [open], inferred)));
  const mira = written(commit(world, worksOn(MIRA, lumen.entityId, [secret], inferred), world.contexts.alex));
  const event = written(
    commit(
      world,
      candidate(
        'event.occurrence',
        'nary',
        [
          { role: 'event', position: 0, ref: { kind: 'entity', id: orbis.entityId } },
          { role: 'organizer', position: 0, ref: { kind: 'person', id: ALEX } },
          { role: 'speaker', position: 0, ref: { kind: 'person', id: MIRA } },
          { role: 'project', position: 0, ref: { kind: 'entity', id: lumen.entityId } },
          { role: 'location', position: 0, ref: { kind: 'place', id: ROOM } },
        ],
        [open]
      )
    )
  );
  const dmMeeting = written(
    commit(
      world,
      candidate(
        'event.occurrence',
        'nary',
        [
          { role: 'event', position: 0, ref: { kind: 'entity', id: hidden.entityId } },
          { role: 'attendee', position: 0, ref: { kind: 'person', id: ALEX } },
          { role: 'location', position: 0, ref: { kind: 'place', id: ROOM } },
        ],
        [secret]
      ),
      world.contexts.alex
    )
  );
  const hiddenWork = written(commit(world, worksOn(ALEX, hidden.entityId, [secret]), world.contexts.alex));
  const works2 = written(
    commit(world, worksOn(ALEX, lumen.entityId, [open], successor(works1, { polarity: 'negative' })))
  );
  const kite = addEntity(world, 'concept', 'Kite', [open]).entityId;
  const kyte = addEntity(world, 'concept', 'Kyte', [open]).entityId;
  commit(world, sameAs(kyte, kite, [open]));
  const edited = 'src:edited';
  world.db
    .prepare(
      `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_account, author_kind, occurred_at,
         recorded_at, text, scope_kind, scope_iface, scope_dm, audience_id)
       SELECT ?, kind, iface, native_id, 2, place_id, author_account, author_kind, occurred_at, recorded_at, 'edited later',
         scope_kind, scope_iface, scope_dm, audience_id FROM sources WHERE id = ?`
    )
    .run(edited, open);
  return {
    open,
    secret,
    edited,
    lumen: lumen.entityId,
    orbis: orbis.entityId,
    hidden: hidden.entityId,
    lumenName: lumen,
    hiddenName: hidden,
    moth,
    works1,
    works2,
    kai,
    mira,
    event,
    dmMeeting,
    hiddenWork,
    kite,
    kyte,
    contexts: world.contexts,
  };
}

/** The seed through the writer on a file, then the real service over that file with the console on it. */
async function semanticRig(): Promise<SemanticRig> {
  const world = semanticWorld();
  const seeded = semanticSeed(world);
  world.handle.close();
  const dir = dirname(world.file);
  mkdirSync(join(dir, 'config'), { recursive: true });
  const memory = await openTestMemory({ dataDir: dir, config: { memoryDb: { inspection: BOUNDS } } });
  rigs.push(memory);
  const db = memory.memoryDb.database();
  assert.ok(db);
  const ops: Array<string> = [];
  const desk = createConsole({
    runOp: (op) => {
      ops.push(op);
      return Promise.resolve({ status: 'failed', code: 'NOT_FOR_A_BROWSER_READ', summary: '', data: null });
    },
    ownerReads: { lessons: () => '' },
    places: () => [],
    selfId: () => null,
    hot: memory.hot,
    privateDir: dir,
    dataDir: memory.dataDir,
    memoryDb: memory.memoryDb,
    usage: null,
    metrics: { samples: () => [] },
    chatLines: () => [],
    now: () => Date.UTC(2026, 10, 5, 12),
  });
  const run = async (command: { name: string; args: Record<string, unknown> }): Promise<Answer> => {
    const real = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error('a memory read reached the network'));
    try {
      return await desk.run(command.name, command.args, { id: 'owner' });
    } finally {
      globalThis.fetch = real;
    }
  };
  return {
    memory,
    db,
    ops,
    dir,
    seeded,
    run,
    say: (...words) => {
      const parsed = parseRequest(words).parsed;
      assert.ok(parsed.ok, parsed.ok ? '' : `${words.join(' ')}: ${parsed.reason}`);
      return run(parsed);
    },
    line: (semanticText) => {
      const parsed = parseCommandLine(semanticText);
      assert.ok(parsed.ok, parsed.ok ? '' : `${semanticText}: ${parsed.reason}`);
      return run(parsed);
    },
  };
}
const semanticText = (value: string) => ({ kind: 'text', value });

// ---- /memory inspect over semantic tables ----------------------------------------------------------------------------

const SEMANTIC_CLASSES: Readonly<Record<string, string>> = {
  semantic_arguments: 'domain',
  semantic_assertion_versions: 'domain',
  semantic_dependencies: 'domain',
  semantic_entities: 'domain',
  semantic_entity_kinds: 'domain',
  semantic_predicate_versions: 'domain',
  semantic_entity_merges: 'derived',
  semantic_labels: 'derived',
  semantic_search_documents: 'derived',
  semantic_search_fts: 'derived',
  semantic_search_fts_config: 'derived',
  semantic_search_fts_data: 'derived',
  semantic_search_fts_docsize: 'derived',
  semantic_search_fts_idx: 'derived',
};

async function semanticEveryRow(one: SemanticRig, table: string, filters: unknown = []): Promise<Array<InspectionRow>> {
  const rows: Array<InspectionRow> = [];
  const filter = JSON.stringify(filters);
  let page = data<InspectionPage>(
    await one.say('memory', 'inspect', 'rows', table, '--limit', '7', '--filters', filter)
  );
  rows.push(...page.items);
  const snapshot = page.snapshot;
  while (page.next !== null) {
    page = data<InspectionPage>(
      await one.say(
        'memory',
        'inspect',
        'rows',
        table,
        '--snapshot',
        snapshot,
        '--limit',
        '7',
        '--filters',
        filter,
        '--cursor',
        page.next
      )
    );
    rows.push(...page.items);
  }
  await one.say('memory', 'inspect', 'close', snapshot);
  return rows;
}
const byVersion = (versionId: string) => [{ column: 'version_id', value: semanticText(versionId) }];

describe('commands memory semantic', () => {
  after(async () => {
    for (const memory of rigs) await memory.close();
  });

  test('the catalog lists every semantic table and FTS shadow, each in its class', async () => {
    // Bug: a semantic table or a shadow of its index is missing or unclassified, so the owner cannot tell fact from cache.
    const one = await semanticRig();
    const { catalog } = data<{ catalog: InspectionCatalog }>(await one.say('memory', 'inspect', 'tables'));
    const classes = Object.fromEntries(
      catalog.tables
        .filter((table) => table.name.startsWith('semantic_'))
        .map((table) => [table.name, table.storageClass])
    );
    assert.deepEqual(classes, SEMANTIC_CLASSES);
  });

  test('every row of every semantic table is read through the command, and the counts reconcile', async () => {
    const one = await semanticRig();
    for (const table of Object.keys(SEMANTIC_CLASSES)) {
      assert.ok(countOf(one.db, table) > 0, `the seed left ${table} empty`);
      assert.equal((await semanticEveryRow(one, table)).length, countOf(one.db, table), table);
    }
  });

  test('inspection shows the roles, premises, epistemic metadata and source refs of a version as stored', async () => {
    const one = await semanticRig();
    const { event, kai, works1, works2, open } = one.seeded;
    const roles = (await semanticEveryRow(one, 'semantic_arguments', byVersion(event.versionId)))
      .map((row) => cell(row, 'role'))
      .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    assert.deepEqual(roles, ['event', 'location', 'organizer', 'project', 'speaker'].map(semanticText));
    const premises = await semanticEveryRow(one, 'semantic_dependencies', byVersion(kai.versionId));
    assert.deepEqual(
      premises.map((row) => [cell(row, 'premise_version_id'), cell(row, 'role')]),
      [[semanticText(works1.versionId), semanticText('supports')]]
    );
    const [epistemic] = await semanticEveryRow(one, 'semantic_assertion_versions', byVersion(works2.versionId));
    assert.ok(epistemic);
    assert.deepEqual(
      ['polarity', 'truth_state', 'how'].map((column) => cell(epistemic, column)),
      [semanticText('negative'), semanticText('current'), semanticText('said')]
    );
    assert.deepEqual(cell(epistemic, 'historical_metadata_complete'), { kind: 'integer', value: '1' });
    const evidence = await semanticEveryRow(one, 'claim_version_sources', byVersion(works1.versionId));
    assert.deepEqual(
      evidence.map((row) => [cell(row, 'source_id'), cell(row, 'role')]),
      [[semanticText(open), semanticText('supports')]]
    );
  });
});
