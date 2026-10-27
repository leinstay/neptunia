// Schema v15 (stage 3 design, section 5): the `mirrors` table, and a data step that seeds the diary's one mirror from
// the deployment's diary channel. The opener passes that channel's place as `context.diaryPlaceId`, the same context v12
// uses. Opened without it (a tool), the step leaves the meta key `diary_mirror_pending`, and the first open that knows
// the channel seeds the row. A database at v14 here holds the legacy diary and its `diary_mirrors` history from the
// data directory fixture. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS, openMemoryDb } from '../src/memory/db/open.js';
import { channelPlaceId } from '../src/memory/db/ids.ts';
import { seedUnits } from './fixtures/memory-db/seed.js';
import { CHANNEL, buildDataDir } from './fixtures/memory-db/datadir.js';
import { tempDir } from './fixtures/tmp.js';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const PLACE = channelPlaceId('discord', CHANNEL);
const PENDING = 'diary_mirror_pending';

type Row = Record<string, unknown>;
type Db = { prepare(sql: string): { all(...params: Array<unknown>): Array<Row> } };

/** The node:sqlite connection of an `openMemoryDb` handle (open.js is untyped JS). */
const dbOf = (handle: { db: unknown }): Db => handle.db as Db;

/** A database file at schema v14 that holds the legacy diary with its `diary_mirrors` history. */
function v14File(): string {
  const data = path.join(tempDir('nep-v15-'), 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const file = path.join(data, 'memory.db');
  const old = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 14) });
  try {
    seedUnits(old, data, { now: () => NOW });
    assert.ok(
      dbOf(old).prepare('SELECT COUNT(*) AS n FROM diary_mirrors').all()[0]?.n !== 0,
      'the fixture holds mirror history'
    );
  } finally {
    old.close();
  }
  return file;
}

/** What one open of `file` leaves: the mirror rows and the pending key. */
function openAndRead(file: string, context: { diaryPlaceId?: string | null } = {}) {
  const handle = openMemoryDb(file, { context });
  try {
    const db = dbOf(handle);
    return {
      mirrors: db
        .prepare('SELECT id, row_kind, place_id, enabled, created_at, created_by, extra FROM mirrors ORDER BY id')
        .all(),
      pending: db.prepare('SELECT value FROM meta WHERE key = ?').all(PENDING).length > 0,
    };
  } finally {
    handle.close();
  }
}

test('on a v14 database with mirror history and a known diary channel the step seeds one mirror the owner made', () => {
  const after = openAndRead(v14File(), { diaryPlaceId: PLACE });
  assert.deepEqual(
    after.mirrors.map((row) => [row.row_kind, row.place_id, row.enabled, row.created_by]),
    [['diary', PLACE, 1, 'owner']]
  );
  assert.equal(after.pending, false);
});

test('a second open with the channel changes no mirror row', () => {
  const file = v14File();
  const first = openAndRead(file, { diaryPlaceId: PLACE });
  const second = openAndRead(file, { diaryPlaceId: PLACE });
  assert.deepEqual(second.mirrors, first.mirrors);
});

test('opened without the channel the step seeds nothing and leaves the pending key', () => {
  const after = openAndRead(v14File());
  assert.deepEqual(after.mirrors, []);
  assert.equal(after.pending, true);
});

test('the first open that knows the channel after a pending one seeds the mirror and clears the key', () => {
  const file = v14File();
  openAndRead(file);
  const after = openAndRead(file, { diaryPlaceId: PLACE });
  assert.deepEqual(
    after.mirrors.map((row) => [row.row_kind, row.place_id, row.enabled, row.created_by]),
    [['diary', PLACE, 1, 'owner']]
  );
  assert.equal(after.pending, false);
});
