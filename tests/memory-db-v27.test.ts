// Schema v27: the mirrors' configuration columns and the delivery state of a publication, on a database that already
// holds publications. `publications` is rebuilt for its status CHECK, so every row, every trigger and the graph's view of
// a row must come through the rebuild. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MIGRATIONS, openMemoryDb, schemaVersion } from '../src/memory/db/open.ts';
import { createMirrorDesk } from '../src/behavior/mirror-desk.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { tempDir } from './fixtures/tmp.ts';

const AT = '2020-01-01T12:00:00.000Z';
const PLACE = 'fake:channel:d1';
const OTHER = 'fake:channel:d2';

/** What v26 holds: a mirror, and one publication in each state an old database can have. */
function seedV26(db: Db): void {
  for (const [id, native] of [
    [PLACE, 'd1'],
    [OTHER, 'd2'],
  ] as const)
    db.prepare(
      "INSERT INTO places (id, iface, kind, native_id, parent_id, scope_kind, name) VALUES (?, 'fake', 'channel', ?, NULL, 'group', ?)"
    ).run(id, native, native);
  db.prepare(
    "INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by, extra) VALUES ('m1', 'diary', ?, 1, ?, 'owner', NULL)"
  ).run(PLACE, AT);
  const receipts = JSON.stringify([{ authority: 'fake', kind: 'message', key: 'old-1' }]);
  const insert = db.prepare(
    `INSERT INTO publications (id, row_kind, row_id, content_hash, rendered, destination_place_id, status, idempotency_key, receipts, created_at, sent_at)
     VALUES (?, 'diary', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insert.run('p-sent', 'e-sent', 'h1', 'sent text', PLACE, 'sent', 'k-sent', receipts, AT, AT);
  insert.run('p-queued', 'e-queued', 'h2', 'queued text', PLACE, 'queued', 'k-queued', null, AT, null);
  insert.run('p-pending', 'e-pending', null, null, PLACE, 'queued', 'k-pending', null, AT, null);
  insert.run('p-unknown', 'e-unknown', 'h3', 'lost text', PLACE, 'unknown', 'k-unknown', null, AT, null);
  insert.run('p-failed', 'e-failed', 'h4', 'failed text', PLACE, 'failed', 'k-failed', null, AT, null);
}

/** A database file at v26 with the seed, and a reopen at the newest version. */
function migrated() {
  const file = path.join(tempDir('v27'), 'memory.db');
  const old = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 26) });
  seedV26(dbOf(old));
  const before = dbOf(old).prepare('SELECT * FROM publications ORDER BY id').all();
  old.close();
  const handle = openMemoryDb(file);
  return { handle, db: dbOf(handle), before };
}

test('every publication comes through the rebuild as it was, in its own state', () => {
  // Catches: a rebuild that drops a column, a row or a pending row's empty content.
  const { handle, db, before } = migrated();
  try {
    assert.equal(schemaVersion(db), MIGRATIONS.length);
    const after = db.prepare('SELECT * FROM publications ORDER BY id').all();
    assert.equal(after.length, 5);
    for (const [index, row] of before.entries())
      for (const [key, value] of Object.entries(row)) assert.equal(after[index]?.[key], value, key);
  } finally {
    handle.close();
  }
});

test('the rebuilt table takes the new states and refuses a state it does not know', () => {
  // Catches: the CHECK left as it was, which makes the first claim throw on a live database.
  const { handle, db } = migrated();
  try {
    const set = db.prepare("UPDATE publications SET status = ? WHERE id = 'p-queued'");
    set.run('sending');
    set.run('incomplete');
    assert.throws(() => set.run('lost'));
  } finally {
    handle.close();
  }
});

test('the rules of a publication hold after the rebuild', () => {
  // Catches: the triggers gone with the old table, so a sent text can be rewritten or a row deleted.
  const { handle, db } = migrated();
  try {
    assert.throws(() =>
      db.prepare("UPDATE publications SET rendered = 'other', content_hash = 'h9' WHERE id = 'p-sent'").run()
    );
    assert.throws(() => db.prepare("UPDATE publications SET idempotency_key = 'k-9' WHERE id = 'p-sent'").run());
    assert.throws(() => db.prepare("DELETE FROM publications WHERE id = 'p-sent'").run());
  } finally {
    handle.close();
  }
});

test('an old mirror keeps its row, with an old unknown send reading as uncertain and a legacy receipt in its segments', () => {
  // Catches: an old mirror unreadable by the new status, or an old `unknown` that no reader reports.
  const { handle, db } = migrated();
  try {
    const desk = createMirrorDesk({
      memoryDb: { readHandle: () => ({ db }), memoryWrite: () => Promise.reject(new Error('no write here')) },
      database: () => db,
      port: () => null,
      now: () => Date.parse(AT),
    });
    const [status] = desk.mirrorStatus();
    assert.equal(status?.placeId, PLACE);
    assert.equal(status?.queued, 2);
    assert.deepEqual(status?.uncertain, [{ entryId: 'e-unknown' }]);
    assert.deepEqual(status?.failed, [{ entryId: 'e-failed', code: null, retryable: false }]);
    assert.equal(status?.backfill.enabled, false);
    assert.equal(desk.publicationState('e-unknown', PLACE)?.status, 'uncertain');
    assert.deepEqual(desk.publicationState('e-sent', PLACE)?.segments[0]?.messageIds, ['old-1']);
  } finally {
    handle.close();
  }
});

test('an existing mirror counts as registered at the migration, so an old entry waits for backfill', () => {
  // Catches: `created_at` read as the registration, which posts every entry since then at the first drain after a deploy.
  const { handle, db } = migrated();
  try {
    const row = db.prepare("SELECT registered_at FROM mirrors WHERE id = 'm1'").get();
    assert.ok(Number(row?.registered_at) > Date.parse(AT));
  } finally {
    handle.close();
  }
});
