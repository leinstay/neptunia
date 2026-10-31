// Tests for the memory part of `/health` (src/health/memory.ts#memoryHealth) over a fixture memory database written
// row by row: the people who spoke within the window and about whom nothing was written in it, the claims that change
// too often, and the newest backup. The clock is the fixed NOW; no core runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openMemoryDb } from '../src/memory/db/open.js';
import { memoryHealth } from '../src/health/memory.ts';
import { tempDir } from './fixtures/tmp.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString();

/** A fresh memory database and its connection. */
function fixture(): { db: DatabaseSync; close: () => void; dir: string } {
  const dir = tempDir('health-memory-');
  const handle = openMemoryDb(join(dir, 'memory.db'), { context: { dataDir: dir } });
  return { db: handle.db as DatabaseSync, close: () => handle.close(), dir };
}

/** A person with one account who last spoke `spokeDaysAgo` days ago, with a `seen` line of theirs at that time. */
function person(db: DatabaseSync, id: string, spokeDaysAgo: number): void {
  db.prepare('INSERT INTO people (id, kind, first_seen_at, last_seen_at, message_count) VALUES (?, ?, ?, ?, ?)').run(
    id,
    'person',
    iso(90),
    iso(spokeDaysAgo),
    10
  );
  db.prepare('INSERT INTO accounts (id, iface, native_id, person_id) VALUES (?, ?, ?, ?)').run(
    `acc-${id}`,
    'fake',
    `n-${id}`,
    id
  );
  db.prepare(
    'INSERT INTO sources (id, kind, iface, native_id, author_account, occurred_at, recorded_at, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(`src-${id}`, 'seen', 'fake', `msg-${id}`, `acc-${id}`, iso(spokeDaysAgo), iso(spokeDaysAgo), 'a line');
}

/** A claim about `personId`, created and last seen `daysAgo` days ago, with `versions` versions recorded then. */
function claim(db: DatabaseSync, id: string, personId: string, daysAgo: number, versions = 1): void {
  db.prepare(
    'INSERT INTO claims (id, subject_kind, subject_id, kind, text, first_seen_at, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, 'person', personId, 'fact', 'likes chess', iso(daysAgo), iso(daysAgo), iso(daysAgo));
  for (let n = 0; n < versions; n += 1)
    db.prepare('INSERT INTO claim_versions (id, claim_id, text, recorded_at, event) VALUES (?, ?, ?, ?, ?)').run(
      `${id}-v${n}`,
      id,
      `likes chess ${n}`,
      new Date(NOW - daysAgo * DAY + n * 60_000).toISOString(),
      'update'
    );
}

test('names a person who spoke in the last seven days and about whom nothing was written in that time', () => {
  const { db, close } = fixture();
  try {
    person(db, 'p-silent', 2);
    claim(db, 'c-old', 'p-silent', 20);
    person(db, 'p-written', 2);
    claim(db, 'c-new', 'p-written', 1);
    person(db, 'p-away', 30);
    claim(db, 'c-away', 'p-away', 40);
    const health = memoryHealth(db, { now: NOW, days: 7, backupsDir: null });
    assert.deepEqual(
      health.silent.map((row) => row.personId),
      ['p-silent']
    );
    assert.ok(health.text.includes('p-silent'), 'the text names the person');
  } finally {
    close();
  }
});

test('names no one in an empty database', () => {
  const { db, close } = fixture();
  try {
    const health = memoryHealth(db, { now: NOW, days: 7, backupsDir: null });
    assert.deepEqual(health.silent, []);
    assert.deepEqual(health.churning, []);
  } finally {
    close();
  }
});

test('names a claim with twenty versions in the window and not a claim with one', () => {
  const { db, close } = fixture();
  try {
    person(db, 'p1', 1);
    claim(db, 'c-churn', 'p1', 3, 20);
    claim(db, 'c-quiet', 'p1', 3, 1);
    const health = memoryHealth(db, { now: NOW, days: 7, backupsDir: null });
    assert.deepEqual(
      health.churning.map((row) => [row.claimId, row.versions]),
      [['c-churn', 20]]
    );
  } finally {
    close();
  }
});

test('the versions of a claim recorded before the window do not make it churn', () => {
  const { db, close } = fixture();
  try {
    person(db, 'p1', 1);
    claim(db, 'c-past', 'p1', 30, 20);
    assert.deepEqual(memoryHealth(db, { now: NOW, days: 7, backupsDir: null }).churning, []);
  } finally {
    close();
  }
});

test('the last backup is the newest finished one in the backups folder, and none without a folder', () => {
  const { db, close, dir } = fixture();
  try {
    const backups = join(dir, 'backups');
    for (const name of ['2026-10-29-030000-memory', '2026-10-30-030000-memory']) {
      mkdirSync(join(backups, name), { recursive: true });
      writeFileSync(join(backups, name, 'manifest.json'), '{}\n');
    }
    // A folder without a manifest is an unfinished backup.
    mkdirSync(join(backups, '2026-10-31-030000-memory'));
    assert.deepEqual(memoryHealth(db, { now: NOW, days: 7, backupsDir: backups }).lastBackup, {
      name: '2026-10-30-030000-memory',
    });
    assert.equal(memoryHealth(db, { now: NOW, days: 7, backupsDir: null }).lastBackup, null);
  } finally {
    close();
  }
});
