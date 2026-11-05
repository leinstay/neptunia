// What a profile write does to an account's link (src/memory/db/map/user.ts): the link is the database's, and a person
// the link made waits for its first profile. Each scenario runs over the real memory service on the calling thread.
import { accountOf } from '../src/memory/addresses.ts';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import type { MemoryDbService } from '../src/memory/db/service.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { tempDir } from './fixtures/tmp.ts';

const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

function rig(natives: ReadonlyArray<string>): {
  memoryDb: MemoryDbService;
  store: () => ReturnType<typeof createStore>;
} {
  const dataDir = tempDir('nep-account-link-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  for (const native of natives) {
    dbOf(seed)
      .prepare("INSERT INTO accounts (id, iface, native_id, native_key, kind) VALUES (?, 'discord', ?, ?, 'user')")
      .run(`discord:${native}`, native, native);
  }
  seed.close();
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
    iface: () => 'discord',
  });
  memoryDb.tick();
  opened.push(memoryDb);
  return { memoryDb, store: () => createStore({ dataDir, memoryDb }) };
}

const save = async (store: ReturnType<typeof createStore>): Promise<void> => {
  store.flush();
  await store.flushSettled({});
};

test('a message keeps the owner as the author of an account link', async () => {
  // Bug: the unit write resets `linked_by`, so the owner's own account loses its rights at his next line.
  const { memoryDb, store } = rig(['111']);
  const one = store();
  one.touchUser(accountOf(one, '111'), 'Alice', 1000);
  await save(one);
  await memoryDb.personLink({ op: 'bind', accountId: 'discord:111', target: { owner: true }, now: 2000 });
  one.touchUser(accountOf(one, '111'), 'Alice', 3000);
  await save(one);
  const row = memoryDb.readHandle()?.db as ReturnType<typeof dbOf>;
  assert.equal(row.prepare("SELECT linked_by FROM accounts WHERE id = 'discord:111'").get()?.linked_by, 'owner');
});

test('a person the link made takes the profile of its account when the account first speaks', async () => {
  // Bug: the link's bare `people` row counts as the database's own, so the profile never lands and the read throws.
  const { memoryDb, store } = rig(['111', '222']);
  await memoryDb.personLink({
    op: 'bind',
    accountId: 'discord:222',
    target: { accountId: 'discord:111' },
    now: 2000,
  });
  const one = store();
  one.touchUser(accountOf(one, '111'), 'Alice', 3000);
  one.updateUser(accountOf(one, '111'), { character: 'chatty' });
  await save(one);
  assert.deepEqual(
    [store().getUser('discord:111'), store().getUser('discord:222')].map(
      (profile) => (profile as { character: string } | null)?.character
    ),
    ['chatty', 'chatty']
  );
});
