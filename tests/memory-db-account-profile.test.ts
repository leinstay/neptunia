// The write kind `account-profile` (src/memory/db/account-profile.ts): an account's profile written as its rows
// directly instead of through the user mapper of a unit write. The first test writes the same profiles through the unit
// write and through the write kind, over copies of one seeded database, and compares every table column by column.
// Then the store over a reopen and the generated profiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountCollection } from '../src/memory/db/storage-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Row } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { unitValue } from '../src/memory/db/readers/common.ts';
import { generated, plain } from './fixtures/memory-db/roundtrip.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';
import { NOW, ROOT } from './fixtures/memory-db/profile-writes.ts';

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

test('the store reads back a profile and its versions after the database is closed and opened again', async () => {
  const dataDir = tempDataDir('nep-profile-reopen-');
  const first = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  let written: unknown;
  let history: unknown;
  try {
    const store = createStore({ dataDir, memoryDb: first.memoryDb });
    store.touchUser('discord:555', 'Fifth', NOW);
    store.updateUser('discord:555', { character: 'Calm.' }, { by: 'analyzer' });
    store.updateUser('discord:555', { character: 'Calm and dry.' }, { by: 'analyzer' });
    store.flush();
    await store.flushSettled({});
    written = store.getUser('discord:555');
    history = store.listVersions(ROOT, 'users', 'discord:555');
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: second.memoryDb });
    assert.equal((store.getUser('discord:555') as { character?: unknown } | null)?.character, 'Calm and dry.');
    assert.deepEqual(store.getUser('discord:555'), written);
    assert.deepEqual(store.listVersions(ROOT, 'users', 'discord:555'), history);
    assert.equal((history as { character?: Array<{ text?: unknown }> }).character?.[0]?.text, 'Calm.');
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
