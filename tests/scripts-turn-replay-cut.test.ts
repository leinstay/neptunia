// The cut of a data copy at a turn's start (scripts/lib/turn-cut.ts): what memory held when the turn began stays
// readable, what was written at or after it is gone, a revised claim reads its version of that moment, and a copy is
// refused onto a folder that exists or from one a live process holds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cutCopy, cutMemory } from '../scripts/lib/turn-cut.ts';
import { freshMemoryDb } from './fixtures/memory-db-copy.ts';
import { tempDir } from './fixtures/tmp.ts';

const MOMENT = Date.parse('2026-03-04T10:00:00.000Z');
const BEFORE = '2026-03-04T09:59:59.000Z';
const AFTER = '2026-03-04T10:00:01.000Z';

type Db = InstanceType<typeof DatabaseSync>;

function seed(db: Db): void {
  const line = db.prepare(
    `INSERT INTO sources (id, kind, iface, native_id, place_id, text, occurred_at, recorded_at, observed_at)
     VALUES (?, 'seen', 'cli', ?, 'cli:dm:owner', ?, ?, ?, ?)`
  );
  line.run('src:before', 'm-1', 'Καλημέρα', BEFORE, BEFORE, BEFORE);
  line.run('src:after', 'm-2', 'Καληνύχτα', AFTER, AFTER, AFTER);
  const day = db.prepare(
    `INSERT INTO day (id, at, what, place_id, turn_id, extra) VALUES (?, ?, ?, 'cli:dm:owner', ?, '{}')`
  );
  day.run('day:before', BEFORE, 'turn', 't-old');
  day.run('day:after', AFTER, 'turn', 't-new');
  db.prepare(
    `INSERT INTO claims (id, subject_kind, subject_id, kind, text, first_seen_at, created_at)
     VALUES ('clm:1', 'person', 'person:1', 'fact', 'Μένει στην Αθήνα', ?, ?)`
  ).run(BEFORE, BEFORE);
  const version = db.prepare(`INSERT INTO claim_versions (id, claim_id, text, recorded_at) VALUES (?, 'clm:1', ?, ?)`);
  version.run('cv:1', 'Μένει στη Θεσσαλονίκη', BEFORE);
  version.run('cv:2', 'Μένει στην Αθήνα', AFTER);
}

function ids(db: Db, table: string): Array<string> {
  return db
    .prepare(`SELECT id FROM ${table} ORDER BY id`)
    .all()
    .map((row) => String(row.id));
}

test('hides a line, a day row and a claim version written after the moment and keeps the ones before', () => {
  const handle = freshMemoryDb();
  const db = handle.db as Db;
  seed(db);
  cutMemory(db, MOMENT);
  assert.deepEqual(ids(db, 'sources'), ['src:before']);
  assert.deepEqual(ids(db, 'day'), ['day:before']);
  assert.deepEqual(ids(db, 'claim_versions'), ['cv:1']);
  handle.close();
});

test('turns a claim revised after the moment back to its text of that moment', () => {
  const handle = freshMemoryDb();
  const db = handle.db as Db;
  seed(db);
  cutMemory(db, MOMENT);
  const claim = db.prepare(`SELECT text FROM claims WHERE id = 'clm:1'`).get();
  assert.equal(claim?.text, 'Μένει στη Θεσσαλονίκη');
  handle.close();
});

test('clears a picture description written after the moment and keeps the picture', () => {
  const handle = freshMemoryDb();
  const db = handle.db as Db;
  db.prepare(
    `INSERT INTO media (id, kind, availability, description, described_at) VALUES ('med:1', 'image', 'present', 'Ένας γάτος', ?)`
  ).run(AFTER);
  cutMemory(db, MOMENT);
  const row = db.prepare(`SELECT description, described_at FROM media WHERE id = 'med:1'`).get();
  assert.equal(row?.description, null);
  assert.equal(row?.described_at, null);
  handle.close();
});

// Regression: the first cut of a real copy deleted every claim version whose claim the copy no longer held and every
// picture link of a selfreflection entry, rows the cut itself never touched.
test('keeps the rows that lacked their owner before the cut and the links of other owners', () => {
  const handle = freshMemoryDb();
  const db = handle.db as Db;
  seed(db);
  db.prepare(
    `INSERT INTO claim_versions (id, claim_id, text, recorded_at) VALUES ('cv:old', 'clm:gone', 'Παλιά', ?)`
  ).run(BEFORE);
  db.prepare(
    `INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('selfreflection', 'sr:1', 0, 'med:1')`
  ).run();
  cutMemory(db, MOMENT);
  assert.deepEqual(ids(db, 'claim_versions'), ['cv:1', 'cv:old']);
  const links = db.prepare(`SELECT COUNT(*) AS n FROM media_links WHERE owner_id = 'sr:1'`).get();
  assert.equal(links?.n, 1);
  handle.close();
});

/** A data folder with a memory database holding one turn start at MOMENT, its lines and a settings file. */
function sourceFolder(): string {
  const root = tempDir('nep-turn-cut-');
  const from = path.join(root, 'data');
  fs.mkdirSync(path.join(from, 'config'), { recursive: true });
  fs.writeFileSync(path.join(from, 'config', 'config.json'), '{}');
  const handle = freshMemoryDb();
  const db = handle.db as Db;
  seed(db);
  db.prepare(
    `INSERT INTO day (id, at, what, place_id, turn_id, extra) VALUES ('day:start', ?, 'turn.start', 'cli:dm:owner', 't-cut', '{}')`
  ).run(new Date(MOMENT).toISOString());
  handle.close();
  fs.copyFileSync(handle.path, path.join(from, 'memory.db'));
  return from;
}

test('writes a copy cut at the turn start with the files of the folder beside it', () => {
  const from = sourceFolder();
  const into = path.join(path.dirname(from), 'data-cut');
  cutCopy({ from, into, turnId: 't-cut', alive: () => false });
  assert.ok(fs.existsSync(path.join(into, 'config', 'config.json')));
  const db = new DatabaseSync(path.join(into, 'memory.db'), { readOnly: true });
  assert.deepEqual(ids(db, 'sources'), ['src:before']);
  db.close();
  const original = new DatabaseSync(path.join(from, 'memory.db'), { readOnly: true });
  assert.deepEqual(ids(original, 'sources'), ['src:after', 'src:before']);
  original.close();
});

// Regression: the first copies lost the start row of the very turn they were cut for, so the turn could not be replayed.
test('keeps the start row of the turn the copy is cut for and drops the other rows of that moment', () => {
  const from = sourceFolder();
  const into = path.join(path.dirname(from), 'data-cut');
  cutCopy({ from, into, turnId: 't-cut', alive: () => false });
  const db = new DatabaseSync(path.join(into, 'memory.db'), { readOnly: true });
  assert.deepEqual(ids(db, 'day'), ['day:before', 'day:start']);
  db.close();
});

test('refuses a target folder that exists', () => {
  const from = sourceFolder();
  const into = path.join(path.dirname(from), 'data-cut');
  fs.mkdirSync(into);
  assert.throws(() => cutCopy({ from, into, turnId: 't-cut', alive: () => false }), /exists/);
});

test('refuses a source whose lock names a live process', () => {
  const from = sourceFolder();
  fs.writeFileSync(path.join(from, 'memory.db.lock'), JSON.stringify({ pid: 4242, startedAt: BEFORE }));
  const into = path.join(path.dirname(from), 'data-cut');
  assert.throws(() => cutCopy({ from, into, turnId: 't-cut', alive: (pid) => pid === 4242 }), /4242/);
  assert.equal(fs.existsSync(into), false);
});

test('refuses a turn the day table does not hold', () => {
  const from = sourceFolder();
  const into = path.join(path.dirname(from), 'data-cut');
  assert.throws(() => cutCopy({ from, into, turnId: 't-unknown', alive: () => false }), /t-unknown/);
});
