// Tests for src/memory/db/open.js and schema.js: migrations, the writer lock, read-only mode and the FTS triggers,
// over temporary files (never the deployment's data/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS, lockPathOf, openMemoryDb, schemaVersion } from '../src/memory/db/open.js';
import { V1_TABLES } from '../src/memory/db/schema.js';
import { tempDir } from './fixtures/tmp.js';

const names = (db, type = 'table') =>
  db
    .prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name')
    .all(type)
    .map((row) => row.name);

test('a new database is migrated to the latest version with every table of schema v1', () => {
  const handle = openMemoryDb(':memory:');
  assert.equal(schemaVersion(handle.db), MIGRATIONS.length);
  const tables = names(handle.db);
  for (const table of V1_TABLES) assert.ok(tables.includes(table), `${table} is missing`);
  assert.ok(!tables.includes('now'));
  assert.ok(!tables.includes('states'));
  handle.close();
});

test('the ledger tables are reserved and empty', () => {
  const handle = openMemoryDb(':memory:');
  for (const table of names(handle.db).filter((name) => name.startsWith('ledger_'))) {
    assert.equal(handle.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  }
  assert.equal(names(handle.db).filter((name) => name.startsWith('ledger_')).length, 8);
  handle.close();
});

test('a file database runs in WAL with foreign keys on and reopens without migrating twice', () => {
  const dir = tempDir('nep-memdb-');
  const file = path.join(dir, 'memory.db');
  const first = openMemoryDb(file);
  assert.equal(first.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(first.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.ok(first.db.prepare('PRAGMA busy_timeout').get().timeout > 0);
  first.db.prepare("INSERT INTO meta (key, value) VALUES ('k', 'v')").run();
  first.close();
  const second = openMemoryDb(file);
  assert.equal(second.db.prepare('SELECT COUNT(*) AS n FROM schema_version').get().n, MIGRATIONS.length);
  assert.equal(second.db.prepare("SELECT value FROM meta WHERE key = 'k'").get().value, 'v');
  second.close();
});

test('a later migration is applied on top and the shipped ones are not run again', () => {
  const dir = tempDir('nep-memdb-');
  const file = path.join(dir, 'memory.db');
  openMemoryDb(file).close();
  const next = [...MIGRATIONS, 'CREATE TABLE extra_table (id TEXT PRIMARY KEY);'];
  const handle = openMemoryDb(file, { migrations: next });
  assert.equal(schemaVersion(handle.db), MIGRATIONS.length + 1);
  assert.ok(names(handle.db).includes('extra_table'));
  handle.close();
});

test('a failing migration rolls back whole and leaves the version where it was', () => {
  const dir = tempDir('nep-memdb-');
  const file = path.join(dir, 'memory.db');
  openMemoryDb(file).close();
  const broken = [...MIGRATIONS, 'CREATE TABLE half (id TEXT); THIS IS NOT SQL;'];
  assert.throws(() => openMemoryDb(file, { migrations: broken }));
  const handle = openMemoryDb(file);
  assert.equal(schemaVersion(handle.db), MIGRATIONS.length);
  assert.ok(!names(handle.db).includes('half'));
  handle.close();
});

test('transaction commits on return and rolls back on a throw', () => {
  const handle = openMemoryDb(':memory:');
  handle.transaction(() => handle.db.prepare("INSERT INTO meta (key, value) VALUES ('a', 1)").run());
  assert.throws(
    () =>
      handle.transaction(() => {
        handle.db.prepare("INSERT INTO meta (key, value) VALUES ('b', 2)").run();
        throw new Error('boom');
      }),
    /boom/
  );
  const keys = handle.db
    .prepare('SELECT key FROM meta ORDER BY key')
    .all()
    .map((row) => row.key);
  assert.deepEqual(keys, ['a']);
  assert.equal(
    handle.transaction(() => 7),
    7
  );
  handle.close();
});

test('the writer lock holds the pid and start time and goes away on close', () => {
  const dir = tempDir('nep-memdb-');
  const file = path.join(dir, 'memory.db');
  const handle = openMemoryDb(file, { pid: 4242, now: () => Date.UTC(2026, 9, 24, 8, 0, 0), alive: () => false });
  const lock = JSON.parse(fs.readFileSync(lockPathOf(file), 'utf8'));
  assert.deepEqual(lock, { pid: 4242, startedAt: '2026-10-24T08:00:00.000Z' });
  handle.close();
  assert.ok(!fs.existsSync(lockPathOf(file)));
});

test('a lock of a live pid refuses with a clear error and leaves the lock alone', () => {
  const dir = tempDir('nep-memdb-');
  const file = path.join(dir, 'memory.db');
  fs.writeFileSync(lockPathOf(file), JSON.stringify({ pid: 777, startedAt: '2026-10-24T07:00:00.000Z' }));
  assert.throws(() => openMemoryDb(file, { pid: 1, alive: (pid) => pid === 777 }), /locked by pid 777/);
  assert.equal(JSON.parse(fs.readFileSync(lockPathOf(file), 'utf8')).pid, 777);
});

test('a lock of a dead pid, or an unreadable one, is taken over', () => {
  const dir = tempDir('nep-memdb-');
  const file = path.join(dir, 'memory.db');
  fs.writeFileSync(lockPathOf(file), JSON.stringify({ pid: 777, startedAt: 'x' }));
  const first = openMemoryDb(file, { pid: 11, alive: () => false });
  assert.equal(JSON.parse(fs.readFileSync(lockPathOf(file), 'utf8')).pid, 11);
  first.close();
  fs.writeFileSync(lockPathOf(file), 'not json');
  const second = openMemoryDb(file, { pid: 12, alive: () => true });
  assert.equal(JSON.parse(fs.readFileSync(lockPathOf(file), 'utf8')).pid, 12);
  second.close();
});

test('the real process check: this process holds the lock, a second open in it refuses', () => {
  const dir = tempDir('nep-memdb-');
  const file = path.join(dir, 'memory.db');
  const handle = openMemoryDb(file);
  assert.throws(() => openMemoryDb(file), /locked by pid/);
  handle.close();
  openMemoryDb(file).close();
});

test('a close that lost its lock to another process leaves the other lock in place', () => {
  const dir = tempDir('nep-memdb-');
  const file = path.join(dir, 'memory.db');
  const handle = openMemoryDb(file, { pid: 5, alive: () => false });
  fs.writeFileSync(lockPathOf(file), JSON.stringify({ pid: 6, startedAt: 'x' }));
  handle.close();
  assert.equal(JSON.parse(fs.readFileSync(lockPathOf(file), 'utf8')).pid, 6);
});

test('read-only mode takes no lock, reads while a writer holds the file, and refuses to write', () => {
  const dir = tempDir('nep-memdb-');
  const file = path.join(dir, 'memory.db');
  const writer = openMemoryDb(file);
  writer.db.prepare("INSERT INTO meta (key, value) VALUES ('k', 'v')").run();
  const reader = openMemoryDb(file, { readOnly: true });
  assert.equal(reader.db.prepare("SELECT value FROM meta WHERE key = 'k'").get().value, 'v');
  assert.throws(() => reader.db.prepare("INSERT INTO meta (key, value) VALUES ('x', 1)").run());
  assert.throws(() => reader.transaction(() => 1), /read-only/);
  assert.equal(JSON.parse(fs.readFileSync(lockPathOf(file), 'utf8')).pid, process.pid);
  reader.close();
  assert.ok(fs.existsSync(lockPathOf(file)), 'closing a reader leaves the writer lock');
  writer.close();
});

test('read-only mode of a file that does not exist throws', () => {
  const dir = tempDir('nep-memdb-');
  assert.throws(() => openMemoryDb(path.join(dir, 'missing.db'), { readOnly: true }));
});

test('closing twice is harmless', () => {
  const handle = openMemoryDb(':memory:');
  handle.close();
  handle.close();
});

const insertSource = (db, id, text, stems = null) =>
  db
    .prepare("INSERT INTO sources (id, kind, text, stems, scope_kind) VALUES (?, 'seen', ?, ?, 'group')")
    .run(id, text, stems).lastInsertRowid;
const wordHits = (db, query) =>
  db
    .prepare(
      'SELECT s.id FROM sources_fts f JOIN sources s ON s.rowid = f.rowid WHERE sources_fts MATCH ? ORDER BY s.id'
    )
    .all(query)
    .map((row) => row.id);
const triHits = (db, query) =>
  db
    .prepare(
      'SELECT s.id FROM sources_tri f JOIN sources s ON s.rowid = f.rowid WHERE sources_tri MATCH ? ORDER BY s.id'
    )
    .all(query)
    .map((row) => row.id);

test('triggers keep the word and trigram indexes in step with sources', () => {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
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
  insertSource(handle.db, 'a', null);
  assert.throws(() => insertSource(handle.db, 'a', 'again'), /UNIQUE/);
  handle.close();
});

test('FTS5 words in Greek and accented Latin are found', () => {
  const handle = openMemoryDb(':memory:');
  insertSource(handle.db, 'g', 'Καλημέρα κόσμε', 'καλημερα κοσμε');
  assert.deepEqual(wordHits(handle.db, 'καλημερα'), ['g']);
  assert.deepEqual(triHits(handle.db, 'ημέρ'), ['g']);
  handle.close();
});
