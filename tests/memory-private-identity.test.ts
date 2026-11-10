// Private lookup by a concrete account, independent of any root and of the ambient interface. Over the real store and
// the real memory service, so a read goes through the same writer and cache a turn does.
// Contract, plan 2026-11-04-cli-and-memory task 5:
//   store.getPrivate(accountId: string): object | null
//   store.applyPrivateOps(accountId: string, ops: PrivateOpsOptions, opts?): object | null
// Appendix entries: src/memory/store.ts (private collection), src/memory/db/current-iface.ts, src/memory/db/unit-keys.ts,
// src/memory/root.ts, src/pipeline/private-gate.ts.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { currentIface, withIface } from '../src/memory/db/current-iface.ts';
import { OBSERVATION_VERSION } from '../src/memory/db/observe.ts';
import type { Envelope } from '../src/memory/db/observe.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import type { MemoryDbService } from '../src/memory/db/service.ts';
import { unitSubjects } from '../src/memory/db/readers/common.ts';
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
  const dataDir = tempDir('nep-private-identity-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  seedOpaqueWorld(dbOf(seed));
  addAccount(dbOf(seed), {
    id: 'account:other-authority',
    iface: 'discord',
    authority: 'discord/other',
    native: 'n1',
    person: 'person:elsewhere',
  });
  addAccount(dbOf(seed), {
    id: 'account:next-generation',
    iface: 'discord',
    authority: 'discord/global',
    native: 'n1',
    generation: 2,
    person: 'person:later',
  });
  seed.close();
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
    // The home interface a read outside any event falls back to: never the one a test addresses.
    iface: () => currentIface() ?? 'somewhere-else',
  });
  memoryDb.tick();
  opened.push(memoryDb);
  const store = createStore({ dataDir, memoryDb });
  const read = (): Db => dbOf(wrongly<Parameters<typeof dbOf>[0]>(memoryDb.readHandle()));
  return { store, memoryDb, read };
}

type Details = { details: Array<{ text: string }> };
const detailsOf = (value: object | null): Array<string> =>
  (value as Details | null)?.details.map((one) => one.text) ?? [];

async function note(store: Store, account: string, text: string): Promise<void> {
  store.applyPrivateOps(account, { details: { add: [text] } });
  store.flush();
  await store.flushSettled({});
}

const groupLine = (key: string): Envelope => ({
  v: OBSERVATION_VERSION,
  iface: 'discord',
  authority: 'discord/global',
  native: { kind: 'message', key, revision: 0 },
  place: {
    authority: 'discord/global',
    key: 'channel:unrelated',
    kind: 'channel',
    chat: 'group',
    parent: 'server:unrelated',
  },
  author: { kind: 'account', key: 'n1', authority: 'discord/global' },
  occurredAt: '2026-11-02T00:00:00.000Z',
  observedAt: '2026-11-02T00:00:00.000Z',
  text: 'a line in a group nobody asked about',
});

test('an account resolves to one private collection before and after an unrelated group is observed', async () => {
  // Bug: the first root the person is seen in becomes the scope, so the DM moves when a group appears.
  const { store, memoryDb, read } = rig();
  await note(store, 'account:a11', 'keeps a private note');
  const before = unitSubjects(read(), 'private');
  await memoryDb.observe(groupLine('m1'));
  assert.equal(read().prepare("SELECT 1 AS ok FROM places WHERE native_key = 'channel:unrelated'").get()?.ok, 1);
  assert.deepEqual(detailsOf(store.getPrivate('account:a11')), ['keeps a private note']);
  await note(store, 'account:a11', 'and a second one');
  assert.deepEqual(unitSubjects(read(), 'private'), before);
});

test('a private collection names its account and no root', async () => {
  // Bug: `rootKey` puts `<iface>:root:<id>` into the key, so two roots split one account's memory.
  const { store, read } = rig();
  await note(store, 'account:a21', 'keeps a private note');
  assert.deepEqual(unitSubjects(read(), 'private'), ['account:a21']);
});

test('equal native ids in two authorities read two private collections', async () => {
  // Bug: `accountId(namespace, native)` holds no authority, so the second authority reads the first one's secrets.
  const { store } = rig();
  await note(store, 'account:a11', 'of the first authority');
  assert.equal(store.getPrivate('account:other-authority'), null);
  await note(store, 'account:other-authority', 'of the second authority');
  assert.deepEqual(detailsOf(store.getPrivate('account:a11')), ['of the first authority']);
  assert.deepEqual(detailsOf(store.getPrivate('account:other-authority')), ['of the second authority']);
});

test('a later generation of a reused native id reads nothing of the earlier one', async () => {
  // Bug: the new owner of a recycled id inherits a stranger's private memory.
  const { store } = rig();
  await note(store, 'account:a11', 'of the first generation');
  assert.equal(store.getPrivate('account:next-generation'), null);
});

test('the ambient interface does not redirect a read or a write that names its account', async () => {
  // Bug: `namespace()` comes from AsyncLocalStorage, so a read made inside another event addresses another collection.
  const { store } = rig();
  await note(store, 'account:a21', 'said on the second interface');
  for (const iface of ['telegram', 'discord', 'other']) {
    assert.deepEqual(detailsOf(withIface(iface, () => store.getPrivate('account:a21'))), [
      'said on the second interface',
    ]);
  }
  withIface('discord', () => store.applyPrivateOps('account:a21', { details: { add: ['added from elsewhere'] } }));
  assert.deepEqual(detailsOf(store.getPrivate('account:a21')), [
    'said on the second interface',
    'added from elsewhere',
  ]);
});

test('a write begun inside an event lands in its account after the event context ended', async () => {
  // Bug: the flush runs outside `withIface`, so a background retry writes to the home interface's collection.
  const { store, read } = rig();
  withIface('telegram', () => store.applyPrivateOps('account:a21', { details: { add: ['begun in an event'] } }));
  store.flush();
  await store.flushSettled({});
  assert.deepEqual(unitSubjects(read(), 'private'), ['account:a21']);
});

test('an account nobody stored has no private memory and gets no collection from being asked', () => {
  // Bug: a read of an unknown id fabricates an empty unit, and the owner browser lists a person who never existed.
  const { store, read } = rig();
  assert.equal(store.getPrivate('account:never-seen'), null);
  assert.deepEqual(unitSubjects(read(), 'private'), []);
});
