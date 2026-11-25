import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { accountCollection } from '../../../../src/memory/db/unit-keys.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Row } from '../../../../src/memory/db/types.ts';
import { createStore } from '../../../../src/memory/store.ts';
import { unitValue } from '../../../../src/memory/db/readers/common.ts';
import { generated, plain } from '../../../fixtures/memory-db/roundtrip.ts';
import { openTestMemory, tempDataDir } from '../../../fixtures/memory-db/service.ts';
import { NOW } from '../../../fixtures/memory-db/profile-writes.ts';
import { accountOf } from '../../../../src/memory/addresses.ts';
import path from 'node:path';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { createMemoryDb } from '../../../../src/memory/db/service.ts';
import type { MemoryDbService } from '../../../../src/memory/db/service.ts';
import { tempDir } from '../../../fixtures/tmp.ts';

test('a profile write that names no account is refused with a code', async () => {
  const memory = await openTestMemory({ now: () => NOW, iface: () => 'discord' });
  try {
    await assert.rejects(memory.memoryDb.writeAccountProfile({ accountId: '', value: {} }), {
      code: 'ACCOUNT_PROFILE_ACCOUNT',
    });
  } finally {
    await memory.close();
  }
});

test('the store reads back a profile after the database is closed and opened again', async () => {
  const dataDir = tempDataDir('nep-profile-reopen-');
  const first = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  let written: unknown;
  try {
    const store = createStore({ dataDir, memoryDb: first.memoryDb });
    store.touchUser('discord:555', 'Fifth', NOW);
    store.recordAddressUses('discord:555', [{ name: 'Fifth', at: NOW }], { halfLifeDays: 30 });
    store.flush();
    await store.flushSettled({});
    written = store.getUser('discord:555');
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: second.memoryDb });
    assert.deepEqual((store.getUser('discord:555') as { names?: unknown } | null)?.names, ['Fifth']);
    assert.deepEqual(store.getUser('discord:555'), written);
  } finally {
    await second.close();
  }
});

test('the generated profiles with every key path of the live user files come back as they were written', async () => {
  // The fixtures share one native id, so each goes into a database of its own.
  for (const [index, given] of generated('user').entries()) {
    const memory = await openTestMemory({ now: () => NOW, iface: () => 'discord' });
    try {
      const value = plain(given) as Row;
      await memory.memoryDb.writeAccountProfile({ accountId: 'discord:900', value });
      const read = unitValue(dbOf(memory.memoryDb.readHandle()!), accountCollection('user', 'discord:900'));
      assert.ok(read.found, `generated user ${index}`);
      assert.deepEqual(plain(read.value), value, `generated user ${index}`);
    } finally {
      await memory.close();
    }
  }
});

test("a move of the store's own whose id begins with aff: comes back with its id, as no session row holds it", async () => {
  // Bug: a move was taken for the persona's session's by the `aff:` prefix of its id, so the row took that id, the item lost it,
  // and the store read back a move without the id it wrote.
  const memory = await openTestMemory({ now: () => NOW, iface: () => 'discord' });
  try {
    const value = {
      id: '901',
      names: ['Wren'],
      affinity: {
        score: 3,
        history: [{ itemId: 'aff:imported-7', ts: '2026-11-01T10:00:00.000Z', delta: 3, reason: 'brought the maps' }],
      },
    };
    await memory.memoryDb.writeAccountProfile({ accountId: 'discord:901', value });
    const read = unitValue(dbOf(memory.memoryDb.readHandle()!), accountCollection('user', 'discord:901'));
    const affinity = (read.found ? (read.value as Row) : {}).affinity as { history?: Array<Row> } | undefined;
    assert.deepEqual(
      affinity?.history?.map((move) => move.itemId),
      ['aff:imported-7']
    );
  } finally {
    await memory.close();
  }
});

const opened: Array<MemoryDbService> = [];

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

describe('store account link writes', () => {
  after(async () => {
    for (const service of opened) await service.close();
  });

  test('a message keeps the owner as the author of an account link', async () => {
    // Bug: the unit write resets `linked_by`, so the owner's own account loses its rights at their next line.
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
    await save(one);
    assert.deepEqual(
      [store().getUser('discord:111'), store().getUser('discord:222')].map(
        (profile) => (profile as { lastSeen: string } | null)?.lastSeen
      ),
      [new Date(3000).toISOString(), new Date(3000).toISOString()]
    );
  });
});
