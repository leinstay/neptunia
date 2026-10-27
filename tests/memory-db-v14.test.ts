// Schema v14, the SQL part: the errand units take the errand name wherever a unit path is stored. `guilds/<g>/tasks.json`
// and `tasks.jsonl` become `errands.json` and `errands.jsonl` in `files` (with kind `errands`), in the `owner_file` of
// `work`, `work_events` and `co_owners`, and in `operational` (kind, owner, owner_file and the `$has` list of the value).
// A unit lives directly under its guild, so a private layer's path is not touched. One `decisions` row says how many
// units moved, and only when something did. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MIGRATIONS } from '../src/memory/db/open.js';
import { exportOne } from '../src/memory/db/export.js';
import { tempDir } from './fixtures/tmp.js';
import {
  dbOf,
  dumpTables,
  openCurrent,
  openV13,
  putFile,
  putTaskUnits,
  type Db,
  type Record13,
  type Row,
} from './fixtures/memory-db/v13-errands.ts';

const errand = (id: string, extra: Record<string, unknown> = {}): Record13 => ({
  id,
  agent: 'scout',
  goal: 'look something up',
  state: 'done',
  createdAt: 1_792_000_000_000,
  endedAt: 1_792_000_100_000,
  readAt: 1_792_000_200_000,
  resolvedAt: null,
  ...extra,
});
const line = (id: string, at: number, state: string): Record13 & { at: number } => ({ ...errand(id), state, at });

const fileOf = () => path.join(tempDir('nep-v14-'), 'memory.db');
const paths = (db: Db): Array<string> =>
  db
    .prepare('SELECT path FROM files ORDER BY path')
    .all()
    .map((row) => String(row.path));
const column = (db: Db, sql: string): Array<unknown> =>
  db
    .prepare(sql)
    .all()
    .map((row) => Object.values(row)[0]);

/** Two guilds with errand units, the second sharing one of the first's rows, plus a private layer and other units. */
function seed(db: Db): void {
  putTaskUnits(db, 'g1', [errand('t0000000a'), errand('t0000000b')], [line('t0000000a', 1, 'done')], { note: 'kept' });
  putTaskUnits(db, 'g2', [errand('t0000000c')], [line('t0000000c', 2, 'done')]);
  db.prepare("INSERT INTO co_owners (tbl, key, owner_file) VALUES ('work', 't0000000a', 'guilds/g2/tasks.json')").run();
  // A private layer keeps its own path: three segments below the guild.
  putFile(db, 'guilds/g1/private/p1/tasks.json', 'tasks');
  putFile(db, 'guilds/g1/intentions.json', 'intentions');
}

test('renames the errand units in files, work, work_events, co_owners and operational', () => {
  const file = fileOf();
  const old = openV13(file);
  seed(old.db);
  old.close();
  const now = openCurrent(file);
  try {
    assert.deepEqual(paths(now.db), [
      'guilds/g1/errands.json',
      'guilds/g1/errands.jsonl',
      'guilds/g1/intentions.json',
      'guilds/g1/private/p1/tasks.json',
      'guilds/g2/errands.json',
      'guilds/g2/errands.jsonl',
    ]);
    assert.deepEqual(
      column(now.db, "SELECT kind FROM files WHERE path LIKE '%errands.json%' ORDER BY path"),
      ['errands', 'errands', 'errands', 'errands'],
      'the kind follows the path'
    );
    assert.equal(column(now.db, "SELECT kind FROM files WHERE path LIKE '%private%'")[0], 'tasks');
    assert.deepEqual(column(now.db, 'SELECT DISTINCT owner_file FROM work ORDER BY owner_file'), [
      'guilds/g1/errands.json',
      'guilds/g2/errands.json',
    ]);
    assert.deepEqual(column(now.db, 'SELECT DISTINCT owner_file FROM work_events ORDER BY owner_file'), [
      'guilds/g1/errands.jsonl',
      'guilds/g2/errands.jsonl',
    ]);
    assert.deepEqual(column(now.db, 'SELECT owner_file FROM co_owners'), ['guilds/g2/errands.json']);
    const operational = now.db.prepare('SELECT kind, owner, owner_file, value FROM operational ORDER BY owner').all();
    assert.deepEqual(
      operational.map((row) => [row.kind, row.owner, row.owner_file]),
      [
        ['errands', 'guilds/g1/errands.json', 'guilds/g1/errands.json'],
        ['errands', 'guilds/g2/errands.json', 'guilds/g2/errands.json'],
      ]
    );
    assert.deepEqual(JSON.parse(String(operational[0]?.value)), { note: 'kept', $has: ['errands'] });
  } finally {
    now.close();
  }
});

test('leaves a private layer unit, an intention unit and the records of the errands untouched', () => {
  const file = fileOf();
  const old = openV13(file);
  seed(old.db);
  old.db
    .prepare(
      "INSERT INTO work (id, kind, state, record, owner_file, position) VALUES ('t0000000p', 'errand', 'done', '{\"id\":\"t0000000p\"}', 'guilds/g1/private/p1/tasks.json', 0)"
    )
    .run();
  const before = dumpTables(old.db, ['schema_version']);
  old.close();
  const now = openCurrent(file);
  try {
    const after = dumpTables(now.db, ['schema_version']);
    const records = (rows: Array<Row> | undefined) => (rows ?? []).map((row) => [row.id, row.record]);
    assert.deepEqual(records(after.work), records(before.work), 'the record column of work');
    assert.deepEqual(records(after.work_events), records(before.work_events), 'the record column of work_events');
    assert.equal(
      column(now.db, "SELECT owner_file FROM work WHERE id = 't0000000a'")[0],
      'guilds/g1/errands.json',
      'the list unit moved while its records stayed'
    );
    assert.equal(
      column(now.db, "SELECT owner_file FROM work WHERE id = 't0000000p'")[0],
      'guilds/g1/private/p1/tasks.json'
    );
    assert.equal(column(now.db, "SELECT COUNT(*) FROM files WHERE path = 'guilds/g1/intentions.json'")[0], 1);
  } finally {
    now.close();
  }
});

test('leaves the value of an errand unit that has no `$has` list as it is', () => {
  const file = fileOf();
  const old = openV13(file);
  putFile(old.db, 'guilds/g1/tasks.json', 'tasks');
  old.db
    .prepare(
      "INSERT INTO operational (kind, owner, value, owner_file) VALUES ('tasks', 'guilds/g1/tasks.json', '{\"x\":1}', 'guilds/g1/tasks.json')"
    )
    .run();
  old.close();
  const now = openCurrent(file);
  try {
    const row = now.db.prepare("SELECT kind, owner, value FROM operational WHERE owner LIKE '%errands.json'").get();
    assert.deepEqual([row?.kind, row?.owner, row?.value], ['errands', 'guilds/g1/errands.json', '{"x":1}']);
  } finally {
    now.close();
  }
});

test('writes one decisions row counting the moved units, and none for a database with no errand unit', () => {
  const moved = fileOf();
  const old = openV13(moved);
  seed(old.db);
  old.close();
  const now = openCurrent(moved);
  const empty = fileOf();
  const bare = openV13(empty);
  putFile(bare.db, 'guilds/g1/intentions.json', 'intentions');
  bare.close();
  const none = openCurrent(empty);
  try {
    const rows = now.db
      .prepare(
        "SELECT id, action, by, json_extract(extra, '$.units') AS units FROM decisions WHERE action = 'migration:errand_units'"
      )
      .all();
    assert.deepEqual(
      rows.map((row) => [row.id, row.action, row.by, row.units]),
      [['migration:v14:errand_units', 'migration:errand_units', 'migration', 4]]
    );
    assert.deepEqual(
      column(none.db, "SELECT id FROM decisions WHERE action = 'migration:errand_units'"),
      [],
      'nothing moved, nothing said'
    );
    assert.deepEqual(paths(none.db), ['guilds/g1/intentions.json']);
  } finally {
    now.close();
    none.close();
  }
});

test('changes nothing when the database is opened a second time', () => {
  const file = fileOf();
  const old = openV13(file);
  seed(old.db);
  old.close();
  const first = openCurrent(file);
  const settled = dumpTables(first.db);
  first.close();
  const second = openCurrent(file);
  try {
    assert.deepEqual(dumpTables(second.db), settled);
    assert.equal(column(second.db, 'SELECT MAX(version) FROM schema_version')[0], 14);
    assert.equal(MIGRATIONS.length, 14);
  } finally {
    second.close();
  }
});

test('the export of a moved unit is errands.json holding { errands }, in the order of the list', () => {
  const file = fileOf();
  const old = openV13(file);
  seed(old.db);
  old.close();
  const now = openCurrent(file);
  try {
    const found = exportOne(dbOf(now), 'guilds/g1/errands.json');
    assert.equal(found.found, true);
    const value = found.found ? (found.value as { errands: Array<{ id: string }>; note: string }) : null;
    assert.deepEqual(
      value?.errands.map((item) => item.id),
      ['t0000000a', 't0000000b']
    );
    assert.equal(value?.note, 'kept');
    assert.equal(Object.hasOwn(value ?? {}, 'tasks'), false);
    assert.equal(exportOne(dbOf(now), 'guilds/g1/tasks.json').found, false, 'no unit under the old name');
  } finally {
    now.close();
  }
});
