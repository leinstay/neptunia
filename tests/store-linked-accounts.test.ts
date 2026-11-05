// A member's profile through the owner's links (src/memory/store.ts, src/memory/db/map/user.ts). What describes the person
// is one record behind every account the owner bound: character, details and the affinity score. What belongs to one
// account stays with it: its native id, the names it shows, how it is addressed. Each scenario runs over the real memory
// service on the calling thread, with the links written through its writer.
import { accountOf } from '../src/memory/addresses.ts';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { currentIface, withIface } from '../src/memory/db/current-iface.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import type { MemoryDbService } from '../src/memory/db/service.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { tempDir } from './fixtures/tmp.ts';

const IFACE = 'discord';
const AFFINITY = { maxDelta: 30, historySize: 10, now: 1000 };

type Store = ReturnType<typeof createStore>;
type Rig = {
  store: Store;
  /** A second store over the same database: what a restart reads. */
  fresh: () => Store;
  bind: (native: string, target: { iface: string; native: string }, iface?: string) => Promise<unknown>;
  unbind: (native: string) => Promise<unknown>;
};

const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

const save = async (store: Store): Promise<void> => {
  store.flush();
  await store.flushSettled({});
};

/** The person behind account `111`, with a character and a score of 12. The accounts in `known` exist with no profile. */
async function rigOf(known: ReadonlyArray<readonly [string, string]> = [[IFACE, '222']]): Promise<Rig> {
  const dataDir = tempDir('nep-linked-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  const insert = dbOf(seed).prepare(
    "INSERT INTO accounts (id, iface, native_id, native_key, kind) VALUES (?, ?, ?, ?, 'user')"
  );
  for (const [iface, native] of known) insert.run(`${iface}:${native}`, iface, native, native);
  seed.close();
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
    iface: () => currentIface() ?? IFACE,
  });
  memoryDb.tick();
  opened.push(memoryDb);
  const fresh = (): Store => createStore({ dataDir, memoryDb });
  const store = fresh();
  store.touchUser(accountOf(store, '111'), 'Alice', 1000);
  store.updateUser(accountOf(store, '111'), { character: 'chatty' });
  store.adjustAffinity(accountOf(store, '111'), 12, 'nice chat', AFFINITY);
  await save(store);
  return {
    store,
    fresh,
    bind: (native, target, iface = IFACE) =>
      memoryDb.personLink({
        op: 'bind',
        accountId: `${iface}:${native}`,
        target: { accountId: `${target.iface}:${target.native}` },
        now: 2000,
      }),
    unbind: (native) => memoryDb.personLink({ op: 'unbind', accountId: `${IFACE}:${native}`, now: 3000 }),
  };
}

const FIRST = { iface: IFACE, native: '111' };

type Profile = {
  id: string;
  character: string;
  names: Array<string>;
  lastSeen: string;
  addressedAs: Record<string, unknown>;
  affinity: { score: number };
};

/** The profile `store` answers for an account, which must have one. */
function profileOf(store: Store, native: string, guild = 'g1'): Profile {
  const found = store.getUser(accountOf(store, native));
  assert.ok(found, `account ${native} reads no profile`);
  return found as Profile;
}

test('a linked account with no profile unit reads the profile of its person', async () => {
  // Bug: the read asks for the account's own unit, so the owner's second account is a stranger to her.
  const { store, bind } = await rigOf();
  assert.equal(store.getUser(accountOf(store, '222')), null);
  await bind('222', FIRST);
  const profile = profileOf(store, '222');
  assert.equal(profile.character, 'chatty');
  assert.equal(profile.affinity.score, 12);
  assert.equal(profile.id, 'discord:222');
  assert.ok(!profile.names.includes('Alice'), 'the first account shows its own names');
});

test('an account on another interface with an equal native id reads the person only once linked', async () => {
  // Bug: `telegram:111` stays a stranger after the link, or reads `discord:111` before anyone linked them.
  const { store, fresh, bind } = await rigOf([['telegram', '111']]);
  assert.equal(
    withIface('telegram', () => store.getUser(accountOf(store, '111'))),
    null
  );
  await bind('111', FIRST, 'telegram');
  const profile = withIface('telegram', () => profileOf(fresh(), '111', 'g9'));
  assert.equal(profile.character, 'chatty');
  assert.equal(profile.affinity.score, 12);
});

test('a linked account with its own unit reads the person and keeps what is its own', async () => {
  // Bug: the unit's own empty description and zero score hide the person, or the first account's names and address leak.
  const { store, fresh, bind } = await rigOf();
  store.recordAddressUses(accountOf(store, '111'), [{ name: 'Al', at: 1000 }], { now: 1000 });
  store.touchUser(accountOf(store, '222'), 'Bob', 1000);
  store.recordAddressUses(accountOf(store, '222'), [{ name: 'Bobby', at: 1000 }], { now: 1000 });
  await save(store);
  await bind('222', FIRST);
  for (const reader of [store, fresh()]) {
    const second = profileOf(reader, '222');
    assert.equal(second.character, 'chatty');
    assert.equal(second.affinity.score, 12);
    assert.equal(second.id, 'discord:222');
    assert.deepEqual(second.names, ['Bob']);
    // Changed: `addressedAs` is a map by name (src/memory/addressed.ts); this test first read it as a list.
    assert.deepEqual(Object.keys(second.addressedAs), ['Bobby']);
    const first = profileOf(reader, '111');
    assert.deepEqual(first.names, ['Alice']);
    assert.deepEqual(Object.keys(first.addressedAs), ['Al']);
  }
});

test('a message from the linked account leaves the profile of the person whole', async () => {
  // Bug: the first line creates an empty unit whose write replaces the person's character and score.
  const { store, fresh, bind } = await rigOf();
  await bind('222', FIRST);
  store.touchUser(accountOf(store, '222'), 'Bob', 2500);
  await save(store);
  const reader = fresh();
  for (const native of ['111', '222']) {
    const profile = profileOf(reader, native);
    assert.equal(profile.character, 'chatty', native);
    assert.equal(profile.affinity.score, 12, native);
  }
  assert.deepEqual(profileOf(reader, '222').names, ['Bob']);
  assert.deepEqual(profileOf(reader, '111').names, ['Alice']);
});

test('an affinity change through the linked account moves the one score and both accounts read it', async () => {
  // Bug: the second account folds the delta into its own zero and overwrites the person's score, and the first
  // account's next read throws because its rows now belong to the other unit.
  const { store, fresh, bind } = await rigOf();
  await bind('222', FIRST);
  const moved = store.adjustAffinity(accountOf(store, '222'), 5, 'kind words', { ...AFFINITY, now: 2500 });
  assert.equal(moved?.score, 17);
  assert.equal(profileOf(store, '111').affinity.score, 17);
  await save(store);
  const reader = fresh();
  assert.equal(profileOf(reader, '111').affinity.score, 17);
  assert.equal(profileOf(reader, '222').affinity.score, 17);
});

test('the decay sweep moves the score of a linked person once', async () => {
  // Bug: the sweep walks both accounts, so a person with two accounts cools twice as fast.
  const { store, fresh, bind } = await rigOf();
  store.touchUser(accountOf(store, '222'), 'Bob', 1000);
  await save(store);
  await bind('222', FIRST);
  const day = 24 * 60 * 60 * 1000;
  const start = Date.parse(profileOf(store, '111').lastSeen);
  // The first sweep stamps the score, the second moves it by the days between.
  const sweep = async (one: Store): Promise<void> => {
    one.decayAffinities(start + day, { decayPerDay: 1 });
    await save(one);
    one.decayAffinities(start + 8 * day, { decayPerDay: 1 });
    await save(one);
  };
  await sweep(store);

  const control = await rigOf();
  await sweep(control.store);
  const expected = profileOf(control.fresh(), '111').affinity.score;
  assert.ok(expected < 12, 'the sweep decays at all');
  assert.equal(profileOf(fresh(), '111').affinity.score, expected);
  assert.equal(profileOf(fresh(), '222').affinity.score, expected);
});

test('an unlink drops the cached read of an account with no unit of its own', async () => {
  // Bug: the store keeps serving the person's profile from its cache to an account the owner just separated.
  const { store, bind, unbind } = await rigOf();
  await bind('222', FIRST);
  assert.equal(profileOf(store, '222').character, 'chatty');
  await unbind('222');
  assert.equal(store.getUser(accountOf(store, '222')), null);
  assert.equal(profileOf(store, '111').character, 'chatty');
});

test('after an unlink the account has its own score again and changes reach only it', async () => {
  // Bug: the separated account keeps writing into the person it left, or carries the shared score away.
  const { store, fresh, bind, unbind } = await rigOf();
  store.touchUser(accountOf(store, '222'), 'Bob', 1000);
  await save(store);
  await bind('222', FIRST);
  store.adjustAffinity(accountOf(store, '222'), 5, 'kind words', { ...AFFINITY, now: 2500 });
  await save(store);
  await unbind('222');
  assert.equal(profileOf(store, '222').affinity.score, 0);
  assert.equal(profileOf(store, '222').character, '');
  store.adjustAffinity(accountOf(store, '222'), 3, 'a fresh start', { ...AFFINITY, now: 3500 });
  await save(store);
  const reader = fresh();
  assert.equal(profileOf(reader, '222').affinity.score, 3);
  assert.equal(profileOf(reader, '111').affinity.score, 17);
});
