// The caption vectors of the GIF library in the `vectors` table (src/memory/db/gif-vectors.ts): one row per item, a
// second write replaces the first, and recall's join to a source never finds one. Plan 2026-11-04-cli-and-memory, B7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readGifVectors, writeGifVector } from '../src/memory/db/gif-vectors.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { freshMemoryDb } from './fixtures/memory-db-copy.ts';

const AT = '2026-11-05T00:00:00.000Z';

test('a second vector of one item replaces the first, and it reads back close to what was written', () => {
  const handle = freshMemoryDb();
  const db = dbOf(handle);
  writeGifVector(db, { itemId: 'att-1', model: 'm/one', vector: [1, 0], iface: 'discord' }, AT);
  writeGifVector(db, { itemId: 'att-1', model: 'm/two', vector: [0.6, -0.8], iface: 'discord' }, AT);
  const read = readGifVectors(db);
  assert.equal(read.size, 1);
  const held = read.get('att-1');
  assert.equal(held?.model, 'm/two');
  assert.ok(held && Math.abs(held.vector[0] - 0.6) < 0.01 && Math.abs(held.vector[1] + 0.8) < 0.01);
  const linked = db
    .prepare("SELECT COUNT(*) AS n FROM vectors WHERE chunk_key LIKE 'gif:%' AND source_rowid IS NOT NULL")
    .get();
  assert.equal(linked?.n, 0, 'no source, so recall never reads it');
  handle.close();
});
