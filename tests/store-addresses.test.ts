// src/memory/store-addresses.ts over a real database: native ids become the stored rows when there are some, and a spelling
// the observation would give when there are none yet. The way back, from a row to its person or native id, reads only
// stored rows and what the store named.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import type { MemoryDbService } from '../src/memory/db/service.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { createAddressing } from '../src/memory/store-addresses.ts';
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
  // The expectation for `one:server:g2` was the native id parsed out of the place id. No id is worked out from the text
  // of another (plan 2026-11-08 ids-by-links, slice 5): a place no row holds and the store never named answers as given,
  // since a caller that holds a native root id passes it on, and a root the store named answers its native id.
  const store = storeOver();
  assert.equal(store.nativeRootOf('one:root:g1'), 'g1');
  assert.equal(store.nativeRootOf('one:server:g2'), 'one:server:g2');
  assert.equal(store.nativeRootOf('g3'), 'g3');
  assert.equal(store.nativeRootOf(store.placeOfRoot('g2', 'one')), 'g2');
});

test('an account no row links to a person has no person, and the persons spelled from it are gone', () => {
  // Bug: a turn names `person:<account>`, a person no row holds, and a DM context spelled from it opens nobody's DM.
  const store = storeOver();
  assert.equal(store.personOfAccount('one:u9'), null);
  assert.equal(store.personOfAccount(store.accountOf('u9', 'one')), null);
});

test('the native id of an account or a place comes from its row or from what the store named it from', () => {
  // Bug: a profile or a channel created before its row exists stores a native id parsed out of an id of another shape.
  const dataDir = tempDir('nep-addresses-rows-');
  const handle = openMemoryDb(path.join(dataDir, 'memory.db'));
  const db = dbOf(handle);
  addAuthority(db, 'one', 'one/global');
  addAccount(db, { id: 'account:u1', iface: 'one', authority: 'one/global', native: 'u1', person: 'person:opaque' });
  const seam = { db: () => db, run: <TResult>(fn: () => TResult): TResult => fn() };
  const addressing = createAddressing({ memoryDb: { readHandle: () => handle, namespace: () => 'one' }, seam });
  try {
    assert.equal(addressing.nativeOfRow('accounts', 'account:u1'), 'u1');
    assert.equal(addressing.nativeOfRow('accounts', 'one:u7'), null);
    assert.equal(addressing.nativeOfRow('accounts', addressing.methods().accountOf('u8', 'one')), 'u8');
    assert.equal(addressing.nativeOfRow('places', 'one:channel:c7'), null);
    assert.equal(addressing.nativeOfRow('places', addressing.methods().placeOfChat({ id: 'c8' }, 'one')), 'c8');
  } finally {
    handle.close();
  }
});

test('the chat of a place no row holds is the one the store named it from, else the id as given', () => {
  // Bug: a call to the interface takes a chat id parsed out of a place id that no row and no named chat backs.
  const store = storeOver();
  assert.equal(store.chatOfPlace('one:channel:c7'), 'one:channel:c7');
  assert.equal(store.chatOfPlace('c7'), 'c7');
  assert.equal(store.chatOfPlace(store.placeOfChat({ id: 'c8' }, 'one')), 'c8');
});
