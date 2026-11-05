// The stored shape of semantic memory, stage S2: the tables and guards the append migration adds to the integrated
// schema, on real temporary databases and with the SQL any writer would send. A version is sealed by inserting its
// immutable row last, so these tests hold the guards themselves; the writer's own validation is in
// memory-db-semantic-write.test.ts. The fixture's kind and predicate are made up here on purpose, so the registry's
// shipped list is not what makes these pass. Synthetic content only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MIGRATIONS, openMemoryDb, schemaVersion } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle } from '../src/memory/db/types.ts';
import { tempDir } from './fixtures/tmp.ts';

/** The migrations of the integrated schema this workstream appends to. Shipped entries never change. */
type Row = Record<string, unknown>;

const INTEGRATED = MIGRATIONS.slice(0, 29);
const AT = '2026-11-05T10:00:00.000Z';
const PUBLIC = 'aud:group:discord';
const SEMANTIC_TABLES = [
  'semantic_entity_kinds',
  'semantic_predicate_versions',
  'semantic_entities',
  'semantic_assertion_versions',
  'semantic_arguments',
  'semantic_dependencies',
  'semantic_labels',
  'semantic_entity_merges',
  'semantic_search_documents',
  'semantic_search_fts',
];

function memory(): { handle: MemoryHandle; db: Db } {
  const handle = openMemoryDb(':memory:');
  const db = dbOf(handle);
  seedBase(db);
  seedRegistry(db);
  return { handle, db };
}

function seedBase(db: Db): void {
  db.exec(`INSERT OR IGNORE INTO audiences (id, kind, iface) VALUES ('${PUBLIC}', 'group', 'discord');
    INSERT INTO people (id, first_seen_at) VALUES ('person:alex', '${AT}');
    INSERT INTO places (id, iface, kind, scope_kind, name) VALUES ('place:room', 'discord', 'channel', 'group', 'Café room');
    INSERT INTO sources (id, kind, iface, native_id, revision, place_id, occurred_at, recorded_at, text, scope_kind, scope_iface, audience_id)
      VALUES ('src:1', 'seen', 'discord', 'm1', 1, 'place:room', '${AT}', '${AT}', 'Ω the words  ', 'group', 'discord', '${PUBLIC}');
    INSERT INTO sources (id, kind, iface, native_id, revision, place_id, occurred_at, recorded_at, text, scope_kind, scope_iface, audience_id)
      VALUES ('src:2', 'seen', 'discord', 'm2', 1, 'place:room', '${AT}', '${AT}', 'other words', 'group', 'discord', '${PUBLIC}');
    INSERT INTO claims (id, subject_kind, subject_id, kind, text, truth, shown, scope_kind, scope_iface, audience_id, created_at)
      VALUES ('clm:1', 'person', 'person:alex', 'detail', 'plain prose', 'current', 1, 'group', 'discord', '${PUBLIC}', '${AT}');
    INSERT INTO claims (id, subject_kind, subject_id, kind, text, truth, shown, scope_kind, scope_iface, audience_id, created_at)
      VALUES ('clm:2', 'person', 'person:alex', 'detail', 'more prose', 'current', 1, 'group', 'discord', '${PUBLIC}', '${AT}');`);
  for (const id of ['cv:1', 'cv:2', 'cv:3']) {
    db.prepare(
      `INSERT INTO claim_versions (id, claim_id, revision_id, text, recorded_at, event, by, origin)
       VALUES (?, 'clm:1', ?, 'plain prose', ?, 'add', 'her', 'session')`
    ).run(id, `rv:${id}`, AT);
  }
  db.prepare(
    "INSERT INTO claim_version_sources (version_id, source_id, role) VALUES ('cv:1', 'src:1', 'supports')"
  ).run();
}

function seedRegistry(db: Db): void {
  const definition = JSON.stringify({ roles: [{ role: 'left', min: 1, max: 1, refs: ['entity'], literals: [] }] });
  db.prepare('INSERT INTO semantic_entity_kinds (id, version, definition_json, created_at) VALUES (?, 1, ?, ?)').run(
    'fixture.kind',
    '{"fields":[]}',
    AT
  );
  db.prepare(
    'INSERT INTO semantic_predicate_versions (id, version, definition_json, created_at) VALUES (?, 1, ?, ?)'
  ).run('fixture.relation', definition, AT);
  db.prepare(
    "INSERT INTO semantic_entities (id, kind, kind_version, created_at) VALUES ('ent:1', 'fixture.kind', 1, ?)"
  ).run(AT);
}

const SEAL_SQL = `INSERT INTO semantic_assertion_versions (version_id, format_version, assertion_kind, predicate_id, predicate_version,
  truth_state, how, polarity, valid_from_at, valid_to_at, recorded_at, audience_id, historical_metadata_complete)
  VALUES (?, 1, 'relation', 'fixture.relation', 1, 'current', 'said', 'positive', NULL, NULL, ?, ?, 1)`;
const ARGUMENT_SQL =
  "INSERT INTO semantic_arguments (version_id, role, position, ref_kind, ref_id, literal_json) VALUES (?, ?, 0, 'entity', 'ent:1', NULL)";
const DEPENDENCY_SQL =
  "INSERT INTO semantic_dependencies (version_id, premise_version_id, role) VALUES (?, ?, 'supports')";

/** One whole sealed payload, in the writer's order: arguments and premise first, the immutable row last. */
function seal(handle: MemoryHandle, versionId = 'cv:1'): void {
  const db = dbOf(handle);
  handle.transaction(() => {
    db.prepare(ARGUMENT_SQL).run(versionId, 'left');
    db.prepare(DEPENDENCY_SQL).run(versionId, 'cv:3');
    db.prepare(SEAL_SQL).run(versionId, AT, PUBLIC);
  });
}

const refused = (db: Db, sql: string, ...params: Array<unknown>): void => {
  assert.throws(
    () => db.prepare(sql).run(...params),
    /sealed|immutable|retained|replaced|constraint|FOREIGN KEY|CHECK/i
  );
};

const contentOf = (db: Db, tables: ReadonlyArray<string>): Record<string, string> =>
  Object.fromEntries(
    tables.map((table) => [table, JSON.stringify(db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all())])
  );
const ownTables = (db: Db): Array<string> =>
  db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'
        AND name NOT LIKE '%_tri%' AND name NOT LIKE 'semantic_%' AND name NOT IN ('meta', 'schema_version')
        AND sql NOT LIKE '%WITHOUT ROWID%'`
    )
    .all()
    .map((row) => String(row.name));
const definitions = (db: Db): Map<string, string> =>
  new Map(
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'semantic_%'")
      .all()
      .map((row): [string, string] => [String(row.name), String(row.sql)])
  );

// ---- the append migration --------------------------------------------------------------------------------------------

test('an integrated database opens at the new version with every old row byte for byte and every old object as it was', () => {
  // Bug: the migration rewrites a shipped table, drops a publication guard or touches stored text.
  const file = path.join(tempDir('nep-semantic-schema-'), 'memory.db');
  const old = openMemoryDb(file, { migrations: INTEGRATED });
  seedBase(dbOf(old));
  const tables = ownTables(dbOf(old));
  const before = contentOf(dbOf(old), tables);
  const objects = definitions(dbOf(old));
  old.close();

  const upgraded = openMemoryDb(file);
  try {
    const db = dbOf(upgraded);
    assert.equal(schemaVersion(db), MIGRATIONS.length);
    assert.ok(MIGRATIONS.length > INTEGRATED.length);
    // Stage M rewrites `media` and takes `media` off `sources`, on purpose; every other shipped table stays byte for byte.
    const asOfOld = (text: Record<string, string>) => {
      const rest = { ...text };
      delete rest.media;
      const lines = (JSON.parse(text.sources) as Array<Row>).map((row) => {
        const line = { ...row };
        delete line.media;
        return line;
      });
      return { ...rest, sources: JSON.stringify(lines) };
    };
    assert.deepEqual(asOfOld(contentOf(db, tables)), asOfOld(before));
    const after = definitions(db);
    for (const [name, sql] of objects) {
      if (name === 'media' || name === 'sources') continue;
      assert.equal(after.get(name), sql, `${name} changed its definition`);
    }
    const names = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'semantic_%'").all();
    for (const table of SEMANTIC_TABLES)
      assert.ok(
        names.some((row) => row.name === table),
        `${table} is missing`
      );
  } finally {
    upgraded.close();
  }
});

test('a second open of a sealed database runs no conversion and changes no semantic row', () => {
  // Bug: the semantic step or a registry seed runs again on each start and duplicates or rewrites rows.
  const file = path.join(tempDir('nep-semantic-schema-'), 'memory.db');
  const first = openMemoryDb(file);
  seedBase(dbOf(first));
  seedRegistry(dbOf(first));
  seal(first);
  const before = contentOf(
    dbOf(first),
    SEMANTIC_TABLES.filter((table) => table !== 'semantic_search_fts')
  );
  const rows = dbOf(first).prepare('SELECT COUNT(*) AS n FROM schema_version').get()?.n;
  first.close();

  const second = openMemoryDb(file);
  try {
    const db = dbOf(second);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_version').get()?.n, rows);
    assert.deepEqual(
      contentOf(
        db,
        SEMANTIC_TABLES.filter((table) => table !== 'semantic_search_fts')
      ),
      before
    );
  } finally {
    second.close();
  }
});

test('a read-only connection reads the sealed payload and cannot write it', () => {
  // Bug: a reader that needs a write connection breaks the one-writer rule.
  const file = path.join(tempDir('nep-semantic-schema-'), 'memory.db');
  const writer = openMemoryDb(file);
  seedBase(dbOf(writer));
  seedRegistry(dbOf(writer));
  seal(writer);
  const reader = openMemoryDb(file, { readOnly: true });
  try {
    const db = dbOf(reader);
    assert.equal(
      db.prepare("SELECT polarity FROM semantic_assertion_versions WHERE version_id = 'cv:1'").get()?.polarity,
      'positive'
    );
    assert.throws(() => db.prepare("DELETE FROM semantic_labels WHERE version_id = 'cv:1'").run(), /readonly/i);
  } finally {
    reader.close();
    writer.close();
  }
});

// ---- sealing ---------------------------------------------------------------------------------------------------------

test('recursive triggers stay off on the connection the guards are proved on', () => {
  // Bug: a replacement guard that only works with recursive triggers on protects nothing in production.
  const { handle, db } = memory();
  assert.equal(db.prepare('PRAGMA recursive_triggers').get()?.recursive_triggers, 0);
  handle.close();
});

test('arguments without the sealing row fail at commit and leave nothing behind', () => {
  // Bug: a crash between the argument and the seal leaves a payload no reader can trust.
  const { handle, db } = memory();
  assert.throws(() => handle.transaction(() => db.prepare(ARGUMENT_SQL).run('cv:1', 'left')), /FOREIGN KEY/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM semantic_arguments').get()?.n, 0);
  handle.close();
});

test('a premise without the sealing row fails at commit and leaves nothing behind', () => {
  // Bug: a dependency row survives for a version that was never written.
  const { handle, db } = memory();
  assert.throws(() => handle.transaction(() => db.prepare(DEPENDENCY_SQL).run('cv:1', 'cv:3')), /FOREIGN KEY/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM semantic_dependencies').get()?.n, 0);
  handle.close();
});

test('a whole payload written in seal order commits, with a clean integrity and foreign key check', () => {
  // Bug: the triggers refuse the writer's own order, so no structured fact can ever be stored.
  const { handle, db } = memory();
  seal(handle);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM semantic_arguments').get()?.n, 1);
  assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  handle.close();
});

const SEALED_MUTATIONS: ReadonlyArray<[string, string, Array<unknown>]> = [
  ['an assertion update', "UPDATE semantic_assertion_versions SET polarity = 'negative' WHERE version_id = 'cv:1'", []],
  ['an assertion delete', "DELETE FROM semantic_assertion_versions WHERE version_id = 'cv:1'", []],
  ['an assertion replacement', SEAL_SQL.replace('INSERT INTO', 'INSERT OR REPLACE INTO'), ['cv:1', AT, PUBLIC]],
  ['an argument update', "UPDATE semantic_arguments SET ref_id = 'ent:2' WHERE version_id = 'cv:1'", []],
  ['an argument delete', "DELETE FROM semantic_arguments WHERE version_id = 'cv:1'", []],
  ['an argument replacement', ARGUMENT_SQL.replace('INSERT INTO', 'INSERT OR REPLACE INTO'), ['cv:1', 'left']],
  ['a late argument', ARGUMENT_SQL, ['cv:1', 'right']],
  ['a premise update', "UPDATE semantic_dependencies SET role = 'conflicts' WHERE version_id = 'cv:1'", []],
  ['a premise delete', "DELETE FROM semantic_dependencies WHERE version_id = 'cv:1'", []],
  ['a premise replacement', DEPENDENCY_SQL.replace('INSERT INTO', 'INSERT OR REPLACE INTO'), ['cv:1', 'cv:3']],
  ['a late premise', DEPENDENCY_SQL, ['cv:1', 'cv:2']],
  ['a claim text update', "UPDATE claim_versions SET text = 'rewritten' WHERE id = 'cv:1'", []],
  ['a claim version delete', "DELETE FROM claim_versions WHERE id = 'cv:1'", []],
  [
    'a claim version replacement',
    `INSERT OR REPLACE INTO claim_versions (id, claim_id, text, recorded_at) VALUES ('cv:1', 'clm:1', 'rewritten', '${AT}')`,
    [],
  ],
  ['an evidence update', "UPDATE claim_version_sources SET role = 'conflicts' WHERE version_id = 'cv:1'", []],
  ['an evidence delete', "DELETE FROM claim_version_sources WHERE version_id = 'cv:1'", []],
  [
    'an evidence replacement',
    "INSERT OR REPLACE INTO claim_version_sources (version_id, source_id, role) VALUES ('cv:1', 'src:1', 'conflicts')",
    [],
  ],
  [
    'late evidence',
    "INSERT INTO claim_version_sources (version_id, source_id, role) VALUES ('cv:1', 'src:2', 'supports')",
    [],
  ],
];

for (const [name, sql, params] of SEALED_MUTATIONS) {
  test(`refuses ${name} once a version is sealed`, () => {
    // Bug: a unit flush, a legacy upsert or a repair revises an old interpretation in place.
    const { handle, db } = memory();
    seal(handle);
    const before = contentOf(db, [
      'semantic_assertion_versions',
      'semantic_arguments',
      'semantic_dependencies',
      'claim_versions',
      'claim_version_sources',
    ]);
    refused(db, sql, ...params);
    assert.deepEqual(
      contentOf(db, [
        'semantic_assertion_versions',
        'semantic_arguments',
        'semantic_dependencies',
        'claim_versions',
        'claim_version_sources',
      ]),
      before
    );
    handle.close();
  });
}

test('a claim version with no semantic payload stays writable for the shipped retirement paths', () => {
  // Bug: the seal guard fires on every version and upsert.ts#retireAbsent aborts a whole unit flush.
  const { handle, db } = memory();
  seal(handle);
  db.prepare("UPDATE claim_versions SET retired_at = ? WHERE id = 'cv:2'").run(AT);
  assert.equal(db.prepare("SELECT retired_at FROM claim_versions WHERE id = 'cv:2'").get()?.retired_at, AT);
  handle.close();
});

const REGISTRY_MUTATIONS: ReadonlyArray<[string, string, Array<unknown>]> = [
  ['a kind update', "UPDATE semantic_entity_kinds SET definition_json = '{}' WHERE id = 'fixture.kind'", []],
  ['a kind delete', "DELETE FROM semantic_entity_kinds WHERE id = 'fixture.kind'", []],
  [
    'a kind replacement',
    `INSERT OR REPLACE INTO semantic_entity_kinds (id, version, definition_json, created_at) VALUES ('fixture.kind', 1, '{}', '${AT}')`,
    [],
  ],
  [
    'a predicate update',
    "UPDATE semantic_predicate_versions SET definition_json = '{}' WHERE id = 'fixture.relation'",
    [],
  ],
  ['a predicate delete', "DELETE FROM semantic_predicate_versions WHERE id = 'fixture.relation'", []],
  [
    'a predicate replacement',
    `INSERT OR REPLACE INTO semantic_predicate_versions (id, version, definition_json, created_at) VALUES ('fixture.relation', 1, '{}', '${AT}')`,
    [],
  ],
];

for (const [name, sql, params] of REGISTRY_MUTATIONS) {
  test(`refuses ${name} because a registry version is immutable`, () => {
    // Bug: changing a definition silently reinterprets every sealed assertion made under it.
    const { handle, db } = memory();
    const before = contentOf(db, ['semantic_entity_kinds', 'semantic_predicate_versions']);
    refused(db, sql, ...params);
    assert.deepEqual(contentOf(db, ['semantic_entity_kinds', 'semantic_predicate_versions']), before);
    handle.close();
  });
}

// ---- constraints -----------------------------------------------------------------------------------------------------

/** The columns of one assertion row with one field changed: the constraint tests start from a valid row. */
function assertion(change: Record<string, unknown>): Array<unknown> {
  const row: Record<string, unknown> = {
    version_id: 'cv:2',
    format_version: 1,
    assertion_kind: 'relation',
    predicate_id: 'fixture.relation',
    predicate_version: 1,
    truth_state: 'current',
    how: 'said',
    polarity: 'positive',
    valid_from_at: null,
    valid_to_at: null,
    recorded_at: AT,
    audience_id: PUBLIC,
    historical_metadata_complete: 1,
    ...change,
  };
  return Object.values(row);
}
const ASSERTION_SQL = `INSERT INTO semantic_assertion_versions (version_id, format_version, assertion_kind, predicate_id, predicate_version,
  truth_state, how, polarity, valid_from_at, valid_to_at, recorded_at, audience_id, historical_metadata_complete)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const BAD_ASSERTIONS: ReadonlyArray<[string, Record<string, unknown>]> = [
  ['an unknown polarity word', { polarity: 'maybe' }],
  ['an unknown polarity on a structured assertion', { polarity: 'unknown' }],
  ['an unknown truth state', { truth_state: 'probably' }],
  ['an unknown assertion kind', { assertion_kind: 'guess' }],
  [
    'a validity interval that ends before it starts',
    { valid_from_at: '2026-11-02T00:00:00.000Z', valid_to_at: '2026-11-01T00:00:00.000Z' },
  ],
  ['a text assertion carrying a predicate', { assertion_kind: 'text', polarity: 'unknown' }],
  ['a structured assertion without a predicate', { predicate_id: null, predicate_version: null }],
  ['a predicate version the registry does not hold', { predicate_version: 9 }],
  ['an audience that does not exist', { audience_id: 'aud:group:nowhere' }],
  ['a claim version that does not exist', { version_id: 'cv:none' }],
  ['a metadata mark outside zero and one', { historical_metadata_complete: 2 }],
];

for (const [name, change] of BAD_ASSERTIONS) {
  test(`refuses an assertion row with ${name}`, () => {
    // Bug: an epistemic snapshot no reader can interpret is stored as if it were a fact.
    const { handle, db } = memory();
    assert.throws(
      () => handle.transaction(() => db.prepare(ASSERTION_SQL).run(...assertion(change))),
      /constraint|FOREIGN KEY/i
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM semantic_assertion_versions').get()?.n, 0);
    handle.close();
  });
}

test('a plain text version may be stored with no predicate and an unknown polarity', () => {
  // Bug: new plain claims cannot snapshot their metadata, so history falls back to the mutable parent claim.
  const { handle, db } = memory();
  handle.transaction(() =>
    db
      .prepare(ASSERTION_SQL)
      .run(...assertion({ assertion_kind: 'text', predicate_id: null, predicate_version: null, polarity: 'unknown' }))
  );
  assert.equal(
    db.prepare("SELECT assertion_kind FROM semantic_assertion_versions WHERE version_id = 'cv:2'").get()
      ?.assertion_kind,
    'text'
  );
  handle.close();
});

const BAD_ARGUMENTS: ReadonlyArray<[string, Array<unknown>]> = [
  ['both a reference and a literal', ['cv:2', 'left', 0, 'entity', 'ent:1', '"x"']],
  ['neither a reference nor a literal', ['cv:2', 'left', 0, null, null, null]],
  ['a reference without its kind', ['cv:2', 'left', 0, null, 'ent:1', null]],
  ['a literal that is not JSON', ['cv:2', 'left', 0, null, null, '{not json']],
  ['a negative position', ['cv:2', 'left', -1, 'entity', 'ent:1', null]],
];

for (const [name, values] of BAD_ARGUMENTS) {
  test(`refuses an argument with ${name}`, () => {
    // Bug: a reader meets a role that resolves to nothing or to two different things.
    const { handle, db } = memory();
    assert.throws(
      () =>
        db
          .prepare(
            'INSERT INTO semantic_arguments (version_id, role, position, ref_kind, ref_id, literal_json) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(...values),
      /constraint/i
    );
    handle.close();
  });
}

test('refuses a version that names itself as its own premise', () => {
  // Bug: the shortest premise cycle bypasses the writer's cycle check.
  const { handle, db } = memory();
  assert.throws(() => db.prepare(DEPENDENCY_SQL).run('cv:1', 'cv:1'), /constraint/i);
  handle.close();
});

test('refuses a premise that is no stored claim version', () => {
  // Bug: a dependency names a version nobody can open, so a premise change is never noticed.
  const { handle, db } = memory();
  assert.throws(() => db.prepare(DEPENDENCY_SQL).run('cv:1', 'cv:none'), /FOREIGN KEY/i);
  handle.close();
});

test('refuses an entity of a kind version the registry does not hold', () => {
  // Bug: an arbitrary model string becomes a kind with no contract behind it.
  const { handle, db } = memory();
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO semantic_entities (id, kind, kind_version, created_at) VALUES ('ent:x', 'invented', 1, ?)"
        )
        .run(AT),
    /FOREIGN KEY/i
  );
  handle.close();
});

test('an entity base row has no name, summary or audience column', () => {
  // Bug: a global name or summary on the base row shows a private fact to every audience.
  const { handle, db } = memory();
  const columns = db
    .prepare("SELECT name FROM pragma_table_info('semantic_entities')")
    .all()
    .map((row) => String(row.name));
  for (const column of columns) assert.doesNotMatch(column, /name|label|summary|description|text/);
  handle.close();
});

test('refuses an equivalence row from an entity to itself', () => {
  // Bug: a self merge loops every reader that follows equivalence.
  const { handle, db } = memory();
  seal(handle);
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO semantic_entity_merges (version_id, from_entity_id, into_entity_id) VALUES ('cv:1', 'ent:1', 'ent:1')"
        )
        .run(),
    /constraint/i
  );
  handle.close();
});

// ---- rebuildable projections -----------------------------------------------------------------------------------------

test('a label projection can be deleted and written again, because it is no fact of its own', () => {
  // Bug: a seal guard on the projection tables makes a rebuild impossible.
  const { handle, db } = memory();
  seal(handle);
  const insert = db.prepare(
    "INSERT INTO semantic_labels (version_id, entity_id, role, language, text, normalized) VALUES ('cv:1', 'ent:1', 'name', 'en', 'Lumen', 'lumen')"
  );
  insert.run();
  db.prepare('DELETE FROM semantic_labels').run();
  insert.run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM semantic_labels').get()?.n, 1);
  handle.close();
});

test('the search index follows a document through insert, update and delete', () => {
  // Bug: a stale index entry keeps a retired or private text findable.
  const { handle, db } = memory();
  const found = (word: string) =>
    db.prepare('SELECT rowid FROM semantic_search_fts WHERE semantic_search_fts MATCH ?').all(word).length;
  db.prepare(
    `INSERT INTO semantic_search_documents (rowid, document_key, version_id, ref_kind, ref_id, audience_id, text, projection_version)
     VALUES (1, 'semantic:cv:1:0', 'cv:1', 'entity', 'ent:1', ?, 'lumen prototype', 1)`
  ).run(PUBLIC);
  assert.equal(found('lumen'), 1);
  db.prepare("UPDATE semantic_search_documents SET text = 'orbis meeting' WHERE rowid = 1").run();
  assert.equal(found('lumen'), 0);
  assert.equal(found('orbis'), 1);
  db.prepare('DELETE FROM semantic_search_documents WHERE rowid = 1').run();
  assert.equal(found('orbis'), 0);
  handle.close();
});

// ---- query plans -----------------------------------------------------------------------------------------------------

const PLANS: ReadonlyArray<[string, string, string]> = [
  [
    'the arguments of an endpoint',
    "SELECT version_id FROM semantic_arguments WHERE ref_kind = 'entity' AND ref_id = 'ent:1'",
    'semantic_arguments',
  ],
  [
    'the versions that depend on a premise',
    "SELECT version_id FROM semantic_dependencies WHERE premise_version_id = 'cv:1'",
    'semantic_dependencies',
  ],
  [
    'the labels of a normalized text',
    "SELECT entity_id FROM semantic_labels WHERE normalized = 'lumen'",
    'semantic_labels',
  ],
  [
    'the equivalences out of an entity',
    "SELECT into_entity_id FROM semantic_entity_merges WHERE from_entity_id = 'ent:1'",
    'semantic_entity_merges',
  ],
  [
    'the equivalences into an entity',
    "SELECT from_entity_id FROM semantic_entity_merges WHERE into_entity_id = 'ent:1'",
    'semantic_entity_merges',
  ],
  [
    'the documents of an audience',
    `SELECT rowid FROM semantic_search_documents WHERE audience_id = '${PUBLIC}'`,
    'semantic_search_documents',
  ],
  [
    'the documents of a reference',
    "SELECT rowid FROM semantic_search_documents WHERE ref_kind = 'entity' AND ref_id = 'ent:1'",
    'semantic_search_documents',
  ],
  [
    'the assertions of a predicate',
    "SELECT version_id FROM semantic_assertion_versions WHERE predicate_id = 'fixture.relation'",
    'semantic_assertion_versions',
  ],
];

for (const [name, sql, table] of PLANS) {
  test(`reads ${name} through an index`, () => {
    // Bug: a hub entity turns one hop into a scan of the table inside the prefetch deadline.
    const { handle, db } = memory();
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all()
      .map((row) => String(row.detail))
      .join('\n');
    assert.match(plan, new RegExp(`SEARCH ${table}`));
    handle.close();
  });
}
