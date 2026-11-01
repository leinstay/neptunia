// Schema v22 of the memory database (PR 7e): `skill_uses`, the stored text of a skill version, and the tool rows the
// v11 registry may have written, which the data step clears. A v21 database is made by opening with the first 21
// migrations. Synthetic rows, temporary files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MIGRATIONS, openMemoryDb } from '../src/memory/db/open.ts';
import { tempDir } from './fixtures/tmp.ts';

type Db = {
  prepare(sql: string): {
    get(...p: Array<unknown>): Record<string, unknown> | undefined;
    all(...p: Array<unknown>): Array<Record<string, unknown>>;
    run(...p: Array<unknown>): unknown;
  };
};
// open.js types the connection as `object`; it is node:sqlite's DatabaseSync, which has every method Db names.
const dbOf = (handle: { db: object }): Db => handle.db as Db;

const columns = (db: Db, table: string): Array<string> =>
  db
    .prepare(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((row) => String(row.name));

test('a database at v21 gets skill_uses with its columns and the stored text of a version', () => {
  const file = path.join(tempDir('nep-v22-'), 'memory.db');
  openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 21) }).close();
  const handle = openMemoryDb(file);
  try {
    assert.deepEqual(columns(dbOf(handle), 'skill_uses'), ['id', 'skill', 'version_id', 'turn_id', 'kind', 'at']);
    assert.ok(columns(dbOf(handle), 'skill_versions').includes('source'));
  } finally {
    handle.close();
  }
});

test('the tool rows a v21 registry wrote are gone after the migration and the tables stay usable', () => {
  const file = path.join(tempDir('nep-v22-rows-'), 'memory.db');
  const old = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 21) });
  const db = dbOf(old);
  db.prepare(
    "INSERT INTO skills (id, name, active_version, lifecycle, pinned) VALUES ('skill:web.read', 'web.read', NULL, 'active', 0)"
  ).run();
  db.prepare(
    `INSERT INTO skill_versions (id, skill_id, version, content_hash, manifest_hash, commit_sha, status, created_at, manifest)
     VALUES ('skillver:web.read:1', 'skill:web.read', 'v', 'h', 'm', 'c', 'active', '2026-10-31T00:00:00.000Z', '{}')`
  ).run();
  db.prepare(
    `INSERT INTO skill_evaluations (id, version_id, kind, passed, at, content_hash, manifest_hash, commit_sha)
     VALUES ('e1', 'skillver:web.read:1', 'tests', 1, '2026-10-31T00:00:00.000Z', 'h', 'm', 'c')`
  ).run();
  old.close();
  const handle = openMemoryDb(file);
  try {
    for (const table of ['skills', 'skill_versions', 'skill_evaluations']) {
      assert.equal(dbOf(handle).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 0, table);
    }
  } finally {
    handle.close();
  }
});

test('skill_uses refuses a kind outside the six and a version that does not exist', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    db.prepare(
      "INSERT INTO skills (id, name, active_version, lifecycle, pinned) VALUES ('skill:a-b', 'a-b', NULL, 'active', 0)"
    ).run();
    db.prepare(
      `INSERT INTO skill_versions (id, skill_id, version, content_hash, manifest_hash, commit_sha, status, created_at, manifest)
       VALUES ('v1', 'skill:a-b', 'v', 'h', 'm', 'skill-file', 'candidate', '2026-11-01T00:00:00.000Z', '{}')`
    ).run();
    const insert = (version: string, kind: string) =>
      db
        .prepare(
          "INSERT INTO skill_uses (skill, version_id, turn_id, kind, at) VALUES ('a-b', ?, 't1', ?, '2026-11-01T00:00:00.000Z')"
        )
        .run(version, kind);
    insert('v1', 'declined');
    assert.throws(() => insert('v1', 'liked'));
    assert.throws(() => insert('v-missing', 'read'));
  } finally {
    handle.close();
  }
});
