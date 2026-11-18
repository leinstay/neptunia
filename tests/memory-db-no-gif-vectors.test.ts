// Schema step 66 (src/memory/db/schema.ts) on a database written at version 65: the description vectors of the GIF
// library leave, the `vectors` rows of kind `gif` under `gif:<item id>`, and every other vector stays. Spec 2026-11-18,
// the library without the keeper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');

const ROWS = `INSERT INTO vectors (item_id, chunk_key, kind, model, dims, occurred_at) VALUES
  ('m1#e0', 'gif:m1#e0', 'gif', 'm/one', 2, '2026-11-05T00:00:00.000Z'),
  ('a2', 'gif:a2', 'gif', 'm/one', 2, '2026-11-06T00:00:00.000Z'),
  ('media:gif:k1', 'media:media:gif:k1', 'media', 'm/one', 2, '2026-11-07T00:00:00.000Z'),
  ('line-1', 'record:line-1:1', 'record', 'm/one', 2, '2026-11-08T00:00:00.000Z');`;

/** A data folder whose database holds the four vectors, at `version`. */
async function dataDirAt(version: number): Promise<string> {
  const dataDir = tempDataDir();
  const first = await openTestMemory({ dataDir, now: () => NOW });
  await first.close();
  const raw = new DatabaseSync(path.join(dataDir, 'memory.db'));
  try {
    raw.exec(`${ROWS} DELETE FROM schema_version WHERE version > ${version};`);
  } finally {
    raw.close();
  }
  return dataDir;
}

async function chunkKeysAfterOpen(dataDir: string): Promise<Array<unknown>> {
  const second = await openTestMemory({ dataDir, now: () => NOW });
  try {
    const db = second.memoryDb.database();
    if (!db) throw new Error('database unavailable');
    return db
      .prepare('SELECT chunk_key FROM vectors ORDER BY chunk_key')
      .all()
      .map((row) => row.chunk_key);
  } finally {
    await second.close();
  }
}

test('step 66 deletes the GIF description vectors and keeps the media and record vectors', async () => {
  assert.deepEqual(await chunkKeysAfterOpen(await dataDirAt(65)), ['media:media:gif:k1', 'record:line-1:1']);
});

test('a database already at version 66 keeps every vector it holds', async () => {
  assert.deepEqual(await chunkKeysAfterOpen(await dataDirAt(66)), [
    'gif:a2',
    'gif:m1#e0',
    'media:media:gif:k1',
    'record:line-1:1',
  ]);
});
