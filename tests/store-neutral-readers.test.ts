// The store's readers of a person's account, addressed by the account node. Over the real store and memory service.
// Contract, plan 2026-11-04-cli-and-memory task 5:
//   store.getUser(accountId): StoredRecord | null
//   store.touchUser(accountId, name, at?): StoredRecord
// Appendix entries: src/memory/store.ts (user collection), src/memory/db/map/index.ts (storage context).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { withIface } from '../src/memory/db/current-iface.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import type { MemoryDbService } from '../src/memory/db/service.ts';
import { listUnits } from '../src/memory/db/storage-units.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { addAccount, seedOpaqueWorld } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

type Store = ReturnType<typeof createStore>;
const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

function rig(): { store: Store; memoryDb: MemoryDbService; read: () => Db } {
  const dataDir = tempDir('nep-store-neutral-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  seedOpaqueWorld(dbOf(seed));
  addAccount(dbOf(seed), {
    id: 'account:free',
    iface: 'matrix',
    authority: 'matrix/global',
    native: 'n5',
    person: null,
  });
  seed.close();
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
    iface: () => 'somewhere-else',
  });
  memoryDb.tick();
  opened.push(memoryDb);
  const store = createStore({ dataDir, memoryDb });
  const read = (): Db => dbOf(wrongly<Parameters<typeof dbOf>[0]>(memoryDb.readHandle()));
  return { store, memoryDb, read };
}

const save = async (store: Store): Promise<void> => {
  store.flush();
  await store.flushSettled({});
};
const namesOf = (profile: unknown): unknown => Reflect.get(Object(profile), 'names');

test('a public profile is one collection of its account, whatever root the person spoke in', async () => {
  // Bug: `getUser(rootId, accountId)` keeps one profile per root, so a second root starts a stranger.
  const { store, read } = rig();
  store.touchUser('account:a21', 'Anna', 1000);
  await save(store);
  assert.deepEqual(namesOf(store.getUser('account:a21')), ['Anna']);
  const [unit] = listUnits(read(), { kind: 'user' });
  assert.deepEqual(unit?.key.subject, { type: 'account', id: 'account:a21' });
  assert.equal(unit?.key.scopePlaceId, undefined);
});

test('the ambient interface does not redirect a public profile read', async () => {
  // Bug: a read made inside another interface's event addresses that interface's account with the same native id.
  const { store } = rig();
  store.touchUser('account:a21', 'Anna', 1000);
  await save(store);
  assert.deepEqual(namesOf(withIface('discord', () => store.getUser('account:a21'))), ['Anna']);
});

test('an account nobody knows reads as nothing', () => {
  // Bug: a read of an unknown id creates the empty profile it was meant to find absent, and the gate lets a stranger in.
  const { store } = rig();
  assert.equal(store.getUser('account:never-seen'), null);
});

test('a profile read follows a bind and stops at the unbind, with no stale cached person', async () => {
  // Bug: the profile cached before the unbind keeps answering with the linked person's description.
  const { store, memoryDb } = rig();
  store.touchUser('account:a21', 'Anna', 1000);
  store.touchUser('account:free', 'Newcomer', 5000);
  await save(store);
  const firstSeen = (account: string): unknown => Reflect.get(Object(store.getUser(account)), 'firstSeen');
  const own = firstSeen('account:free');
  assert.notEqual(own, firstSeen('account:a21'));
  await memoryDb.personLink({ op: 'bind', accountId: 'account:free', target: { accountId: 'account:a21' } });
  assert.equal(firstSeen('account:free'), firstSeen('account:a21'));
  assert.deepEqual(namesOf(store.getUser('account:free')), ['Newcomer']);
  await memoryDb.personLink({ op: 'unbind', accountId: 'account:free' });
  assert.equal(firstSeen('account:free'), own);
});
