// The store's unit cache (src/memory/unit-cache.ts) over a real memory service: its reconciliation with the database's
// other writers, the write that lands before a stale entry is read again, and a database without a writer.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import type { MemoryDbService } from '../src/memory/db/service.ts';
import { accountCollection } from '../src/memory/db/storage-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { readSeamOf } from '../src/memory/types.ts';
import type { MemoryDb } from '../src/memory/types.ts';
import { createUnitCache } from '../src/memory/unit-cache.ts';
import { ANNA, BORIS, seedOpaqueWorld } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const SILENT = { info() {}, debug() {}, warn() {}, error() {} };
const FILES = { read: (_file: string, fallback: unknown): unknown => fallback, write: (): void => {} };
const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

/** A memory service over the opaque people's world (Anna's accounts, Boris's), with its writer. */
function service(): MemoryDbService {
  const dataDir = tempDir('nep-unit-cache-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  seedOpaqueWorld(dbOf(seed));
  seed.close();
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: SILENT,
    worker: false,
    iface: () => 'somewhere-else',
  });
  memoryDb.tick();
  opened.push(memoryDb);
  return memoryDb;
}

/** A field of a cached value, read without trusting its shape. */
const fieldOf = (value: unknown, name: string): unknown => Reflect.get(Object(value), name);

function cacheOver(memoryDb: MemoryDb) {
  return createUnitCache({ memoryDb, seam: readSeamOf(memoryDb, SILENT, 'store'), files: FILES });
}

test('an attitude move of an opaque person drops the cached profile of the account', () => {
  // Bug: the move was matched by parsing `person:<iface>:<native>`, so an opaque person's move never reached the cache.
  const cache = cacheOver(service());
  const file = cache.address(accountCollection('user', 'account:a21'));
  cache.entry(file, () => ({ names: [] }));
  assert.equal(cache.attitudeMoved([{ personId: ANNA, applied: 2 }]), 1);
  assert.equal(cache.cached(file), undefined);
});

test('a move of a person the cache holds no profile of leaves every entry', () => {
  const cache = cacheOver(service());
  const file = cache.address(accountCollection('user', 'account:a21'));
  const item = cache.entry(file, () => ({ names: [] }));
  assert.equal(cache.attitudeMoved([{ personId: BORIS, applied: 1 }]), 0);
  assert.equal(cache.cached(file), item);
});

test('a moved profile with unflushed changes is read again only after its own write landed', async () => {
  // Bug: dropping a dirty profile at the move loses the change; reading it before its write lands brings back the old one.
  const cache = cacheOver(service());
  const file = cache.address(accountCollection('user', 'account:a21'));
  const item = cache.entry(file, () => ({ names: [] }));
  item.value = { names: ['Άννα'] };
  item.dirty = true;
  assert.equal(cache.attitudeMoved([{ personId: ANNA, applied: 2 }]), 1);
  cache.flushAll();
  assert.equal(
    cache.entry(file, () => ({})),
    item,
    'the write is under way'
  );
  await cache.settle();
  const again = cache.entry(file, () => ({}));
  assert.notEqual(again, item);
  assert.deepEqual(fieldOf(again.value, 'names'), ['Άννα']);
});

test('a database without a writer keeps a flushed unit dirty', () => {
  const memoryDb = service();
  const cache = cacheOver({ readHandle: () => memoryDb.readHandle() });
  const file = cache.address(accountCollection('user', 'account:a21'));
  const item = cache.entry(file, () => ({ names: [] }));
  item.dirty = true;
  cache.flushAll();
  assert.equal(cache.writable(), false);
  assert.equal(item.dirty, true);
});
