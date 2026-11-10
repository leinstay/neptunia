// The store's way to the describer's cache (src/memory/store-media.ts): an entry written through the store is read back
// by a new store, a read in the tick of a write answers it, and the saved description of a row the cap retired is read
// and written back. Synthetic entries over a test memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';
import { NOW, ROOT } from './fixtures/memory-db/place-writes.ts';

const DESCRIBED = { text: 'a cat on a synthetic sofa', ts: NOW - 1000, describedAt: NOW - 1000, model: 'vision-model' };

const rowsHolding = (db: Db, key: string): Array<Row> =>
  db
    .prepare('SELECT * FROM media ORDER BY rowid')
    .all()
    .filter((row) =>
      Object.hasOwn((JSON.parse(typeof row.extra === 'string' ? row.extra : '{}') as { cache?: Row }).cache ?? {}, key)
    );

test('an entry written through the store is read back by a new store on the same database', async () => {
  const dataDir = tempDataDir('nep-media-cache-reopen-');
  const first = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: first.memoryDb });
    store.putMediaEntry(ROOT, 'att-1', DESCRIBED);
    store.putMediaEntry(ROOT, 'video:att-2', { miss: true, ts: NOW, reason: 'size' });
    await store.flushSettled({});
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: second.memoryDb });
    assert.deepEqual(store.mediaEntry(ROOT, 'att-1'), DESCRIBED);
    assert.deepEqual(store.mediaEntries(ROOT, ['att-1', 'video:att-2', 'att-9']), {
      'att-1': DESCRIBED,
      'video:att-2': { miss: true, ts: NOW, reason: 'size' },
    });
    assert.deepEqual(Object.keys(store.mediaEntries(ROOT)).sort(), ['att-1', 'video:att-2']);
  } finally {
    await second.close();
  }
});

test('a read in the tick of its write answers the written entry', async () => {
  const opened = await openTestMemory({ now: () => NOW, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir: opened.dataDir, memoryDb: opened.memoryDb });
    store.putMediaEntry(ROOT, 'att-1', DESCRIBED);
    assert.deepEqual(store.mediaEntry(ROOT, 'att-1'), DESCRIBED);
    store.dropMediaEntry(ROOT, 'att-1');
    assert.equal(store.mediaEntry(ROOT, 'att-1'), undefined);
    await store.flushSettled({});
    assert.equal(store.mediaEntry(ROOT, 'att-1'), undefined);
  } finally {
    await opened.close();
  }
});

test('the saved description of a trimmed row is answered, and its write brings the row back', async () => {
  const dataDir = tempDataDir('nep-media-cache-saved-');
  const first = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: first.memoryDb });
    store.putMediaEntry(ROOT, 'att-1', DESCRIBED);
    store.putMediaEntry(ROOT, 'att-2', { miss: true, ts: NOW });
    await store.flushSettled({});
  } finally {
    await first.close();
  }
  // The trim's retirement, as a cap past its rows leaves them.
  const handle = openMemoryDb(path.join(dataDir, 'memory.db'));
  try {
    dbOf(handle).prepare("UPDATE media SET retired_at = '2026-11-09T09:00:00.000Z' WHERE writer = 'media'").run();
  } finally {
    handle.close();
  }
  const second = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: second.memoryDb });
    assert.equal(store.mediaEntry(ROOT, 'att-1'), undefined);
    assert.deepEqual(store.getMediaDescription(ROOT, 'att-1'), DESCRIBED);
    assert.equal(store.getMediaDescription(ROOT, 'att-2'), null);
    store.putMediaEntry(ROOT, 'att-1', { ...DESCRIBED, usedAt: NOW });
    await store.flushSettled({});
    assert.deepEqual(store.mediaEntry(ROOT, 'att-1'), { ...DESCRIBED, usedAt: NOW });
    const [row] = rowsHolding(dbOf(second.memoryDb.readHandle()!), 'att-1');
    assert.equal(row?.retired_at, null);
  } finally {
    await second.close();
  }
});
