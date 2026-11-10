// Version step 55 (src/memory/db/drop-units.ts): the storage unit layer leaves the schema. The tests open a database at
// version 54 holding what the unit layer left, migrate it, and read what remains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { MIGRATIONS } from '../src/memory/db/schema.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { tempDir } from './fixtures/tmp.ts';

const UNIT = 'unit:of-a-place-notes';
const PLACE = 'synthetic:root:1';
const OTHER = 'synthetic:root:2';

/** A database at version 54: a unit, a claim it owns, a shared claim listed twice, a legacy share, a graph edge. */
function seededAt54(): string {
  const file = path.join(tempDir('drop-units'), 'memory.db');
  const old = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 54 - 44) });
  const db = dbOf(old);
  db.prepare(
    `INSERT INTO storage_units (id, kind, subject_type, subject_id, key_json) VALUES (?, 'place', 'place', ?, ?)`
  ).run(UNIT, PLACE, JSON.stringify({ kind: 'place', subject: { type: 'place', id: PLACE } }));
  db.prepare(
    `INSERT INTO claims (id, subject_kind, subject_id, kind, text, owner_key, owner_file, origin_file, writer, holder_id)
     VALUES ('c1', 'place', ?, 'injoke', 'the lamp', ?, 'guilds/g/root.json', 'guilds/g/root.json', 'place', ?)`
  ).run(PLACE, UNIT, PLACE);
  const share = db.prepare(
    'INSERT INTO co_owners (tbl, key, owner_file, owner_key, writer, holder_id) VALUES (?, ?, ?, ?, ?, ?)'
  );
  share.run('claims', 'c1', null, null, 'place', OTHER);
  share.run('claims', 'c1', null, null, 'place', OTHER);
  share.run('claims', 'c1', 'guilds/g/other.json', UNIT, null, null);
  old.close();
  return file;
}

const columnsOf = (db: Db, table: string): Array<string> =>
  db
    .prepare(`SELECT name FROM pragma_table_info(?)`)
    .all(table)
    .map((row) => String(row.name));

test('the step drops the unit tables and every unit column but the graph edge key, and keeps the rows', () => {
  // Catches: a unit column or table the step leaves, a row it loses, or the graph's own key dropped with the units.
  const handle = openMemoryDb(seededAt54());
  try {
    const db = dbOf(handle);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name));
    for (const gone of ['storage_units', 'legacy_unit_aliases', 'files', 'capture_bundles', 'capture_members'])
      assert.equal(tables.includes(gone), false, gone);
    const left = tables.flatMap((table) =>
      columnsOf(db, table)
        .filter((column) => ['owner_key', 'owner_file', 'origin_file'].includes(column))
        .map((column) => `${table}.${column}`)
    );
    assert.deepEqual(left, ['graph_edges.owner_key']);
    assert.deepEqual(
      { ...db.prepare("SELECT text, writer, holder_id FROM claims WHERE id = 'c1'").get() },
      {
        text: 'the lamp',
        writer: 'place',
        holder_id: PLACE,
      }
    );
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    handle.close();
  }
});

test('co_owners keeps one row per sharing writer and holder and drops a share that names neither', () => {
  // Catches: a duplicated share kept, a share lost, or a legacy unit share left naming no place.
  const handle = openMemoryDb(seededAt54());
  try {
    const db = dbOf(handle);
    assert.deepEqual(columnsOf(db, 'co_owners'), ['tbl', 'key', 'writer', 'holder_id']);
    assert.deepEqual(
      db
        .prepare('SELECT tbl, key, writer, holder_id FROM co_owners')
        .all()
        .map((row) => ({ ...row })),
      [{ tbl: 'claims', key: 'c1', writer: 'place', holder_id: OTHER }]
    );
  } finally {
    handle.close();
  }
});

test('a claim link the database writes after the step gets the id of its claim and source', () => {
  // Catches: the id trigger left reading the dropped owner_file, which fails every insert of a link.
  const handle = openMemoryDb(seededAt54());
  try {
    const db = dbOf(handle);
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
