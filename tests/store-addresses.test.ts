// src/memory/store-addresses.ts over a real database: native ids become the stored rows when there are some, and a spelling
// the observation would give when there are none yet.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import type { MemoryDbService } from '../src/memory/db/service.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { addAccount, addAuthority } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

function storeOver(): ReturnType<typeof createStore> {
  const dataDir = tempDir('nep-addresses-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  const db = dbOf(seed);
  addAuthority(db, 'one', 'one/global');
  db.prepare(
    "INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, scope_kind) VALUES ('one:root:g1', 'one', 'server', 'g1', 'root:g1', 'one/global', 1, 'group')"
  ).run();
  addAccount(db, { id: 'account:u1', iface: 'one', authority: 'one/global', native: 'u1', person: 'person:opaque' });
  seed.close();
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
    iface: () => 'one',
  });
  memoryDb.tick();
  opened.push(memoryDb);
  return createStore({ dataDir, memoryDb });
}

test('a root and an account resolve to their stored rows, under any spelling of the row id', () => {
  // Bug: the core spells a new id for a server a shipped database holds, and she forgets the server after the conversion.
  const store = storeOver();
  assert.equal(store.placeOfRoot('g1', 'one'), 'one:root:g1');
  assert.equal(store.accountOf('u1', 'one'), 'account:u1');
  assert.equal(store.personOfAccount('account:u1'), 'person:opaque');
});

test('what no row holds yet gets the spelling the observation gives', () => {
  // Bug: a turn before the first observed line writes under an id no later row answers.
  const store = storeOver();
  assert.equal(store.placeOfRoot('g2', 'one'), 'one:server:g2');
  assert.equal(store.placeOfChat({ id: 'c9' }, 'one'), 'one:channel:c9');
  assert.equal(store.placeOfChat({ kind: 'dm', partnerId: 'u9' }, 'one'), 'one:dm:u9');
  assert.equal(store.accountOf('u9', 'one'), 'one:u9');
});

test('a read of the interface names a root natively and never a DM', () => {
  // Bug: a canonical id reaches the platform, or a DM place asks a root read that has no answer.
  const store = storeOver();
  assert.equal(store.nativeRootOf('one:root:g1'), 'g1');
  assert.equal(store.nativeRootOf('one:server:g2'), 'g2');
  assert.equal(store.nativeRootOf('g3'), 'g3');
});
