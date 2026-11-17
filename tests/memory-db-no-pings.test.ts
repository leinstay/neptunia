// Schema step 62 (src/memory/db/schema.ts) on a database written at version 61: the members' ping states leave the
// memory. The keys `pings` and `pingsOff` leave the value of every operational row of kind `place`, the key `notify`
// leaves the send of every diary entry, and the column `memberships.pings_off` is dropped. Each test builds a version
// 61 file with the steps above the baseline up to 61, fills it with raw SQL the way production holds it, and opens it
// with the current code. Temporary files, synthetic rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, inTransaction, openMemoryDb } from '../src/memory/db/open.ts';
import { BASELINE_VERSION } from '../src/memory/db/schema-baseline.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import { filledRows, schemaShape } from './fixtures/memory-db/schema-shape.ts';
import { tempDir } from './fixtures/tmp.ts';

/** Two places with notes, one holding the ping states and the list of the earlier switch, and a row of another kind. */
const NOTES = `
INSERT INTO operational (kind, owner, value, writer, holder_id) VALUES
  ('place', 'place:p1', '{"$has":["injokes"],"learnedNextId":3,"pings":{"a1":"on","a2":"off"},"pingsOff":["a3"],"notesUpdatedAt":"2026-11-01T10:00:00.000Z"}', 'place', 'unit:p1'),
  ('place', 'place:p2', '{"$has":[],"learnedNextId":1,"emojiUsage":{}}', 'place', 'unit:p2'),
  ('recent', 'place:p1', '{"pings":{"a1":"on"},"lines":[]}', 'recent', 'unit:r1');
`;

/** Two diary entries, one whose send kept who asked to be pinged. */
const ENTRIES = `
INSERT INTO diary (id, at_ms, kind, status, scope_kind, extra) VALUES
  ('diary:e1', 1000, 'thought', 'done', 'group', '{"send":{"messages":["one","two"],"mentions":[["a1"],[]],"notify":[true,false],"maxMessageBytes":8}}'),
  ('diary:e2', 2000, 'thought', 'done', 'group', '{"send":{"messages":["three"],"mentions":[[]]}}');
`;

/** Two memberships, one with the column filled the way an older writer could leave it. */
const MEMBERSHIPS = `
INSERT INTO memberships (id, account_id, place_id, nick, roles, addressed_as, pings_off, extra) VALUES
  ('mem:a1', 'a1', 'place:p1', 'Ada', '["r1"]', '[{"name":"Ada","count":2}]', 1, NULL),
  ('mem:a2', 'a2', NULL, NULL, NULL, NULL, NULL, '{"x":1}');
`;

const ALL = NOTES + ENTRIES + MEMBERSHIPS;

/** The step that brings a database from 61 to 62. */
const step62 = MIGRATIONS[62 - BASELINE_VERSION - 1];

/** A database file at schema version 61 holding `sql`, written with raw SQL after the steps up to 61. */
function at61(sql: string): string {
  const file = path.join(tempDir('nep-pings-62-'), 'memory.db');
  openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 61 - BASELINE_VERSION) }).close();
  const raw = new DatabaseSync(file);
  try {
    assert.equal(raw.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v, 61);
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
/** A stored JSON text as a value. */
const parsed = (text: unknown): unknown => JSON.parse(String(text));
/** The whole database: its objects and every row. */
const everything = (db: Db): unknown => ({ shape: schemaShape(db), rows: filledRows(db) });

test('a database at version 61 opens with step 62 recorded', () => {
  // Bug: a step that runs but records no version, so the next open runs it again.
  const file = at61(ALL);
  const versions = opened(file, (db) => rows(db, 'SELECT version FROM schema_version').map((row) => row.version));
  assert.deepEqual(
    versions.filter((version) => version === 62),
    [62]
  );
});

test('step 62 takes the ping states out of a place row and keeps its other keys', () => {
  // Bug: the states stay in the notes, so a place's operational row keeps who chose on and off after the feature left.
  const file = at61(ALL);
  const value = opened(file, (db) =>
    rows(db, "SELECT value FROM operational WHERE kind = 'place' AND owner = 'place:p1'")
  );
  assert.deepEqual(parsed(value[0]?.value), {
    $has: ['injokes'],
    learnedNextId: 3,
    notesUpdatedAt: '2026-11-01T10:00:00.000Z',
  });
});

test('step 62 leaves a place row without the keys and a row of another kind as they were', () => {
  // Bug: the step rewrites every operational row, so a value of another kind loses a key of its own named `pings`.
  const file = at61(ALL);
  const values = opened(file, (db) =>
    rows(
      db,
      "SELECT kind, owner, value FROM operational WHERE owner <> 'place:p1' OR kind <> 'place' ORDER BY kind, owner"
    )
  );
  assert.deepEqual(values, [
    { kind: 'place', owner: 'place:p2', value: '{"$has":[],"learnedNextId":1,"emojiUsage":{}}' },
    { kind: 'recent', owner: 'place:p1', value: '{"pings":{"a1":"on"},"lines":[]}' },
  ]);
});

test('step 62 takes notify out of a diary send and keeps its messages and mentions', () => {
  // Bug: the stored send keeps `notify`, so a mirror posting the entry again reads who asked to be pinged.
  const file = at61(ALL);
  const extras = opened(file, (db) => rows(db, 'SELECT id, extra FROM diary ORDER BY id'));
  assert.deepEqual(
    extras.map((row) => [row.id, parsed(row.extra)]),
    [
      ['diary:e1', { send: { messages: ['one', 'two'], mentions: [['a1'], []], maxMessageBytes: 8 } }],
      ['diary:e2', { send: { messages: ['three'], mentions: [[]] } }],
    ]
  );
});

test('step 62 drops memberships.pings_off and keeps every membership with its other columns', () => {
  // Bug: the column stays behind, or the drop loses a membership row or the columns beside it.
  const file = at61(ALL);
  const after = opened(file, (db) => ({
    columns: rows(db, "SELECT name FROM pragma_table_info('memberships') ORDER BY cid").map((row) => row.name),
    members: rows(db, 'SELECT id, account_id, place_id, nick, roles, addressed_as, extra FROM memberships ORDER BY id'),
  }));
  assert.equal(after.columns.includes('pings_off'), false);
  assert.deepEqual(after.members, [
    {
      id: 'mem:a1',
      account_id: 'a1',
      place_id: 'place:p1',
      nick: 'Ada',
      roles: '["r1"]',
      addressed_as: '[{"name":"Ada","count":2}]',
      extra: null,
    },
    { id: 'mem:a2', account_id: 'a2', place_id: null, nick: null, roles: null, addressed_as: null, extra: '{"x":1}' },
  ]);
});

test('a fresh database and one brought from 61 by step 62 have the same shape', () => {
  // Bug: the step drops the column in a way the baseline plus the steps does not give a new database.
  const migrated = opened(at61(ALL), schemaShape);
  const fresh = opened(path.join(tempDir('nep-pings-62-fresh-'), 'memory.db'), schemaShape);
  assert.deepEqual(migrated, fresh);
});

test('step 62 run a second time on a migrated database changes no table, index or row', () => {
  // Bug: a second run fails on the column it already dropped, or rewrites a value it already cleaned.
  const handle = openMemoryDb(at61(ALL));
  try {
    const db = dbOf(handle);
    const first = everything(db);
    if (step62 === undefined) assert.fail('MIGRATIONS holds no step 62');
    inTransaction(db, () => (typeof step62 === 'function' ? step62(db) : db.exec(step62)));
    assert.deepEqual(everything(db), first);
  } finally {
    handle.close();
  }
});
