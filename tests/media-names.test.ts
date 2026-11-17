// The table `media_names` on the writer side (src/memory/db/media-names.ts): a rename keeps the name and stamps
// `renamed_at`, and a write with a malformed row is refused whole. What the store issues and reads back is proved in
// tests/store-media-names.test.ts. Synthetic ids over an in-memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyMediaNamesWrite, mediaNameRows } from '../src/memory/db/media-names.ts';
import { dbOf } from '../src/memory/db/types.ts';

const T0 = Date.parse('2026-11-17T10:00:00Z');
const T1 = Date.parse('2026-11-17T11:00:00Z');
const ROW = { name: 'e1', kind: 'emoji', iface: 'fake', nativeId: '900', platformName: 'kekw', animated: false };

test('stamps renamed_at and keeps the name when a known id comes back under another platform name', () => {
  const handle = openMemoryDb(':memory:');
  applyMediaNamesWrite(handle, { rows: [ROW], now: T0 });
  applyMediaNamesWrite(handle, { rows: [{ ...ROW, platformName: 'laugh' }], now: T1 });
  const db = dbOf(handle);
  const read = db.prepare('SELECT name, platform_name, renamed_at FROM media_names');
  const stored = read.all().map((row) => ({ ...row }));
  assert.deepEqual(stored, [{ name: 'e1', platform_name: 'laugh', renamed_at: new Date(T1).toISOString() }]);
});

test('leaves renamed_at empty when a known id comes back under the same platform name', () => {
  const handle = openMemoryDb(':memory:');
  applyMediaNamesWrite(handle, { rows: [ROW], now: T0 });
  applyMediaNamesWrite(handle, { rows: [{ ...ROW, animated: true }], now: T1 });
  const db = dbOf(handle);
  const read = db.prepare('SELECT renamed_at FROM media_names');
  const stored = read.all().map((row) => ({ ...row }));
  assert.deepEqual(stored, [{ renamed_at: null }]);
});

test('refuses a write with a row of an unknown kind and stores none of its rows', () => {
  const handle = openMemoryDb(':memory:');
  const rows = [ROW, { ...ROW, name: 'x1', kind: 'gif', nativeId: '901' }];
  assert.throws(() => applyMediaNamesWrite(handle, { rows, now: T0 }), { code: 'MEDIA_NAMES_ROWS' });
  assert.deepEqual(mediaNameRows(dbOf(handle)), []);
});
