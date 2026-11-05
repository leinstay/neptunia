// A stored text that is not valid UTF-8 cannot be a JavaScript string without losing bytes, and an export must lose none. The
// cell keeps its readable `value` and names the exact stored bytes beside it. A valid text carries nothing extra, even one
// that holds the replacement character itself. Plan 2026-11-04-cli-and-memory task 7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readRow, readRows } from '../src/memory/db/inspection.ts';
import { createInspectionPort } from '../src/memory/db/inspection-snapshots.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { tempDir } from './fixtures/tmp.ts';

const SEED = `CREATE TABLE raw (id INTEGER PRIMARY KEY, body TEXT);
  INSERT INTO raw VALUES (1, CAST(x'61FF62' AS TEXT)), (2, 'ζ�ζ');`;
const EXACT = Buffer.from([0x61, 0xff, 0x62]).toString('base64');

function withDb(body: (db: Db) => void): void {
  const handle = openMemoryDb(':memory:');
  try {
    dbOf(handle).exec(SEED);
    body(dbOf(handle));
  } finally {
    handle.close();
  }
}

const bodyOf = (row: { values: ReadonlyArray<{ column: string; exactBytes?: string }> }): string | undefined =>
  row.values.find((one) => one.column === 'body')?.exactBytes;

test('a page names the exact bytes of a text that is not UTF-8', () => {
  // Bug: the bad byte reads as a replacement character, and the owner takes that for what is stored.
  withDb((db) => {
    const [bad] = readRows(db, { table: 'raw', filters: [], limit: 5, cursor: null }).items;
    assert.equal(bodyOf(bad), EXACT);
    assert.equal(bodyOf(readRow(db, { table: 'raw', locator: bad.locator })), EXACT);
  });
});

test('a valid text holding the replacement character carries nothing extra', () => {
  withDb((db) => {
    const good = readRows(db, { table: 'raw', filters: [], limit: 5, cursor: null }).items[1];
    assert.equal(bodyOf(good), undefined);
  });
});

test('an export line keeps the exact bytes', () => {
  // Bug: the export writes the replaced text and calls itself complete.
  const file = join(tempDir('nep-invalid-utf8-'), 'memory.db');
  const writer = openMemoryDb(file);
  dbOf(writer).exec(SEED);
  const port = createInspectionPort({ dbPath: file, now: () => 0, engineRevision: 'rev' });
  try {
    const handle = port.openInspection({
      ownerId: 'owner',
      bounds: { pageRows: 10, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300 },
    });
    const record = Array.from(port.exportRecords(handle)).find((one) => one.kind === 'row' && one.table === 'raw');
    assert.ok(record?.kind === 'row');
    assert.equal(bodyOf(record.row), EXACT);
  } finally {
    port.closeAll();
    writer.close();
  }
});
