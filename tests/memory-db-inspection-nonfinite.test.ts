// A REAL that JSON has no number for: SQLite stores infinities, and `JSON.stringify(Infinity)` writes null, so an export
// would turn the stored value into a missing one. The value carries the word that names it instead, by the lead's ruling on
// plan 2026-11-04-cli-and-memory task 7. `sqlValueOf` gives the number back, so the word also filters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readRows } from '../src/memory/db/inspection.ts';
import { inspectionValueOf, isInspectionValue, sqlValueOf } from '../src/memory/db/inspection-values.ts';
import { createInspectionPort } from '../src/memory/db/inspection-snapshots.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { cell } from './fixtures/memory-db/browser-world.ts';
import { tempDir } from './fixtures/tmp.ts';

const BOUNDS = { pageRows: 10, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 8 };

test('an infinite real is the word that names it, and binds back to the number', () => {
  // Bug: `{ kind: 'real', value: Infinity }` serializes to `{ "value": null }`, and the export loses the value.
  for (const [number, word] of [
    [Infinity, 'Infinity'],
    [-Infinity, '-Infinity'],
  ] as const) {
    const value = inspectionValueOf('real', number);
    assert.deepEqual(value, { kind: 'real', text: word });
    assert.equal(isInspectionValue(value), true);
    assert.equal(sqlValueOf(value), number);
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
  }
});

test('a real that names no number is refused, and so is a word that names no infinity', () => {
  assert.throws(() => inspectionValueOf('real', Number.NaN), { code: 'INSPECTION_BAD_VALUE' });
  assert.equal(isInspectionValue({ kind: 'real', text: 'NaN' }), false);
  assert.equal(isInspectionValue({ kind: 'real', value: Infinity }), false);
});

test('a stored infinity reads as its word and a filter by it finds the row', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    db.exec('CREATE TABLE edge (id INTEGER PRIMARY KEY, v REAL); INSERT INTO edge VALUES (1, 9e999), (2, -9e999);');
    const page = readRows(db, { table: 'edge', filters: [], limit: 5, cursor: null });
    assert.deepEqual(
      page.items.map((row) => cell(row, 'v')),
      [
        { kind: 'real', text: 'Infinity' },
        { kind: 'real', text: '-Infinity' },
      ]
    );
    const found = readRows(db, {
      table: 'edge',
      filters: [{ column: 'v', value: { kind: 'real', text: '-Infinity' } }],
      limit: 5,
      cursor: null,
    });
    assert.deepEqual(
      found.items.map((row) => cell(row, 'id')),
      [{ kind: 'integer', value: '2' }]
    );
  } finally {
    handle.close();
  }
});

test('an export line keeps the infinity through JSON', () => {
  const file = join(tempDir('nep-nonfinite-'), 'memory.db');
  const writer = openMemoryDb(file);
  dbOf(writer).exec('CREATE TABLE edge (id INTEGER PRIMARY KEY, v REAL); INSERT INTO edge VALUES (1, 9e999);');
  const port = createInspectionPort({ dbPath: file, now: () => 0, engineRevision: 'rev' });
  try {
    const handle = port.openInspection({ ownerId: 'owner', bounds: BOUNDS });
    const record = Array.from(port.exportRecords(handle)).find((one) => one.kind === 'row' && one.table === 'edge');
    assert.ok(record?.kind === 'row');
    const line: unknown = JSON.parse(JSON.stringify(record));
    assert.deepEqual(cell((line as { row: { values: Array<{ column: string; value: unknown }> } }).row, 'v'), {
      kind: 'real',
      text: 'Infinity',
    });
  } finally {
    port.closeAll();
    writer.close();
  }
});
