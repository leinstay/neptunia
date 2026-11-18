// Schema step 67 (src/memory/db/schema.ts), which gives a stored edit the moment of its line's first revision, on a database written at the newest
// version before it, where an edit row carries the moment the edit arrived. After the step a read that orders lines
// stands the edited line where it was written, with the newest text, and the neighbours read of recall is bounded by
// `sources_place_time`. Each test builds the old file with the steps up to that version, fills it with raw SQL as the
// writer of that version left it, and opens it with the current code. Temporary files, invented ids, synthetic text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, openMemoryDb } from '../src/memory/db/open.ts';
import { BASELINE_VERSION } from '../src/memory/db/schema-baseline.ts';
import { chatLines } from '../src/memory/db/chat-lines.ts';
import { window } from '../src/memory/db/recall.ts';
import { groupContext } from '../src/memory/db/scope.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Statement } from '../src/memory/db/types.ts';
import { filledRows } from './fixtures/memory-db/schema-shape.ts';
import { tempDir } from './fixtures/tmp.ts';

/** The newest schema version before the step. */
const BEFORE_STEP = 66;
const PLACE = 'fake:channel:room';
const T0 = Date.parse('2026-11-12T01:00:00.000Z');
const MINUTE = 60_000;
const iso = (minutes: number): string => new Date(T0 + minutes * MINUTE).toISOString();

/** One `sources` row of `PLACE` as raw SQL. */
const line = (id: string, native: string, revision: number, minutes: number, text: string): string =>
  `('${id}', 'seen', 'fake', '${native}', 'message', ${revision}, '${PLACE}', 'fake:member', 'account',
    '${iso(minutes)}', '${iso(minutes)}', '${text}', 'group', 'fake', NULL)`;

/**
 * Six lines a minute apart, `l0` to `l5`, and two edits stored at the moment they arrived: `l1` edited 93 minutes
 * later, and `l3` edited twice, 40 and 50 minutes later.
 */
const ROWS = `
INSERT INTO places (id, iface, kind, native_id, chat, scope_kind) VALUES ('${PLACE}', 'fake', 'channel', 'room', 'group', 'group');
INSERT INTO sources (id, kind, iface, native_id, native_kind, revision, place_id, author_account, author_kind,
  occurred_at, recorded_at, text, scope_kind, scope_iface, scope_dm) VALUES
  ${line('src:l0', 'l0', 1, 0, 'line zero')},
  ${line('src:l1', 'l1', 1, 1, 'line one')},
  ${line('src:l2', 'l2', 1, 2, 'line two')},
  ${line('src:l3', 'l3', 1, 3, 'line three')},
  ${line('src:l4', 'l4', 1, 4, 'line four')},
  ${line('src:l5', 'l5', 1, 5, 'line five')},
  ${line('src:l1:2', 'l1', 2, 94, 'line one, fixed')},
  ${line('src:l3:2', 'l3', 2, 43, 'line three, fixed')},
  ${line('src:l3:3', 'l3', 3, 53, 'line three, fixed again')};
`;

/** A database file at `BEFORE_STEP` holding `sql`, written with raw SQL after the steps up to that version. */
function oldFile(sql: string): string {
  const file = path.join(tempDir('nep-edit-moment-'), 'memory.db');
  openMemoryDb(file, { migrations: MIGRATIONS.slice(0, BEFORE_STEP - BASELINE_VERSION) }).close();
  const raw = new DatabaseSync(file);
  try {
    assert.equal(raw.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v, BEFORE_STEP);
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

/** `db` with every statement it runs kept as its SQL and parameters. */
function planRecording(db: Db): { db: Db; ran: Array<{ sql: string; params: Array<unknown> }> } {
  const ran: Array<{ sql: string; params: Array<unknown> }> = [];
  const prepare = (sql: string): Statement => {
    const statement = db.prepare(sql);
    const note = (params: Array<unknown>): void => {
      ran.push({ sql, params });
    };
    return {
      get: (...params) => (note(params), statement.get(...params)),
      all: (...params) => (note(params), statement.all(...params)),
      run: (...params) => (note(params), statement.run(...params)),
      iterate: (...params) => (note(params), statement.iterate(...params)),
    };
  };
  return { db: { prepare, exec: (sql) => db.exec(sql) }, ran };
}

/** A walk of every row of a place, or of every row of `sources`. */
const WHOLE_PLACE = /^SEARCH s USING (COVERING )?INDEX sources_place_time \(place_id=\?\)$|^SCAN (s|t|sources)\b/;

/** The `sources` rows that are the first revision of their line, as JSON, in id order. */
const firstRevisions = (db: Db): Array<string> =>
  db
    .prepare('SELECT * FROM sources WHERE revision = 1 ORDER BY id')
    .all()
    .map((row) => JSON.stringify(row));

test('an old database opens past the step', () => {
  // Bug: the step is missing, so a database the old writer left keeps its edits at the moment they arrived.
  const file = oldFile(ROWS);
  const version = opened(file, (db) => db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v);
  assert.equal(Number(version) > BEFORE_STEP, true);
});

test('after the step every edited line reads where it was written, with its newest text', () => {
  // Bug: the step moves an edit to the wrong revision's moment, or a line edited twice reads at its second edit.
  const file = oldFile(ROWS);
  const lines = opened(file, (db) => chatLines(db, PLACE).map((one) => [one.nativeId, one.text, one.at]));
  assert.deepEqual(lines, [
    ['l0', 'line zero', T0],
    ['l1', 'line one, fixed', T0 + MINUTE],
    ['l2', 'line two', T0 + 2 * MINUTE],
    ['l3', 'line three, fixed again', T0 + 3 * MINUTE],
    ['l4', 'line four', T0 + 4 * MINUTE],
    ['l5', 'line five', T0 + 5 * MINUTE],
  ]);
});

test('after the step each edit stands at its first revision and keeps the moment it arrived', () => {
  // Bug: the step dates an edit by a later revision, or overwrites the moment the edit arrived along with its place.
  const file = oldFile(ROWS);
  const edits = opened(file, (db) =>
    db
      .prepare('SELECT id, occurred_at, recorded_at FROM sources WHERE revision > 1 ORDER BY id')
      .all()
      .map((row) => [row.id, row.occurred_at, row.recorded_at])
  );
  assert.deepEqual(edits, [
    ['src:l1:2', iso(1), iso(94)],
    ['src:l3:2', iso(3), iso(43)],
    ['src:l3:3', iso(3), iso(53)],
  ]);
});

test('after the step an edited line is marked edited at the moment its newest edit arrived', () => {
  // Bug: the edited mark follows the corrected moment, so an old edit reads as made when the line was written.
  const file = oldFile(ROWS);
  const marks = opened(file, (db) => chatLines(db, PLACE).map((one) => [one.nativeId, one.editedAt ?? null]));
  assert.deepEqual(marks, [
    ['l0', null],
    ['l1', T0 + 94 * MINUTE],
    ['l2', null],
    ['l3', T0 + 53 * MINUTE],
    ['l4', null],
    ['l5', null],
  ]);
});

test('after the step a window around an old edit reads its neighbours without a walk of the place', () => {
  // Bug (report 2026-11-18-reply-latency): an edit row the step left at the moment it arrived still needs the first
  // revision's moment computed per row, so the neighbours read walks every line of the place.
  const file = oldFile(ROWS);
  const { ids, walks } = opened(file, (db) => {
    const { db: recorded, ran } = planRecording(db);
    const down = window(recorded, { ctx: groupContext('fake'), anchor: 'l0', move: 'down', messages: 3 });
    const plans = ran.flatMap(({ sql, params }) =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...params)
        .map((row) => String(row.detail))
    );
    return {
      ids: down.windows.flatMap((one) => one.messages).map((message) => message.id),
      walks: plans.filter((detail) => WHOLE_PLACE.test(detail)),
    };
  });
  assert.deepEqual(ids, ['l1', 'l2', 'l3']);
  assert.deepEqual(walks, []);
});

test('the step leaves every first revision as it was', () => {
  // Bug: the step rewrites the moment or another column of a row that is no edit.
  const file = oldFile(ROWS);
  const raw = new DatabaseSync(file);
  const before = firstRevisions(dbOf(raw));
  raw.close();
  assert.deepEqual(opened(file, firstRevisions), before);
});

test('a database already past the step opens unchanged', () => {
  // Bug: the step runs again on a database that holds it, or a second open rewrites rows.
  const file = oldFile(ROWS);
  opened(file, () => null);
  const raw = new DatabaseSync(file);
  const before = filledRows(dbOf(raw));
  raw.close();
  opened(file, () => null);
  const after = new DatabaseSync(file);
  try {
    assert.deepEqual(filledRows(dbOf(after)), before);
  } finally {
    after.close();
  }
});
