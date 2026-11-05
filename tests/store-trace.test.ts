// Recall diagnostics persist through the memory writer without recreating legacy directories.
import { placeOfCommunity } from '../src/memory/addresses.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../src/memory/store.ts';
import { unitLines } from '../src/memory/db/readers/common.ts';
import { placeCollection } from '../src/memory/db/storage-keys.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';

test('recall traces keep the newest capped records across database reopen without creating a guilds directory', async () => {
  // Bug: database-backed recall traces recreate legacy guild files or lose queued records before a flush.
  let mem = await openTestMemory();
  try {
    const store = createStore({ dataDir: mem.dataDir, memoryDb: mem.memoryDb });
    for (const run of [1, 2, 3]) store.appendRecallTrace(placeOfCommunity(store, 'g1'), { run }, { maxLines: 2 });
    await store.flushSettled({});
    const key = placeCollection('recall_trace', placeOfCommunity(store, 'g1'));
    const expected = [JSON.stringify({ run: 2 }), JSON.stringify({ run: 3 })];
    assert.deepEqual(unitLines(mem.memoryDb.readHandle()?.db, key), expected);
    await mem.close();
    mem = await openTestMemory({ dataDir: mem.dataDir });
    assert.deepEqual(unitLines(mem.memoryDb.readHandle()?.db, key), expected);
    assert.equal(fs.existsSync(path.join(mem.dataDir, 'guilds')), false);
  } finally {
    await mem.close();
    fs.rmSync(mem.dataDir, { recursive: true, force: true });
  }
});
