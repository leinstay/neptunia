// The stored shape of memory that the schema baseline (src/memory/db/schema-baseline.ts) creates, on in-memory
// databases and with the SQL any writer would send. A semantic version is sealed by inserting its immutable row last,
// so these tests hold the guards themselves; the writer's own validation is in
// tests/src/memory/db/semantic-write.test.ts. The fixture's kind and predicate are made up here on purpose, so the
// registry's shipped list is not what makes these pass. Synthetic content only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db, MemoryHandle } from '../../../../src/memory/db/types.ts';
import { MIGRATIONS } from '../../../../src/memory/db/open.ts';
import { BASELINE_VERSION } from '../../../../src/memory/db/schema-baseline.ts';
import { INITIAL_ENTITY_KINDS, INITIAL_PREDICATES } from '../../../../src/memory/db/semantic-registry.ts';
import { BOARD_VERSION, boardVersion } from '../../../../src/board/schema.ts';
import path from 'node:path';
import { tempDir } from '../../../fixtures/tmp.ts';
import { newPersonId } from '../../../../src/memory/db/ids.ts';

const AT = '2026-11-05T10:00:00.000Z';
const PUBLIC = 'aud:group:discord';
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

// ---- the append migration --------------------------------------------------------------------------------------------

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
  // Bug: the seal guard fires on every version and the retirement of an absent row aborts a whole write.
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

// Tests for the schema baseline (src/memory/db/schema-baseline.ts) as src/memory/db/open.ts applies it: a new database
// starts at the baseline with its seed rows, and a claim link it writes gets its id. In-memory databases only.

const versions = (handle: ReturnType<typeof openMemoryDb>): Array<number> =>
  dbOf(handle)
    .prepare('SELECT version FROM schema_version ORDER BY version')
    .all()
    .map((row) => Number(row.version));

/** The versions a current database holds: the baseline's, then one per step above it. */
const CURRENT = [BASELINE_VERSION, ...MIGRATIONS.map((_, step) => BASELINE_VERSION + step + 1)];

test('a new database starts at the baseline with the seed rows a new install needs', () => {
  // Catches: a lost seed row, which leaves a new install without the persona's own person, an audience, an interface's
  // authority, a registry entry or the board.
  const fresh = openMemoryDb(':memory:');
  try {
    const db = dbOf(fresh);
    const column = (sql: string): Array<unknown> =>
      db
        .prepare(sql)
        .all()
        .map((row) => Object.values(row)[0]);
    assert.deepEqual(versions(fresh), CURRENT);
    assert.deepEqual(column("SELECT kind FROM people WHERE id = 'person:self'"), ['self']);
    assert.deepEqual(column('SELECT id FROM audiences ORDER BY id'), ['aud:internal', 'aud:none']);
    assert.deepEqual(column('SELECT id FROM interfaces ORDER BY id'), ['cli', 'core', 'discord']);
    assert.deepEqual(column("SELECT id FROM authorities WHERE iface IN ('cli', 'core', 'discord') ORDER BY id"), [
      'cli/local',
      'core/local',
      'discord/global',
    ]);
    assert.deepEqual(column("SELECT row_id FROM graph_nodes WHERE kind = 'interface' ORDER BY row_id"), [
      'cli',
      'core',
      'discord',
    ]);
    assert.equal(column('SELECT id FROM semantic_entity_kinds').length, INITIAL_ENTITY_KINDS.length);
    assert.equal(column('SELECT id FROM semantic_predicate_versions').length, INITIAL_PREDICATES.length);
    assert.equal(boardVersion(db), BOARD_VERSION);
    assert.equal(fresh.board.ok, true);
  } finally {
    fresh.close();
  }
});

test('a claim link a new database writes gets the id of its claim and source', () => {
  // Catches: the id trigger of claim_sources reading a column the baseline does not hold, which fails every link.
  // Moved from the test of version step 55, which goes with the step.
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    db.prepare(
      "INSERT INTO claims (id, subject_kind, subject_id, kind, text) VALUES ('c1', 'place', 'synthetic:root:1', 'injoke', 'the lamp')"
    ).run();
    db.prepare("INSERT INTO claim_sources (claim_id, source_id, position) VALUES ('c1', 's1', 0)").run();
    db.prepare("INSERT INTO claim_sources (claim_id, source_id, position) VALUES ('c1', 's1', 1)").run();
    assert.deepEqual(
      db
        .prepare("SELECT id FROM claim_sources WHERE claim_id = 'c1' ORDER BY rowid")
        .all()
        .map((row) => String(row.id).replace(/#dup\d+$/, '#dup')),
      ['cs:c1:s:s1', 'cs:c1:s:s1#dup']
    );
  } finally {
    handle.close();
  }
});

// Tests for schema v16 of the memory database (src/memory/db/schema.ts): the `ingest` table holds one row per event
// the core committed, scoped by the principal that sent it, and `ingest_cursor` the watermark acknowledged to each
// principal. An event id and a seq are each unique within a principal, so a redelivered event can never be taken
// twice, while two principals may use the same id and the same seq. The database is in memory.

type IngestDb = {
  prepare(sql: string): { run(...args: Array<unknown>): unknown; get(...args: Array<unknown>): unknown };
};

const INSERT =
  'INSERT INTO ingest (principal, seq, event_id, kind, conversation, committed_at) VALUES (?, ?, ?, ?, ?, ?)';
const INGEST_AT = '2026-10-27T12:00:00.000Z';

function opened(): { db: IngestDb; close(): void } {
  const handle = openMemoryDb(':memory:');
  return { db: handle.db as IngestDb, close: () => handle.close() };
}

test('the same event id of one principal is refused a second time under another seq', () => {
  const memory = opened();
  const { db } = memory;
  try {
    db.prepare(INSERT).run('fake', 1, 'fake:message:m1', 'message.received', 'c1', INGEST_AT);
    assert.throws(
      () => db.prepare(INSERT).run('fake', 2, 'fake:message:m1', 'message.received', 'c1', INGEST_AT),
      /UNIQUE/
    );
  } finally {
    memory.close();
  }
});

test('the same seq of one principal is refused a second time under another event id', () => {
  const memory = opened();
  const { db } = memory;
  try {
    db.prepare(INSERT).run('fake', 1, 'fake:message:m1', 'message.received', 'c1', INGEST_AT);
    assert.throws(
      () => db.prepare(INSERT).run('fake', 1, 'fake:message:m2', 'message.received', 'c1', INGEST_AT),
      /UNIQUE/
    );
  } finally {
    memory.close();
  }
});

test('two principals may each commit the same event id under the same seq', () => {
  const memory = opened();
  const { db } = memory;
  try {
    db.prepare(INSERT).run('fake', 1, 'shared:1', 'reaction.changed', 'c1', INGEST_AT);
    db.prepare(INSERT).run('other', 1, 'shared:1', 'reaction.changed', 'c1', INGEST_AT);
    assert.deepEqual({ ...(db.prepare('SELECT COUNT(*) AS n FROM ingest').get() as object) }, { n: 2 });
  } finally {
    memory.close();
  }
});

test('ingest_cursor keeps one watermark per principal', () => {
  const memory = opened();
  const { db } = memory;
  try {
    db.prepare('INSERT INTO ingest_cursor (principal, acked_seq) VALUES (?, ?)').run('fake', 3);
    assert.throws(() => db.prepare('INSERT INTO ingest_cursor (principal, acked_seq) VALUES (?, ?)').run('fake', 4));
  } finally {
    memory.close();
  }
});

// The write kind `line-vectors` (src/memory/db/line-vectors.ts): the vectors of the lines the persona saw and said,
// written as `vectors` rows of a place directly instead of as month units with a manifest. The tests read the months and
// lines, and the schema step that gave the older rows their place.

test('a line found by its stored address is searched through its index in a new database', () => {
  // Catches: an index over other expressions than the query's, so finding an old line scans every line.
  // The index is part of the baseline, so a new database holds it.
  const handle = openMemoryDb(path.join(tempDir('line-vectors-index'), 'memory.db'));
  try {
    const plan = dbOf(handle)
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM sources WHERE iface = ? AND CASE WHEN json_valid(extra) THEN COALESCE(json_extract(extra, '$."$messageLocator".chatId'), json_extract(extra, '$."$messageLocator".conversationId')) END = ? AND CASE WHEN json_valid(extra) THEN json_extract(extra, '$."$messageLocator".messageId') END = ? AND generation = ?`
      )
      .all('discord', 'c', 'm', 1)
      .map((row) => String(row.detail));
    assert.match(plan.join(' | '), /USING INDEX sources_message_locator/);
  } finally {
    handle.close();
  }
});

// The schema of the meta-person: a meta-person is a `people` row marked `meta`,
// every row of `person_accounts` hangs under one, a line may carry no `author_person`, and the read adapter of
// src/memory/db/meta-person.ts answers from the new rows first and from the old verified links of `accounts` after.

type Handle = ReturnType<typeof openMemoryDb>;

function withDb(body: (db: Db) => void): void {
  const handle: Handle = openMemoryDb(path.join(tempDir('nep-meta-person-'), 'memory.db'));
  try {
    body(dbOf(handle));
  } finally {
    handle.close();
  }
}

const columnsOf = (db: Db, table: string): Array<string> =>
  db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .map((row) => String(row.name));

const addMetaPerson = (db: Db, id: string): void => {
  db.prepare("INSERT INTO people (id, kind, meta) VALUES (?, 'person', 1)").run(id);
};

const addAccount = (db: Db, row: { id: string; person: string | null; iface: string; platformId: string }): void => {
  db.prepare(
    `INSERT INTO person_accounts (id, person_id, iface, platform_id, handle, display_name, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, '2026-11-08T00:00:00.000Z')`
  ).run(row.id, row.person, row.iface, row.platformId, `handle-${row.platformId}`, `Name ${row.platformId}`);
};

const addLegacyPerson = (db: Db, id: string): void => {
  db.prepare("INSERT INTO people (id, kind) VALUES (?, 'member')").run(id);
};

test('a fresh database holds the meta flag, the account table and the author person of a line', () => {
  withDb((db) => {
    assert.ok(columnsOf(db, 'people').includes('meta'));
    const accountColumns = columnsOf(db, 'person_accounts');
    for (const column of [
      'id',
      'person_id',
      'iface',
      'platform_id',
      'generation',
      'handle',
      'display_name',
      'avatar',
      'profile_text',
    ])
      assert.ok(accountColumns.includes(column), column);
    assert.ok(columnsOf(db, 'sources').includes('author_person'));
    const indexed = db
      .prepare("SELECT name FROM pragma_index_list('sources')")
      .all()
      .map((row) => String(row.name))
      .some((name) =>
        db
          .prepare(`SELECT name FROM pragma_index_info('${name}')`)
          .all()
          .some((column) => column.name === 'author_person')
      );
    assert.equal(indexed, true);
  });
});

test('refuses an account with no person', () => {
  withDb((db) => {
    assert.throws(() => addAccount(db, { id: 'chat:1', person: null, iface: 'chat', platformId: '1' }), /NOT NULL/);
  });
});

test('refuses an account whose person nobody stored', () => {
  withDb((db) => {
    assert.throws(
      () => addAccount(db, { id: 'chat:1', person: newPersonId(), iface: 'chat', platformId: '1' }),
      /FOREIGN KEY/
    );
  });
});

test('refuses an account whose person is not a meta-person', () => {
  withDb((db) => {
    addLegacyPerson(db, 'person:chat:1');
    assert.throws(
      () => addAccount(db, { id: 'chat:1', person: 'person:chat:1', iface: 'chat', platformId: '1' }),
      /ACCOUNT_PARENT_NOT_META/
    );
  });
});

test('refuses moving an account under a person that is not a meta-person', () => {
  withDb((db) => {
    const meta = newPersonId();
    addMetaPerson(db, meta);
    addLegacyPerson(db, 'person:chat:2');
    addAccount(db, { id: 'chat:1', person: meta, iface: 'chat', platformId: '1' });
    assert.throws(
      () => db.prepare("UPDATE person_accounts SET person_id = 'person:chat:2' WHERE id = 'chat:1'").run(),
      /ACCOUNT_PARENT_NOT_META/
    );
  });
});

test('refuses a second account with the same interface and platform id', () => {
  withDb((db) => {
    const meta = newPersonId();
    addMetaPerson(db, meta);
    addAccount(db, { id: 'chat:1', person: meta, iface: 'chat', platformId: '1' });
    assert.throws(() => addAccount(db, { id: 'chat:1b', person: meta, iface: 'chat', platformId: '1' }), /UNIQUE/);
  });
});

test('stores a line with no author person', () => {
  withDb((db) => {
    db.prepare(
      "INSERT INTO sources (id, kind, iface, place_id, text) VALUES ('src:anon', 'seen', 'chat', 'p', 'hi')"
    ).run();
    const row = db.prepare("SELECT author_person FROM sources WHERE id = 'src:anon'").get();
    assert.equal(row?.author_person, null);
  });
});

test('refuses a line whose author person nobody stored', () => {
  withDb((db) => {
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO sources (id, kind, iface, place_id, text, author_person) VALUES ('src:x', 'seen', 'chat', 'p', 'hi', ?)"
          )
          .run(newPersonId()),
      /FOREIGN KEY/
    );
  });
});

// The FTS triggers of the memory schema keep the word and trigram indexes of `sources` in step, over in-memory
// databases.

const insertSource = (db: Db, id: string, text: string | null, stems: string | null = null) =>
  db
    .prepare("INSERT INTO sources (id, kind, text, stems, scope_kind) VALUES (?, 'seen', ?, ?, 'group')")
    .run(id, text, stems).lastInsertRowid;
const wordHits = (db: Db, query: string) =>
  db
    .prepare(
      'SELECT s.id FROM sources_fts f JOIN sources s ON s.rowid = f.rowid WHERE sources_fts MATCH ? ORDER BY s.id'
    )
    .all(query)
    .map((row) => row.id);
const triHits = (db: Db, query: string) =>
  db
    .prepare(
      'SELECT s.id FROM sources_tri f JOIN sources s ON s.rowid = f.rowid WHERE sources_tri MATCH ? ORDER BY s.id'
    )
    .all(query)
    .map((row) => row.id);

test('triggers keep the word and trigram indexes in step with sources', () => {
  const handle = openMemoryDb(':memory:');
  const db = dbOf(handle);
  const first = insertSource(db, 'a', 'the lighthouse keeper', 'lighthouse keeper');
  insertSource(db, 'b', 'a café by the harbour', 'cafe harbour');
  assert.deepEqual(wordHits(db, 'lighthouse'), ['a']);
  assert.deepEqual(wordHits(db, 'cafe'), ['b'], 'diacritics are removed');
  assert.deepEqual(wordHits(db, 'stems:keeper'), ['a']);
  assert.deepEqual(triHits(db, 'ighthou'), ['a']);
  db.prepare('UPDATE sources SET text = ?, stems = ? WHERE rowid = ?').run(
    'the harbour master',
    'harbour master',
    first
  );
  assert.deepEqual(wordHits(db, 'lighthouse'), []);
  assert.deepEqual(wordHits(db, 'harbour'), ['a', 'b']);
  assert.deepEqual(triHits(db, 'ighthou'), []);
  assert.deepEqual(triHits(db, 'arbour'), ['a', 'b']);
  db.prepare('DELETE FROM sources WHERE rowid = ?').run(first);
  assert.deepEqual(wordHits(db, 'harbour'), ['b']);
  handle.close();
});

test('a source with no text is indexed without error and the id is unique', () => {
  const handle = openMemoryDb(':memory:');
  insertSource(dbOf(handle), 'a', null);
  assert.throws(() => insertSource(dbOf(handle), 'a', 'again'), /UNIQUE/);
  handle.close();
});

test('FTS5 words in Greek and accented Latin are found', () => {
  const handle = openMemoryDb(':memory:');
  insertSource(dbOf(handle), 'g', 'Καλημέρα κόσμε', 'καλημερα κοσμε');
  assert.deepEqual(wordHits(dbOf(handle), 'καλημερα'), ['g']);
  assert.deepEqual(triHits(dbOf(handle), 'ημέρ'), ['g']);
  handle.close();
});

// The stored shape of semantic memory: the tables and guards of the schema baseline (src/memory/db/schema-baseline.ts),
// on real temporary databases and with the SQL any writer would send. A version is sealed by inserting its
// immutable row last, so these tests hold the guards themselves; the writer's own validation is in
// tests/src/memory/db/semantic-write.test.ts. The fixture's kind and predicate are made up here on purpose, so the registry's
// shipped list is not what makes these pass. Synthetic content only.

const SEMANTIC_SCHEMA_AT = '2026-11-05T10:00:00.000Z';
const SEMANTIC_SCHEMA_PUBLIC = 'aud:group:discord';
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

function semanticSchemaSeedBase(db: Db): void {
  db.exec(`INSERT OR IGNORE INTO audiences (id, kind, iface) VALUES ('${SEMANTIC_SCHEMA_PUBLIC}', 'group', 'discord');
    INSERT INTO people (id, first_seen_at) VALUES ('person:alex', '${SEMANTIC_SCHEMA_AT}');
    INSERT INTO places (id, iface, kind, scope_kind, name) VALUES ('place:room', 'discord', 'channel', 'group', 'Café room');
    INSERT INTO sources (id, kind, iface, native_id, revision, place_id, occurred_at, recorded_at, text, scope_kind, scope_iface, audience_id)
      VALUES ('src:1', 'seen', 'discord', 'm1', 1, 'place:room', '${SEMANTIC_SCHEMA_AT}', '${SEMANTIC_SCHEMA_AT}', 'Ω the words  ', 'group', 'discord', '${SEMANTIC_SCHEMA_PUBLIC}');
    INSERT INTO sources (id, kind, iface, native_id, revision, place_id, occurred_at, recorded_at, text, scope_kind, scope_iface, audience_id)
      VALUES ('src:2', 'seen', 'discord', 'm2', 1, 'place:room', '${SEMANTIC_SCHEMA_AT}', '${SEMANTIC_SCHEMA_AT}', 'other words', 'group', 'discord', '${SEMANTIC_SCHEMA_PUBLIC}');
    INSERT INTO claims (id, subject_kind, subject_id, kind, text, truth, shown, scope_kind, scope_iface, audience_id, created_at)
      VALUES ('clm:1', 'person', 'person:alex', 'detail', 'plain prose', 'current', 1, 'group', 'discord', '${SEMANTIC_SCHEMA_PUBLIC}', '${SEMANTIC_SCHEMA_AT}');
    INSERT INTO claims (id, subject_kind, subject_id, kind, text, truth, shown, scope_kind, scope_iface, audience_id, created_at)
      VALUES ('clm:2', 'person', 'person:alex', 'detail', 'more prose', 'current', 1, 'group', 'discord', '${SEMANTIC_SCHEMA_PUBLIC}', '${SEMANTIC_SCHEMA_AT}');`);
  for (const id of ['cv:1', 'cv:2', 'cv:3']) {
    db.prepare(
      `INSERT INTO claim_versions (id, claim_id, revision_id, text, recorded_at, event, by, origin)
       VALUES (?, 'clm:1', ?, 'plain prose', ?, 'add', 'her', 'session')`
    ).run(id, `rv:${id}`, SEMANTIC_SCHEMA_AT);
  }
  db.prepare(
    "INSERT INTO claim_version_sources (version_id, source_id, role) VALUES ('cv:1', 'src:1', 'supports')"
  ).run();
}

function semanticSchemaSeedRegistry(db: Db): void {
  const definition = JSON.stringify({ roles: [{ role: 'left', min: 1, max: 1, refs: ['entity'], literals: [] }] });
  db.prepare('INSERT INTO semantic_entity_kinds (id, version, definition_json, created_at) VALUES (?, 1, ?, ?)').run(
    'fixture.kind',
    '{"fields":[]}',
    SEMANTIC_SCHEMA_AT
  );
  db.prepare(
    'INSERT INTO semantic_predicate_versions (id, version, definition_json, created_at) VALUES (?, 1, ?, ?)'
  ).run('fixture.relation', definition, SEMANTIC_SCHEMA_AT);
  db.prepare(
    "INSERT INTO semantic_entities (id, kind, kind_version, created_at) VALUES ('ent:1', 'fixture.kind', 1, ?)"
  ).run(SEMANTIC_SCHEMA_AT);
}

const SEMANTIC_SCHEMA_SEAL_SQL = `INSERT INTO semantic_assertion_versions (version_id, format_version, assertion_kind, predicate_id, predicate_version,
  truth_state, how, polarity, valid_from_at, valid_to_at, recorded_at, audience_id, historical_metadata_complete)
  VALUES (?, 1, 'relation', 'fixture.relation', 1, 'current', 'said', 'positive', NULL, NULL, ?, ?, 1)`;
const SEMANTIC_SCHEMA_ARGUMENT_SQL =
  "INSERT INTO semantic_arguments (version_id, role, position, ref_kind, ref_id, literal_json) VALUES (?, ?, 0, 'entity', 'ent:1', NULL)";
const SEMANTIC_SCHEMA_DEPENDENCY_SQL =
  "INSERT INTO semantic_dependencies (version_id, premise_version_id, role) VALUES (?, ?, 'supports')";

/** One whole sealed payload, in the writer's order: arguments and premise first, the immutable row last. */
function semanticSchemaSeal(handle: MemoryHandle, versionId = 'cv:1'): void {
  const db = dbOf(handle);
  handle.transaction(() => {
    db.prepare(SEMANTIC_SCHEMA_ARGUMENT_SQL).run(versionId, 'left');
    db.prepare(SEMANTIC_SCHEMA_DEPENDENCY_SQL).run(versionId, 'cv:3');
    db.prepare(SEMANTIC_SCHEMA_SEAL_SQL).run(versionId, SEMANTIC_SCHEMA_AT, SEMANTIC_SCHEMA_PUBLIC);
  });
}

const semanticSchemaContentOf = (db: Db, tables: ReadonlyArray<string>): Record<string, string> =>
  Object.fromEntries(
    tables.map((table) => [table, JSON.stringify(db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all())])
  );

// ---- the append migration --------------------------------------------------------------------------------------------

test('a second open of a sealed database runs no conversion and changes no semantic row', () => {
  // Bug: the semantic step or a registry seed runs again on each start and duplicates or rewrites rows.
  const file = path.join(tempDir('nep-semantic-schema-'), 'memory.db');
  const first = openMemoryDb(file);
  semanticSchemaSeedBase(dbOf(first));
  semanticSchemaSeedRegistry(dbOf(first));
  semanticSchemaSeal(first);
  const before = semanticSchemaContentOf(
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
      semanticSchemaContentOf(
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
  semanticSchemaSeedBase(dbOf(writer));
  semanticSchemaSeedRegistry(dbOf(writer));
  semanticSchemaSeal(writer);
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
